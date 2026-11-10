/** One session as the shared registry keeps it: sessions/<machine>/<sessionId>.json. */
export type FleetRecord = {
  machine: string
  sessionId: string
  cwd: string
  feature: string
  status: 'active' | 'done'
  startedAt: string
  updatedAt: string
  doneAt?: string
  note?: string
  /** 'user' once named with /feature or fleet_feature: the app's title then no longer renames it. */
  featureSource?: 'auto' | 'user'
  /** Set once the desktop app's sidebar shows the done session as completed. */
  isMarkedCompleted?: boolean
  /** The title the plugin last gave the session in the app; any other title is the person's (or the app's) rename. */
  appliedTitle?: string
  /** The title the person gave the session, kept word for word: the plugin no longer puts its own title back. */
  userTitle?: string
  /** What the session is doing now, so other machines (and LumenLite) can show the account's running and waiting sessions. */
  live?: LiveRecord
  /** The Remote Control session (session_…) that opens this one from any device: claude.ai/code/<id>. */
  remoteSession?: string
}

/**
 * working: a turn is running; waiting: the session stopped for the person (a permission prompt, a question, a plan to
 * approve); idle: the turn ended.
 */
export type LiveState = 'working' | 'waiting' | 'idle'

export type LiveRecord = { state: LiveState; at: string }

/** How long a state change waits before it is pushed, so a burst of changes makes one commit. */
export const livePushDelay = (state: LiveState) => (state === 'waiting' ? 3_000 : 20_000)

/** The Remote Control session a desktop session file names last (its newest bridge), if any. */
export function bridgeOf(json: string): { id?: string; at: number } {
  try {
    const data = JSON.parse(json) as { bridgeSessionIds?: unknown; lastActivityAt?: unknown }
    const ids = Array.isArray(data.bridgeSessionIds)
      ? data.bridgeSessionIds.filter((x): x is string => typeof x === 'string' && /^(session|cse)_[A-Za-z0-9_-]+$/.test(x))
      : []
    return { id: ids[ids.length - 1], at: typeof data.lastActivityAt === 'number' ? data.lastActivityAt : 0 }
  } catch {
    return { at: 0 }
  }
}

/** Leads the prompts the plugin submits itself, so they never name a feature. */
export const FIRST_PROMPT_MARK = 'session-fleet:'

export const titleOf = (rec: FleetRecord) =>
  rec.userTitle
    ? rec.status === 'done'
      ? withDoneMark(rec.userTitle, rec.machine)
      : rec.userTitle
    : `[${rec.machine}] ${rec.status === 'done' ? '✅ ' : ''}${rec.feature || DEFAULT_FEATURE}`

/** A person's title with the done mark: after the machine prefix when it has one, else in front. */
function withDoneMark(title: string, machine: string): string {
  if (isDoneTitle(title)) return title
  const prefix = `[${machine}] `
  return title.startsWith(prefix) ? `${prefix}✅ ${title.slice(prefix.length)}` : `✅ ${title}`
}

export const joinPath = (...parts: string[]) =>
  parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter(Boolean)
    .join('/')

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether `path` is `root` or lies under it; case-insensitive, either slash. */
export const isInside = (path: string, root: string) => {
  const p = norm(path)
  const r = norm(root)
  return p === r || p.startsWith(r + '/')
}

const DEFAULT_FEATURE = 'new session'

/**
 * The feature a session title already names, without the machine prefix
 * ("5080 Cutscene lighting", "[5080] ✅ Cutscene lighting" -> "Cutscene lighting");
 * empty for no title or the plugin's own placeholder.
 */
export function featureFromTitle(title: string | undefined, machine: string): string {
  if (!title) return ''
  const m = machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bare = title
    .trim()
    .replace(new RegExp(`^(\\[${m}\\]|${m})(\\s*[-:|·]\\s*|\\s+)`, 'i'), '')
    .replace(/^✅\s*/, '')
    .trim()
  return bare.toLowerCase() === DEFAULT_FEATURE ? '' : bare.slice(0, 60)
}

/**
 * Takes in a title the plugin did not set; whether the record changed (the caller saves).
 *
 * - Once the plugin has titled the session (appliedTitle), or the person already renamed it, or the title carries the
 *   machine prefix, any other title is the person's rename: it is kept word for word (userTitle) and names the feature.
 * - Before that, a title without the prefix is the app's own first title: it names the feature, under the prefix.
 */
export function adoptTitle(rec: FleetRecord, current: string | undefined): boolean {
  if (!current || current === titleOf(rec) || current === rec.appliedTitle) return false
  const named = featureFromTitle(current, rec.machine)
  const isPersons = rec.userTitle !== undefined || !!rec.appliedTitle || current.trim().startsWith(`[${rec.machine}]`)
  if (isPersons) {
    rec.userTitle = current
    if (named) rec.feature = named
  } else {
    if (!named || named === rec.feature) return false
    rec.feature = named
  }
  if (isDoneTitle(current)) rec.status = 'done'
  return true
}

/**
 * Whether a plugin store file (~/.claude/plugins/store/*.json) is readable: 'ok'; 'nul' when it holds NUL bytes
 * (a write lost to a crash or power cut leaves the file zero-filled, and the engine then refuses the plugin's whole
 * start); 'bad' for other text that is not a JSON object, which may be a write still landing.
 */
export function storeVerdict(text: string): 'ok' | 'nul' | 'bad' {
  if (text.includes('\u0000')) return 'nul'
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? 'ok' : 'bad'
  } catch {
    return 'bad'
  }
}

/** Whether a title marks its session done (a ✅ anywhere in it). */
export const isDoneTitle = (title: string | undefined) => (title ?? '').includes('✅')

/** The first words of a prompt, as a fallback feature name. */
export const featureFromText = (text: string) =>
  text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ') || 'untitled'

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(min)) return '?'
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${Math.round(min / 60)}h`
  return `${Math.round(min / 1440)}d`
}

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ')

/** Active sessions by machine, then the latest done ones (all of them with `all`). */
export function formatTable(records: readonly FleetRecord[], all: boolean): string {
  if (records.length === 0) return 'No sessions in the registry yet.'
  const byNewest = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const active = byNewest.filter(r => r.status === 'active').sort((a, b) => a.machine.localeCompare(b.machine))
  const done = byNewest.filter(r => r.status === 'done').slice(0, all ? undefined : 10)
  const row = (r: FleetRecord) =>
    `| ${cell(r.machine)} | ${cell(r.feature || '—')} | ${ago(r.updatedAt)} | ${cell(r.cwd)} | \`${r.sessionId.slice(0, 8)}\` |`
  const head = '| Machine | Feature | Updated | Folder | Session |\n|---|---|---|---|---|'
  const parts = [`**Active (${active.length})**`, active.length ? [head, ...active.map(row)].join('\n') : '_none_']
  parts.push(`**Done (${done.length}${all ? '' : ', latest'})**`, done.length ? [head, ...done.map(row)].join('\n') : '_none_')
  return parts.join('\n\n')
}
