#!/usr/bin/env node
// session-fleet for Codex: a Codex hook (~/.codex/hooks.json) that writes what each Codex thread is doing into the
// same registry the Claude Code plugin uses, sessions/<machine>/<thread id>.json, so LumenLite shows Codex threads of
// every machine, and knows when one waits for the person.
//
// Events: UserPromptSubmit -> working; PermissionRequest -> waiting; PreToolUse/PostToolUse after a wait -> working;
// Stop -> waiting when the last reply says it needs the person ("Needs you: ..." other than nothing, or a closing
// question), else idle; Interrupt/SessionEnd -> idle.
//
// The hook only writes the file and returns; a detached copy of this script pushes it a moment later
// (`--push <file>`), one machine's syncs serialized by the lock the plugin uses (.git/session-fleet.lock).

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const SELF = fileURLToPath(import.meta.url)
const LOCK_STALE_MS = 2 * 60_000

export function readConfig() {
  let options = {}
  try {
    options = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'session-fleet.json'), 'utf8'))
  } catch {}
  const host = (process.env.COMPUTERNAME || os.hostname() || '').trim()
  return {
    machine: (options.machineName || host.split('.')[0] || 'unknown').trim(),
    host,
    registry: options.registryDir || path.join(HOME, '.claude', 'session-fleet-registry'),
  }
}

/**
 * Whether a reply leaves the next move to the person: a "Needs you:" line naming something (not "nothing"), or, with
 * no such line, a last line that asks a question.
 */
export function needsPerson(text) {
  if (!text) return false
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[*_\s]*needs you[*_\s]*:[*_\s]*(.*)$/i.exec(lines[i])
    if (m) {
      const what = m[1].replace(/[*_`]/g, '').trim().toLowerCase()
      return !(what === '' || /^(nothing|none|no|n\/a|-|không|không có|không cần)\b/.test(what))
    }
  }
  const last = lines[lines.length - 1] ?? ''
  return /[?？]\s*[*_)]*$/.test(last)
}

/** The state an event leaves the thread in; undefined to leave it as it is. */
export function nextState(event, input, current) {
  switch (event) {
    case 'UserPromptSubmit':
      return 'working'
    case 'PermissionRequest':
      return 'waiting'
    case 'PreToolUse':
    case 'PostToolUse':
      return current === 'waiting' ? 'working' : current === undefined || current === 'idle' ? 'working' : undefined
    case 'Stop':
      return needsPerson(input.last_assistant_message) ? 'waiting' : 'idle'
    case 'Interrupt':
    case 'SessionEnd':
      return 'idle'
    default:
      return undefined
  }
}

/** Scripted runs (`codex exec`) and the subagents Codex starts itself are not threads a person opens. */
function isPersonsThread(input) {
  if (input.agent_id) return false
  try {
    const fd = fs.openSync(input.transcript_path, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = buf.subarray(0, n).toString('utf8')
    if (/"originator":"codex_exec"/.test(head) || /"source":"exec"/.test(head)) return false
    if (/"source":\{[^}]*"(subagent|internal)"/.test(head)) return false
  } catch {}
  return true
}

/** The thread's name in the Codex app, from ~/.codex/session_index.jsonl. */
function threadTitle(id) {
  try {
    const lines = fs.readFileSync(path.join(HOME, '.codex', 'session_index.jsonl'), 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(id)) continue
      const rec = JSON.parse(lines[i])
      if (rec.id === id && rec.thread_name) return String(rec.thread_name).slice(0, 60)
    }
  } catch {}
  return ''
}

function hook(input) {
  const event = input.hook_event_name
  const id = input.session_id
  if (!event || !id || !isPersonsThread(input)) return
  const cfg = readConfig()
  if (!fs.existsSync(cfg.registry)) return
  const file = path.join(cfg.registry, 'sessions', cfg.machine, `${id}.json`)
  let rec
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    const now = new Date().toISOString()
    rec = { machine: cfg.machine, sessionId: id, cwd: input.cwd || '', feature: '', status: 'active', startedAt: now, updatedAt: now, provider: 'codex' }
  }
  const state = nextState(event, input, rec.live?.state)
  const title = threadTitle(id) || (event === 'UserPromptSubmit' && !rec.feature ? String(input.prompt || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ') : '')
  const changed = (state && state !== rec.live?.state) || (title && title !== rec.feature) || (input.cwd && input.cwd !== rec.cwd)
  if (!changed) return
  const now = new Date().toISOString()
  if (state) rec.live = { state, at: now }
  if (title) rec.feature = title.slice(0, 60)
  if (input.cwd) rec.cwd = input.cwd
  rec.provider = 'codex'
  rec.host = cfg.host
  rec.updatedAt = now
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n')
  // A wait and a turn's end go out at once; a working state a little later, so a burst makes one commit.
  const delay = state === 'working' ? 15_000 : 1_000
  const ticket = path.join(cfg.registry, '.git', `codex-push-${id}`)
  const stamp = String(Date.now())
  try {
    fs.writeFileSync(ticket, stamp)
  } catch {}
  const child = spawn(process.execPath, [SELF, '--push', file, ticket, stamp, String(delay)], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function git(registry, args) {
  try {
    execFileSync('git', args, { cwd: registry, stdio: 'ignore', windowsHide: true, timeout: 90_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return true
  } catch {
    return false
  }
}

async function withLock(registry, work) {
  const file = path.join(registry, '.git', 'session-fleet.lock')
  const me = `codex:${process.pid}:${Math.random().toString(36).slice(2)}`
  const holder = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  for (let tries = 0; tries < 30; tries++) {
    const other = holder()
    if (other.owner && other.owner !== me && Date.now() - (other.at ?? 0) < LOCK_STALE_MS) {
      await sleep(1000)
      continue
    }
    fs.writeFileSync(file, JSON.stringify({ owner: me, at: Date.now() }))
    await sleep(150)
    if (holder().owner !== me) continue
    try {
      return work()
    } finally {
      fs.writeFileSync(file, '{}')
    }
  }
  return false
}

async function push(file, ticket, stamp, delay) {
  await sleep(Number(delay) || 1000)
  // A newer change took over this push.
  try {
    if (fs.readFileSync(ticket, 'utf8') !== stamp) return
  } catch {}
  const registry = path.resolve(path.dirname(file), '..', '..')
  const rel = path.relative(registry, file).split(path.sep).join('/')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  await withLock(registry, () => {
    if (fs.existsSync(path.join(registry, '.git', 'rebase-merge')) || fs.existsSync(path.join(registry, '.git', 'rebase-apply')))
      git(registry, ['rebase', '--abort'])
    git(registry, ['add', '--', rel])
    git(registry, ['commit', '-q', '-m', `${rec.machine}: codex ${rec.live?.state ?? ''} ${rec.feature || rec.sessionId}`, '--', rel])
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!git(registry, ['pull', '-q', '--rebase', '--autostash'])) {
        git(registry, ['rebase', '--abort'])
        continue
      }
      if (git(registry, ['push', '-q'])) return true
    }
    return false
  })
  try {
    if (fs.readFileSync(ticket, 'utf8') === stamp) fs.unlinkSync(ticket)
  } catch {}
}

async function main() {
  if (process.argv[2] === '--push') return push(process.argv[3], process.argv[4], process.argv[5], process.argv[6])
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    hook(JSON.parse(raw))
  } catch {}
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  // A hook must never stop Codex: every failure is swallowed, and the hook prints nothing.
  main().catch(() => {}).finally(() => {
    if (process.argv[2] !== '--push') process.exit(0)
  })
}
