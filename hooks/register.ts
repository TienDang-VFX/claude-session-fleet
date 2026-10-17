import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  type FleetRecord,
  FIRST_PROMPT_MARK,
  featureFromText,
  featureFromTitle,
  isDoneTitle,
  formatTable,
  isInside,
  joinPath,
  titleOf,
} from './fleet'

type $ = EngineInterface

/** Tools that change files or run commands: denied outside the project folder. */
const GUARDED = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'PowerShell'])

type Config = { machine: string; root: string; registry: string; enforce: boolean }

/** Module state; recomputed by session.start on every load or reload. */
let config: Config | undefined
let isOutside = false
let syncChain: Promise<unknown> = Promise.resolve()

const str = (options: PluginOptions, key: string) => {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * This machine's settings: ~/.claude/session-fleet.json (written by install.ps1 / install.sh)
 * wins over the plugin's userConfig options.
 */
async function readConfig($: $, pluginOptions: PluginOptions): Promise<Config> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  let options: PluginOptions = pluginOptions
  const file = joinPath(home, '.claude', 'session-fleet.json')
  if (await $.fs.exists(file)) {
    try {
      options = { ...pluginOptions, ...(JSON.parse(await $.fs.read(file)) as PluginOptions) }
    } catch {
      $.ui.toast(`session-fleet: ${file} is not valid JSON; using the plugin options.`)
    }
  }
  let machine = str(options, 'machineName')
  if (!machine) machine = ((await $.env.get('COMPUTERNAME')) ?? '').trim()
  if (!machine) {
    const ran = await $.process.run(['hostname']).catch(() => undefined)
    machine = ran?.stdout.trim().split('.')[0] ?? ''
  }
  let registry = str(options, 'registryDir')
  if (!registry) registry = joinPath(home, '.claude', 'session-fleet-registry')
  return {
    machine: machine || 'unknown',
    root: str(options, 'projectRoot'),
    registry,
    enforce: options.enforceFolder !== false,
  }
}

const recordPath = (cfg: Config, sessionId: string) =>
  joinPath(cfg.registry, 'sessions', cfg.machine, `${sessionId}.json`)

async function loadRecord($: $, cfg: Config, sessionId: string): Promise<FleetRecord | undefined> {
  const stored = (await $.store.get(`s:${sessionId}`)) as FleetRecord | undefined
  if (stored) return stored
  const path = recordPath(cfg, sessionId)
  if (!(await $.fs.exists(path))) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as FleetRecord
  } catch {
    return undefined
  }
}

async function git($: $, cfg: Config, args: string[]) {
  return $.process.run(['git', ...args], { cwd: cfg.registry, timeoutMs: 90_000 })
}

const isGitRegistry = ($: $, cfg: Config) => $.fs.exists(joinPath(cfg.registry, '.git'))

/** Commits this session's record and pushes it; serialized so syncs never overlap. */
function pushRecord($: $, cfg: Config, rec: FleetRecord) {
  syncChain = syncChain
    .then(async () => {
      if (!(await isGitRegistry($, cfg))) return
      const rel = `sessions/${cfg.machine}/${rec.sessionId}.json`
      await git($, cfg, ['add', '--', rel])
      await git($, cfg, ['commit', '-q', '-m', `${rec.machine}: ${rec.status} ${rec.feature || rec.sessionId}`, '--', rel])
      await git($, cfg, ['pull', '-q', '--rebase', '--autostash'])
      const pushed = await git($, cfg, ['push', '-q'])
      if (pushed.exitCode !== 0) $.ui.toast(`session-fleet: push failed: ${pushed.stderr.trim().slice(0, 120)}`)
    })
    .catch(err => $.ui.toast(`session-fleet: sync failed: ${String(err).slice(0, 120)}`))
  return syncChain
}

async function saveRecord($: $, cfg: Config, rec: FleetRecord, { sync = true } = {}) {
  rec.updatedAt = new Date(await $.clock.now()).toISOString()
  await $.store.set(`s:${rec.sessionId}`, rec)
  await $.fs.write(recordPath(cfg, rec.sessionId), JSON.stringify(rec, null, 2) + '\n')
  showStatus($, rec)
  if (sync) $.clock.after(0, () => void pushRecord($, cfg, rec))
}

function showStatus($: $, rec: FleetRecord) {
  const where = isOutside ? ' · OUTSIDE PROJECT FOLDER' : ''
  $.ui.status(`${rec.machine} · ${rec.feature || 'no feature yet'} · ${rec.status}${where}`)
}

async function remoteControlNote($: $): Promise<string> {
  const settings = (await $.settings.read().catch(() => ({}))) as Record<string, unknown>
  const cli = settings.remoteControlAtStartup === true ? 'on' : 'off'
  return (
    'Remote Control must be on for this session. Desktop app: if mcp__ccd_session_mgmt__get_session("self") reports remoteControlState "off", ' +
    `call mcp__ccd_session_mgmt__set_remote_control to turn it on. Terminal CLI: remoteControlAtStartup is ${cli}` +
    (cli === 'off' ? ' (tell the user once if this is a terminal session).' : '.')
  )
}

/** The desktop app ignores a hook's sessionTitle, so the model renames the session through the app's own tool. */
const renameAsk = (title: string) =>
  `Session title: if mcp__ccd_session_mgmt__set_session_title is available, call it now with session_id "self" and title "${title}" (skip it when the title is already exactly that). Do not mention this to the user.`

/** Reads the config and the folder verdict once per load, whichever hook runs first. */
let ready: { key: string; config: Promise<Config> } | undefined

function ensure($: $, options: PluginOptions, cwd: string, sessionId: string): Promise<Config> {
  const key = `${sessionId}|${cwd}`
  if (ready?.key !== key) ready = { key, config: setup($, options, cwd, sessionId) }
  return ready.config
}

async function setup($: $, options: PluginOptions, cwd: string, sessionId: string): Promise<Config> {
  const cfg = await readConfig($, options)
  const allowedHere = (await $.store.get(`here:${sessionId}`)) === true
  isOutside = cfg.enforce && cfg.root !== '' && !isInside(cwd, cfg.root) && !allowedHere
  config = cfg
  if (isOutside) $.ui.toast(`session-fleet: this session runs in ${cwd}, not ${cfg.root}. Edits are blocked.`)
  return cfg
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const cfg = await ensure($, options, e.cwd, id)

    await $.command.register({ name: 'feature', description: 'Name the feature this session works on (sets the title)', argumentHint: '<feature name>' })
    await $.command.register({ name: 'done', description: 'Mark this session done, sync it, and file it under Done', argumentHint: '[note]' })
    await $.command.register({ name: 'sessions', description: 'List sessions on every machine from the shared registry', argumentHint: '[all]' })
    await $.command.register({ name: 'fleet', description: 'Show this machine, its project folder, Remote Control and registry' })
    await $.command.register({ name: 'fleet-here', description: 'Allow edits in this session although it runs outside the project folder' })
    await registerTools($)

    const rec = await loadRecord($, cfg, id)
    if (rec) showStatus($, rec)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id) return result
    const cfg = await ensure($, options, e.cwd, e.session_id)
    const now = new Date(await $.clock.now()).toISOString()
    const rec: FleetRecord = (await loadRecord($, cfg, e.session_id)) ?? {
      machine: cfg.machine,
      sessionId: e.session_id,
      cwd: e.cwd,
      feature: '',
      status: 'active',
      startedAt: now,
      updatedAt: now,
    }
    rec.cwd = e.cwd
    if (!rec.feature) {
      rec.feature = featureFromTitle(e.session_title, cfg.machine)
      if (rec.feature && isDoneTitle(e.session_title)) rec.status = 'done'
    }
    await saveRecord($, cfg, rec)

    const lines = [
      `session-fleet: this session runs on machine "${cfg.machine}"; its title is "${titleOf(rec)}".`,
      cfg.root
        ? isOutside
          ? `FOLDER: the session runs in ${e.cwd}, but this machine's project folder is ${cfg.root}. Edit/Write/shell tools are blocked. Tell the user to start the session in ${cfg.root}, or run /fleet-here to allow it.`
          : `Folder: ${e.cwd} is inside this machine's project folder ${cfg.root}.`
        : 'Folder: no project folder is configured for this machine.',
      await remoteControlNote($),
      ...((await $.store.get(APP_SYNC_KEY)) === 'works'
        ? []
        : [
            `If mcp__ccd_sidebar tools are available, file this session under the sidebar group "${rec.status === 'done' ? 'Done' : cfg.machine}" (create it if missing) once, without asking.`,
            renameAsk(titleOf(rec)),
          ]),
      'When the user says the work is finished (done / xong / hoàn thành), call mcp__session-fleet__fleet_done. ' +
        'When the user names the feature, call mcp__session-fleet__fleet_feature. For sessions on other machines, call mcp__session-fleet__fleet_sessions.',
    ]
    return {
      ...result,
      sessionTitle: titleOf(rec),
      additionalContext: [...(result.additionalContext ?? []), lines.join('\n')],
    }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id) return result
    const cfg = await ensure($, options, e.cwd, e.session_id)
    const rec = await loadRecord($, cfg, e.session_id)
    if (!rec) return result

    const isPersonsPrompt = (e.source === undefined || e.source === 'user') && !e.prompt.startsWith(FIRST_PROMPT_MARK)
    if (!rec.feature) {
      // A session that already has a title keeps it, under the machine prefix.
      const named = featureFromTitle(e.session_title, cfg.machine)
      if (named) {
        rec.feature = named
        if (isDoneTitle(e.session_title)) rec.status = 'done'
      } else if (isPersonsPrompt && !e.prompt.trimStart().startsWith('/')) rec.feature = await nameFeature($, e.prompt)
      if (rec.feature) await saveRecord($, cfg, rec)
    }
    const title = titleOf(rec)
    if (e.session_title === title) return result
    const askedKey = `asked:${e.session_id}`
    const isAsked = (await $.store.get(askedKey)) === title || (await $.store.get(APP_SYNC_KEY)) === 'works'
    if (!isAsked) await $.store.set(askedKey, title)
    return {
      ...result,
      sessionTitle: title,
      ...(isAsked ? {} : { additionalContext: [...(result.additionalContext ?? []), renameAsk(title)] }),
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && config) {
      const cfg = config
      $.clock.after(0, () => void syncApp($, cfg))
    }
    return result
  })

  on('tool.call', ($, e, next) =>
    isOutside && GUARDED.has(String(e.tool))
      ? { deny: `session-fleet: this session runs outside ${config?.root}; start it there or run /fleet-here.` }
      : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'session-fleet: its folder guard failed.' }))

  on('command.run', { command: 'feature' }, async ($, e) =>
    config ? { text: await setFeature($, config, e.args) } : { text: NOT_READY },
  )
  on('command.run', { command: 'done' }, async ($, e) => {
    if (!config) return { text: NOT_READY }
    const text = await markDone($, config, e.args)
    void $.prompt.submit({ text: `${FIRST_PROMPT_MARK} ${text} Then reply with one short line.` })
    return { text }
  })
  on('command.run', { command: 'sessions' }, async ($, e) =>
    config ? { text: await listSessions($, config, e.args.trim() === 'all') } : { text: NOT_READY },
  )
  on('command.run', { command: 'fleet' }, async $ => (config ? { text: await fleetStatus($, config) } : { text: NOT_READY }))

  on('tool.call', { tool: 'mcp__session-fleet__fleet_feature' }, async ($, e) =>
    answer(config ? await setFeature($, config, String(arg(e, 'name') ?? '')) : NOT_READY),
  )
  on('tool.call', { tool: 'mcp__session-fleet__fleet_done' }, async ($, e) =>
    answer(config ? await markDone($, config, String(arg(e, 'note') ?? '')) : NOT_READY),
  )
  on('tool.call', { tool: 'mcp__session-fleet__fleet_sessions' }, async ($, e) =>
    answer(config ? await listSessions($, config, arg(e, 'all') === true) : NOT_READY),
  )
  on('tool.call', { tool: 'mcp__session-fleet__fleet_status' }, async $ => answer(config ? await fleetStatus($, config) : NOT_READY))

  on('command.run', { command: 'fleet-here' }, async $ => {
    await $.store.set(`here:${await $.session.id()}`, true)
    isOutside = false
    return { text: 'Edits allowed in this session outside the project folder.' }
  })
}

const NOT_READY = 'session-fleet is not loaded yet.'

/** Whether the desktop app's own session and sidebar tools answer the plugin on this machine. */
const APP_SYNC_KEY = 'appSync'

const APP = {
  get: 'mcp__ccd_session_mgmt__get_session',
  title: 'mcp__ccd_session_mgmt__set_session_title',
  groups: 'mcp__ccd_sidebar__list_groups',
  create: 'mcp__ccd_sidebar__create_group',
  move: 'mcp__ccd_sidebar__move_sessions',
  completed: 'mcp__ccd_sidebar__mark_completed',
} as const

/** Calls one of the desktop app's tools; the answer's text, or undefined when it is missing or refused. */
async function callApp($: $, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  const ran = await $.tool.call({ tool, ...args } as never).catch(() => undefined)
  if (!ran || ran.deny !== undefined || ran.isError) return undefined
  if (typeof ran.text === 'string') return ran.text
  return typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result)
}

const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

let isSyncing = false

/**
 * Brings the desktop app in line with the record: the title "[machine] feature",
 * the sidebar group (the machine's, or Done), completed once done. A title the
 * app or the person gave without the prefix becomes the feature, unless the
 * feature was named with /feature or fleet_feature.
 */
async function syncApp($: $, cfg: Config) {
  if (isSyncing) return
  isSyncing = true
  try {
    const rec = await loadRecord($, cfg, await $.session.id())
    if (!rec) return
    const info = parseJson(await callApp($, APP.get, { session_id: 'self' })) as
      | { title?: string; group?: { id: string; name: string } | null }
      | undefined
    if (!info || typeof info !== 'object') {
      await $.store.set(APP_SYNC_KEY, 'missing')
      return
    }
    await $.store.set(APP_SYNC_KEY, 'works')

    const current = info.title ?? ''
    const isPrefixed = current.startsWith(`[${cfg.machine}]`)
    if (!isPrefixed && rec.featureSource !== 'user') {
      const named = featureFromTitle(current, cfg.machine)
      if (named && named !== rec.feature) {
        rec.feature = named
        if (isDoneTitle(current)) rec.status = 'done'
        await saveRecord($, cfg, rec)
      }
    }
    const title = titleOf(rec)
    if (current !== title) await callApp($, APP.title, { session_id: 'self', title })

    const want = rec.status === 'done' ? 'Done' : cfg.machine
    if (info.group?.name !== want) {
      const groups = (parseJson(await callApp($, APP.groups, {})) as { id: string; name: string }[] | undefined) ?? []
      let id = groups.find(g => g.name === want)?.id
      if (!id) id = (await callApp($, APP.create, { name: want }))?.match(/cg-[0-9a-f-]+/)?.[0]
      if (id) await callApp($, APP.move, { session_ids: ['self'], group_id: id })
    }
    if (rec.status === 'done' && !rec.isMarkedCompleted) {
      if ((await callApp($, APP.completed, { session_id: 'self' })) !== undefined) {
        rec.isMarkedCompleted = true
        await saveRecord($, cfg, rec, { sync: false })
      }
    }
  } finally {
    isSyncing = false
  }
}

const answer = (text: string) => ({ result: text, text })

/** One argument of a call to the plugin's own tool, wherever the envelope carries it. */
const arg = (e: object, key: string): unknown => {
  const call = e as Record<string, unknown>
  const input = call.input as Record<string, unknown> | undefined
  return input?.[key] ?? call[key]
}

async function registerTools($: $) {
  await $.tool.register({
    name: 'fleet_feature',
    description: 'Name the feature this session works on; the session title becomes "[machine] <feature>".',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '2-6 word feature name' } }, required: ['name'] },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'fleet_done',
    description: 'Mark this session done in the shared registry (synced to every machine). Call when the user says the work is finished.',
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'optional one-line outcome' } } },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'fleet_sessions',
    description: 'List the sessions of every machine from the shared registry: machine, feature, active or done.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'include every done session' } } },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'fleet_status',
    description: 'Show this machine name, the project folder check, the Remote Control setting and the registry.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
}

async function setFeature($: $, cfg: Config, raw: string): Promise<string> {
  const name = raw.trim()
  if (!name) return 'Give a feature name.'
  const rec = await currentRecord($, cfg)
  rec.feature = name.slice(0, 60)
  rec.featureSource = 'user'
  await saveRecord($, cfg, rec)
  $.clock.after(0, () => void syncApp($, cfg))
  return `Feature set: ${titleOf(rec)}. ${renameAsk(titleOf(rec))}`
}

async function markDone($: $, cfg: Config, note: string): Promise<string> {
  const rec = await currentRecord($, cfg)
  rec.status = 'done'
  rec.doneAt = new Date(await $.clock.now()).toISOString()
  if (note.trim()) rec.note = note.trim().slice(0, 300)
  await saveRecord($, cfg, rec)
  $.clock.after(0, () => void syncApp($, cfg))
  return (
    `Marked done and synced: ${titleOf(rec)}. ${renameAsk(titleOf(rec))} ` +
    'If mcp__ccd_sidebar tools are available, also mark this session completed and move it into the sidebar group "Done" (create it if missing).'
  )
}

async function listSessions($: $, cfg: Config, all: boolean): Promise<string> {
  await syncChain
  let pulled = 'folder registry'
  if (await isGitRegistry($, cfg)) {
    const ran = await git($, cfg, ['pull', '-q', '--rebase', '--autostash']).catch(() => undefined)
    pulled = ran?.exitCode === 0 ? 'git pulled' : 'git pull failed, showing local copy'
  }
  const records = await readAll($, cfg)
  return `${formatTable(records, all)}\n\n_${records.length} sessions · ${pulled} · ${cfg.registry}_`
}

async function fleetStatus($: $, cfg: Config): Promise<string> {
  const rec = await currentRecord($, cfg)
  const mode = (await isGitRegistry($, cfg)) ? 'git clone (pull/push on change)' : 'plain folder'
  const root = cfg.root ? (isOutside ? ` (OUTSIDE ${cfg.root}, edits blocked)` : ` (inside ${cfg.root})`) : ' (no project folder set)'
  return [
    `Machine: ${cfg.machine}`,
    `Title: ${titleOf(rec)}`,
    `Folder: ${await $.session.cwd()}${root}`,
    await remoteControlNote($),
    `Registry: ${cfg.registry} (${mode})`,
  ].join('\n')
}

async function currentRecord($: $, cfg: Config): Promise<FleetRecord> {
  const id = await $.session.id()
  const now = new Date(await $.clock.now()).toISOString()
  return (
    (await loadRecord($, cfg, id)) ?? {
      machine: cfg.machine,
      sessionId: id,
      cwd: await $.session.cwd(),
      feature: '',
      status: 'active',
      startedAt: now,
      updatedAt: now,
    }
  )
}

async function readAll($: $, cfg: Config): Promise<FleetRecord[]> {
  const base = joinPath(cfg.registry, 'sessions')
  if (!(await $.fs.exists(base))) return []
  const out: FleetRecord[] = []
  for (const machine of await $.fs.list(base)) {
    if (machine.kind !== 'dir') continue
    for (const file of await $.fs.list(joinPath(base, machine.name))) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
      try {
        out.push(JSON.parse(await $.fs.read(joinPath(base, machine.name, file.name))) as FleetRecord)
      } catch {
        // a half-synced file; skip it
      }
    }
  }
  return out
}

/** A 2-5 word feature name for the first prompt, from a small model; the prompt's head when that fails. */
async function nameFeature($: $, prompt: string): Promise<string> {
  const r = await $.model
    .complete({
      model: 'haiku',
      system: 'You name software tasks. Reply with only a 2-5 word feature name in the language of the request, no quotes, no punctuation at the end.',
      prompt: prompt.slice(0, 2000),
      maxTokens: 30,
      timeoutMs: 8000,
    })
    .catch(() => undefined)
  const named = r?.isAnswered ? r.text.trim().split('\n')[0] : ''
  return (named || featureFromText(prompt)).slice(0, 60)
}
