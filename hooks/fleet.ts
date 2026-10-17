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
}

/** Leads the prompts the plugin submits itself, so they never name a feature. */
export const FIRST_PROMPT_MARK = 'session-fleet:'

export const titleOf = (rec: FleetRecord) =>
  `[${rec.machine}] ${rec.status === 'done' ? '✅ ' : ''}${rec.feature || DEFAULT_FEATURE}`

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
  return bare === DEFAULT_FEATURE ? '' : bare.slice(0, 60)
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
