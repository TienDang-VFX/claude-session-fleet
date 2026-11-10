import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  type FleetRecord,
  type LiveState,
  bridgeOf,
  livePushDelay,
  LIVE_RETRY_MS,
  FIRST_PROMPT_MARK,
  featureFromText,
  featureFromTitle,
  isDoneTitle,
  formatTable,
  isInside,
  joinPath,
  adoptTitle,
  storeVerdict,
  titleOf,
} from './fleet'

type $ = EngineInterface

/** Tools that change files or run commands: denied outside the project folder. */
const GUARDED = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'PowerShell'])

type Config = { machine: string; host: string; root: string; registry: string; enforce: boolean }

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
  // The computer's own name, as RustDesk shows it, so another machine can open this one's screen.
  let host = ((await $.env.get('COMPUTERNAME')) ?? '').trim()
  if (!host) {
    const ran = await $.process.run(['hostname']).catch(() => undefined)
    host = ran?.stdout.trim() ?? ''
  }
  let machine = str(options, 'machineName')
  if (!machine) machine = host.split('.')[0]
  let registry = str(options, 'registryDir')
  if (!registry) registry = joinPath(home, '.claude', 'session-fleet-registry')
  return {
    machine: machine || 'unknown',
    host,
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

/**
 * Commits this session's record and pushes it. Resolves true once pushed. Serialized within this session, and across
 * the machine's sessions by a lock in the registry's .git folder: several sessions running git at once in one clone
 * left a rebase half done, after which nothing from the machine reached the registry.
 */
function pushRecord($: $, cfg: Config, rec: FleetRecord): Promise<boolean> {
  const run = syncChain.then(async () => {
    if (!(await isGitRegistry($, cfg))) return true
    return withRegistryLock($, cfg, async () => {
      // A rebase another session left half done (crashed, or from before the lock) is undone first.
      if ((await $.fs.exists(joinPath(cfg.registry, '.git', 'rebase-merge'))) || (await $.fs.exists(joinPath(cfg.registry, '.git', 'rebase-apply'))))
        await git($, cfg, ['rebase', '--abort'])
      const rel = `sessions/${cfg.machine}/${rec.sessionId}.json`
      await git($, cfg, ['add', '--', rel])
      await git($, cfg, ['commit', '-q', '-m', `${rec.machine}: ${rec.status} ${rec.feature || rec.sessionId}`, '--', rel])
      // Another machine may push between the pull and the push: pull again and retry.
      for (let attempt = 0; attempt < 3; attempt++) {
        const pulled = await git($, cfg, ['pull', '-q', '--rebase', '--autostash'])
        if (pulled.exitCode !== 0) {
          await git($, cfg, ['rebase', '--abort'])
          continue
        }
        const pushed = await git($, cfg, ['push', '-q'])
        if (pushed.exitCode === 0) return true
        if (attempt === 2) $.ui.toast(`session-fleet: push failed: ${pushed.stderr.trim().slice(0, 120)}`)
      }
      return false
    })
  })
  const settled = run.catch(err => {
    $.ui.toast(`session-fleet: sync failed: ${String(err).slice(0, 120)}`)
    return false
  })
  syncChain = settled
  return settled
}

/** A lock older than this is a session that died holding it. */
const LOCK_STALE_MS = 2 * 60_000

/**
 * Runs `work` while this session holds the registry lock, a small file in .git naming its holder: written, then read
 * back after a moment to see that no other session wrote over it. Gives up (false) after about half a minute.
 */
async function withRegistryLock($: $, cfg: Config, work: () => Promise<boolean>): Promise<boolean> {
  const file = joinPath(cfg.registry, '.git', 'session-fleet.lock')
  const me = `${await $.session.id()}:${Math.random().toString(36).slice(2)}`
  const holder = async () => {
    try {
      return JSON.parse(await $.fs.read(file)) as { owner?: string; at?: number }
    } catch {
      return {}
    }
  }
  let held = false
  for (let tries = 0; tries < 30 && !held; tries++) {
    const now = await $.clock.now()
    const other = (await $.fs.exists(file)) ? await holder() : {}
    if (other.owner && other.owner !== me && now - (other.at ?? 0) < LOCK_STALE_MS) {
      await $.clock.sleep(1_000)
      continue
    }
    await $.fs.write(file, JSON.stringify({ owner: me, at: now }))
    await $.clock.sleep(150)
    held = (await holder()).owner === me
  }
  if (!held) return false
  try {
    return await work()
  } finally {
    await $.fs.write(file, '{}')
  }
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

const STORE_RECHECK_MS = 3000

/**
 * Plugin store files the engine can no longer parse stop their plugin's whole start ("store file ... is malformed"),
 * and reinstalling the plugin does not touch them. Each one is copied to ~/.claude/plugins/store-quarantine and reset
 * to an empty object, so the plugin starts with a fresh store. A zero-filled file is reset at once; other unparsable
 * text only when it reads the same a few seconds later, so a write still landing is never taken for damage.
 */
async function healStores($: $) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return
  const dir = joinPath(home, '.claude', 'plugins', 'store')
  if (!(await $.fs.exists(dir))) return
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const file = joinPath(dir, entry.name)
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) continue
    const verdict = storeVerdict(text)
    if (verdict === 'nul') await quarantine($, home, file, entry.name, text)
    else if (verdict === 'bad')
      $.clock.after(STORE_RECHECK_MS, async () => {
        const again = await $.fs.read(file).catch(() => undefined)
        if (again === text) await quarantine($, home, file, entry.name, text)
      })
  }
}

async function quarantine($: $, home: string, file: string, name: string, text: string) {
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  await $.fs.write(joinPath(home, '.claude', 'plugins', 'store-quarantine', `${stamp}-${name}`), text)
  await $.fs.write(file, '{}\n')
  $.ui.toast(`session-fleet: plugin store ${name} was damaged; reset it (copy in store-quarantine). Restart sessions of that plugin.`)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await healStores($).catch(err => $.ui.log(`session-fleet: store check failed: ${String(err)}`, { to: 'debug' }))
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
    // A long turn ends late, and the app may retitle a session at any time: keep it in line while it is open.
    $.clock.every(SYNC_EVERY_MS, () => void syncApp($, cfg))
    // A state that never reached the registry is pushed again, so other machines do not keep an old wait.
    $.clock.every(LIVE_RETRY_MS, () => void pushLive($, cfg))
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
    // A resumed session the person renamed meanwhile keeps that name.
    adoptTitle(rec, e.session_title)
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
      // The app titles a new session while its first turn still runs: rename it soon, not when the turn ends.
      for (const delay of FIRST_SYNC_DELAYS_MS) $.clock.after(delay, () => void syncApp($, cfg))
    } else if (adoptTitle(rec, e.session_title)) await saveRecord($, cfg, rec)
    const title = titleOf(rec)
    if (e.session_title === title) return result
    // The terminal applies a hook's sessionTitle (the desktop app ignores it): remember it as the plugin's own.
    if (!(await isDesktop($)) && rec.appliedTitle !== title) {
      rec.appliedTitle = title
      await saveRecord($, cfg, rec, { sync: false })
    }
    const askedKey = `asked:${e.session_id}`
    const isAsked = (await $.store.get(askedKey)) === title || (await $.store.get(APP_SYNC_KEY)) === 'works'
    if (!isAsked) await $.store.set(askedKey, title)
    return {
      ...result,
      sessionTitle: title,
      ...(isAsked ? {} : { additionalContext: [...(result.additionalContext ?? []), renameAsk(title)] }),
    }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && config) await setLive($, config, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && config) {
      const cfg = config
      await setLive($, cfg, 'idle')
      $.clock.after(0, () => void syncApp($, cfg))
    }
    return result
  })

  // The session stops for the person: a permission prompt or a question dialog.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (config) await setLive($, config, 'waiting')
    return next(e)
  })
  on('classic.Notification', async ($, e, next) => {
    if (config && (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog'))
      await setLive($, config, 'waiting')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (isOutside && GUARDED.has(String(e.tool)))
      return { deny: `session-fleet: this session runs outside ${config?.root}; start it there or run /fleet-here.` }
    // A question or a plan to approve stops the turn for the person.
    const asks = ASKS.has(String(e.tool))
    if (asks && config) await setLive($, config, 'waiting')
    const result = await next(e)
    // Answered, or allowed after a permission prompt: the turn goes on.
    if (config && (asks || liveState === 'waiting')) await setLive($, config, 'working')
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'session-fleet: its folder guard failed.' }))

  on('command.run', { command: 'feature' }, async ($, e) => {
    if (!config) return { text: NOT_READY }
    const reply = await setFeature($, config, e.args)
    return reply.model ? { text: reply.user, context: [reply.model] } : { text: reply.user }
  })
  on('command.run', { command: 'done' }, async ($, e) => {
    if (!config) return { text: NOT_READY }
    const reply = await markDone($, config, e.args)
    // The model reads `context`, the person does not; it is filled only where the plugin cannot reach the app itself.
    return reply.model ? { text: reply.user, context: [reply.model] } : { text: reply.user }
  })
  on('command.run', { command: 'sessions' }, async ($, e) =>
    config ? { text: await listSessions($, config, e.args.trim() === 'all') } : { text: NOT_READY },
  )
  on('command.run', { command: 'fleet' }, async $ => (config ? { text: await fleetStatus($, config) } : { text: NOT_READY }))

  on('tool.call', { tool: 'mcp__session-fleet__fleet_feature' }, async ($, e) =>
    config ? toolReply(await setFeature($, config, String(arg(e, 'name') ?? ''))) : answer(NOT_READY),
  )
  on('tool.call', { tool: 'mcp__session-fleet__fleet_done' }, async ($, e) =>
    config ? toolReply(await markDone($, config, String(arg(e, 'note') ?? ''))) : answer(NOT_READY),
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

/** Tools that stop the turn until the person answers. */
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** The live state last written for this session, and the push it waits for (only the newest goes). */
let liveState: LiveState | undefined
let livePush = 0
/** The last live state the registry has from this session. */
let livePushed: LiveState | undefined

/**
 * Records what the session is doing in the registry: written at once, pushed a little later so a burst of changes (a
 * turn that starts, asks and goes on) makes one commit. The Remote Control session is looked up once per load.
 */
async function setLive($: $, cfg: Config, state: LiveState) {
  if (liveState === state) return
  liveState = state
  const rec = await loadRecord($, cfg, await $.session.id())
  if (!rec) return
  rec.live = { state, at: new Date(await $.clock.now()).toISOString() }
  // Remote Control may connect after the first turn starts, and a reconnect opens a new bridge: look again until found,
  // and at each turn's end.
  if (cfg.host) rec.host = cfg.host
  if (!rec.remoteSession || state === 'idle') {
    const bridge = await findBridge($).catch(() => undefined)
    if (bridge) rec.remoteSession = bridge
  }
  await saveRecord($, cfg, rec, { sync: false })
  const mine = ++livePush
  $.clock.after(livePushDelay(state), async () => {
    if (mine === livePush) await pushLive($, cfg)
  })
}

/** Pushes this session's record when the registry does not have its live state yet. */
async function pushLive($: $, cfg: Config) {
  const state = liveState
  if (!state || state === livePushed) return
  const latest = await loadRecord($, cfg, await $.session.id())
  if (latest && (await pushRecord($, cfg, latest))) livePushed = state
}

/**
 * The Remote Control session of this desktop session: the app keeps it in its own file for the session,
 * <app data>/claude-code-sessions/<account>/<org>/<local id>.json, as bridgeSessionIds.
 */
async function findBridge($: $): Promise<string | undefined> {
  const info = parseJson(await callApp($, APP.get, { session_id: 'self' })) as { sessionId?: string } | undefined
  const local = info?.sessionId
  if (!local || !/^local_[A-Za-z0-9-]+$/.test(local)) return undefined
  const roaming = ((await $.env.get('APPDATA')) ?? '').trim()
  const localData = ((await $.env.get('LOCALAPPDATA')) ?? '').trim()
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').trim()
  const bases: string[] = []
  if (roaming) bases.push(joinPath(roaming, 'Claude'))
  if (home) bases.push(joinPath(home, 'Library', 'Application Support', 'Claude'), joinPath(home, '.config', 'Claude'))
  for (const [parent, prefix, tail] of [
    [joinPath(localData, 'Claude-Data'), '', []],
    [joinPath(localData, 'Packages'), 'Claude_', ['LocalCache', 'Roaming', 'Claude']],
  ] as const) {
    if (!localData || !(await $.fs.exists(parent))) continue
    for (const entry of await $.fs.list(parent))
      if (entry.kind === 'dir' && entry.name.startsWith(prefix)) bases.push(joinPath(parent, entry.name, ...tail))
  }
  let best: { id?: string; at: number } = { at: -1 }
  for (const base of bases) {
    const root = joinPath(base, 'claude-code-sessions')
    if (!(await $.fs.exists(root))) continue
    for (const account of await $.fs.list(root)) {
      if (account.kind !== 'dir') continue
      for (const org of await $.fs.list(joinPath(root, account.name))) {
        const file = joinPath(root, account.name, org.name, `${local}.json`)
        if (org.kind !== 'dir' || !(await $.fs.exists(file))) continue
        const found = bridgeOf(await $.fs.read(file))
        if (found.id && found.at > best.at) best = found
      }
    }
  }
  return best.id
}

/** Whether the desktop app's own session and sidebar tools answer the plugin on this machine. */
const APP_SYNC_KEY = 'appSync'

/** When an open session is brought in line with its record besides each turn's end. */
const FIRST_SYNC_DELAYS_MS = [30_000, 120_000]
const SYNC_EVERY_MS = 30 * 60_000

const APP = {
  get: 'mcp__ccd_session_mgmt__get_session',
  title: 'mcp__ccd_session_mgmt__set_session_title',
  groups: 'mcp__ccd_sidebar__list_groups',
  create: 'mcp__ccd_sidebar__create_group',
  move: 'mcp__ccd_sidebar__move_sessions',
  completed: 'mcp__ccd_sidebar__mark_completed',
  remote: 'mcp__ccd_session_mgmt__set_remote_control',
} as const

const isDesktop = async ($: $) => ((await $.session.surfaces().catch(() => [])) as readonly string[]).includes('desktop')

/** How long one call to the app may take before syncApp goes on without it. */
const APP_CALL_TIMEOUT_MS = 20_000

/** Calls one of the desktop app's tools; the answer's text, or undefined when it is missing or refused. */
async function callApp($: $, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
  // A call the app never answers would hold syncApp's lock for good, and no later sync would file or title the session.
  const timedOut = new Promise<'timeout'>(resolve => $.clock.after(APP_CALL_TIMEOUT_MS, () => resolve('timeout')))
  const ran = await Promise.race([$.tool.call({ tool, ...args } as never).catch(() => undefined), timedOut])
  if (ran === 'timeout') {
    $.ui.log(`session-fleet: ${tool} did not answer in ${APP_CALL_TIMEOUT_MS / 1000}s`, { to: 'debug' })
    return undefined
  }
  if (!ran || ran.deny !== undefined || ran.isError) {
    $.ui.log(`session-fleet: ${tool} refused: ${String(ran?.deny ?? ran?.text ?? 'no answer').slice(0, 160)}`, { to: 'debug' })
    return undefined
  }
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
      | { title?: string; group?: { id: string; name: string } | null; remoteControlState?: string; scheduledTaskId?: string }
      | undefined
    if (!info || typeof info !== 'object') {
      await $.store.set(APP_SYNC_KEY, 'missing')
      return
    }
    await $.store.set(APP_SYNC_KEY, 'works')
    // A scheduled task's run (the tidy task among them) stays as the app files it, under Routines.
    if (info.scheduledTaskId) return

    // A title the plugin did not set is the person's rename, kept as it is, or the app's first title, which becomes the
    // feature under the machine prefix (see adoptTitle).
    const current = info.title ?? ''
    if (adoptTitle(rec, current)) await saveRecord($, cfg, rec)
    // The sidebar group first: the title step below reconnects Remote Control, the call most likely to stall.
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

    const title = titleOf(rec)
    // A session already showing the plugin's title (one from before appliedTitle was kept) is marked as titled, so a
    // later rename counts as the person's.
    if (current === title && !rec.userTitle && rec.appliedTitle !== title) {
      rec.appliedTitle = title
      await saveRecord($, cfg, rec, { sync: false })
    }
    if (current !== title && (await callApp($, APP.title, { session_id: 'self', title })) !== undefined) {
      rec.appliedTitle = title
      await saveRecord($, cfg, rec, { sync: false })
      // Other devices read the title when Remote Control connects: reconnect so they see the new one.
      if (info.remoteControlState === 'on') {
        await callApp($, APP.remote, { session_id: 'self', enabled: false })
        await callApp($, APP.remote, { session_id: 'self', enabled: true })
      }
    }

    // The app drops Remote Control from a session that went idle; an open session takes it back.
    if (info.remoteControlState === 'off') await callApp($, APP.remote, { session_id: 'self', enabled: true })
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

/** What an action shows the person, and what the model is asked to do when the plugin cannot do it itself. */
type ActionReply = { user: string; model?: string }

/** The model's part of a reply, only on a machine where the app's tools do not answer the plugin. */
async function modelAsk($: $, rec: FleetRecord): Promise<string | undefined> {
  if ((await $.store.get(APP_SYNC_KEY)) === 'works') return undefined
  const group = rec.status === 'done' ? 'Done' : rec.machine
  return (
    `${renameAsk(titleOf(rec))} If mcp__ccd_sidebar tools are available, also move this session into the sidebar group "${group}" ` +
    `(create it if missing)${rec.status === 'done' ? ' and mark it completed' : ''}.`
  )
}

/** A record without a feature takes it from the session's current title in the app. */
async function adoptAppTitle($: $, cfg: Config, rec: FleetRecord) {
  if (rec.feature) return
  const info = parseJson(await callApp($, APP.get, { session_id: 'self' })) as { title?: string } | undefined
  rec.feature = featureFromTitle(info?.title, cfg.machine)
}

async function setFeature($: $, cfg: Config, raw: string): Promise<ActionReply> {
  const name = raw.trim()
  if (!name) return { user: 'Give a feature name.' }
  const rec = await currentRecord($, cfg)
  rec.feature = name.slice(0, 60)
  rec.featureSource = 'user'
  // Naming the feature asks for the plugin's title again, over an earlier rename.
  delete rec.userTitle
  await saveRecord($, cfg, rec)
  $.clock.after(0, () => void syncApp($, cfg))
  return { user: `Feature set: ${titleOf(rec)}.`, model: await modelAsk($, rec) }
}

async function markDone($: $, cfg: Config, note: string): Promise<ActionReply> {
  const rec = await currentRecord($, cfg)
  await adoptAppTitle($, cfg, rec)
  rec.status = 'done'
  rec.doneAt = new Date(await $.clock.now()).toISOString()
  if (note.trim()) rec.note = note.trim().slice(0, 300)
  await saveRecord($, cfg, rec)
  $.clock.after(0, () => void syncApp($, cfg))
  return { user: `Marked done: ${titleOf(rec)}. Moving it to Done and syncing to the other machines.`, model: await modelAsk($, rec) }
}

/** A tool's answer: the model reads both parts. */
const toolReply = (reply: ActionReply) => answer(reply.model ? `${reply.user} ${reply.model}` : reply.user)

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
