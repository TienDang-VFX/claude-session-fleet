import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { featureFromTitle, formatTable, isDoneTitle, isInside, joinPath, titleOf, type FleetRecord } from '../hooks/fleet'

const rec = (over: Partial<FleetRecord> = {}): FleetRecord => ({
  machine: '3090',
  sessionId: 'abcdef1234',
  cwd: 'D:/Work/game',
  feature: '',
  status: 'active',
  startedAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...over,
})

describe('helpers', () => {
  test('titles carry the machine and the done mark', () => {
    expect(titleOf(rec())).toBe('[3090] new session')
    expect(titleOf(rec({ feature: 'trail fix' }))).toBe('[3090] trail fix')
    expect(titleOf(rec({ feature: 'trail fix', status: 'done' }))).toBe('[3090] ✅ trail fix')
  })

  test('folder check ignores case and slash style', () => {
    expect(isInside('d:\\Work\\game\\Source', 'D:/Work/game')).toBe(true)
    expect(isInside('D:\\Work\\game', 'D:\\Work\\game\\')).toBe(true)
    expect(isInside('D:\\Work\\game-other', 'D:\\Work\\game')).toBe(false)
    expect(isInside('E:\\Work\\game', 'D:\\Work\\game')).toBe(false)
  })

  test('an existing title keeps its words under the machine prefix', () => {
    expect(featureFromTitle('5080 Cutscene lighting', '5080')).toBe('Cutscene lighting')
    expect(featureFromTitle('[5080] ✅ Cutscene lighting', '5080')).toBe('Cutscene lighting')
    expect(featureFromTitle('5080: Lighting loc3', '5080')).toBe('Lighting loc3')
    expect(featureFromTitle('Autumn render handoff', '5080')).toBe('Autumn render handoff')
    expect(featureFromTitle('50801 benchmark', '5080')).toBe('50801 benchmark')
    expect(featureFromTitle('[5080] new session', '5080')).toBe('')
    expect(featureFromTitle(undefined, '5080')).toBe('')
    expect(isDoneTitle('[3090] ✅ #33064 Fix tests')).toBe(true)
    expect(isDoneTitle('[3090] Đuôi cáo')).toBe(false)
  })

  test('paths join with forward slashes', () => {
    expect(joinPath('C:\\Users\\me\\', 'sessions', '3090', 'a.json')).toBe('C:\\Users\\me/sessions/3090/a.json')
  })

  test('the table lists active sessions and done ones apart', () => {
    const text = formatTable([rec({ feature: 'a' }), rec({ machine: '5080', feature: 'b', status: 'done' })], false)
    expect(text).toContain('**Active (1)**')
    expect(text).toContain('| 3090 | a |')
    expect(text).toContain('**Done (1, latest)**')
    expect(text).toContain('| 5080 | b |')
  })
})

const slash = (p: string) => p.replace(/\\/g, '/')

/** An in-memory disk, a session and a quiet host beneath the plugin. */
function fakeHost(on: On, files: Map<string, string>, cwd: string) {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/home' })
  files.set('C:/home/.claude/session-fleet.json', JSON.stringify(CONFIG))
  const clock = mock.clock(on, { now: Date.parse('2026-10-17T00:00:00.000Z') })
  on('fs.write', ($, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(slash(e.path)) }))
  on('fs.read', ($, e) => {
    const text = files.get(slash(e.path))
    return text === undefined ? { deny: `missing ${e.path}` } : { value: text }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: '' } }) as never)
  return clock
}

const CONFIG = { machineName: '3090', projectRoot: 'D:\\Work\\game', registryDir: 'R:/reg', enforceFolder: true }

test('SessionStart first: a new session is titled with the machine and written to the registry', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files, 'D:\\Work\\game')
  on('classic.SessionStart', () => ({}))
  // The engine raises SessionStart before session.start: the plugin must not depend on the order.

  const result = await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\\Work\\game' })

  expect(result.sessionTitle).toBe('[3090] new session')
  expect(result.additionalContext?.join('\n')).toContain('inside this machine\'s project folder')
  const saved = JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}') as FleetRecord
  expect(saved).toMatchObject({ machine: '3090', status: 'active', feature: '' })
})

test('outside the project folder, edits are denied', async ($, on) => {
  fakeHost(on, new Map(), 'D:\\elsewhere')
  on('tool.call', () => ({ result: 'ran', text: 'ran' }))
  await $.session.start({ cwd: 'D:\\elsewhere', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Write', input: { file_path: 'D:/elsewhere/a.txt', content: 'x' } } as never)
  expect(JSON.stringify(ran)).toContain('outside')
})

test('the fleet_done tool marks the session done and asks for the new title', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files, 'D:\\Work\\game')
  await $.session.start({ cwd: 'D:\\Work\\game', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: 'mcp__session-fleet__fleet_done', input: { note: 'shipped' } } as never)
  expect(JSON.stringify(ran)).toContain('[3090] ✅ new session')
  const saved = JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}') as FleetRecord
  expect(saved).toMatchObject({ status: 'done', note: 'shipped' })
})

test('after a turn, the plugin renames the session and files it under its machine through the app', async ($, on) => {
  const files = new Map<string, string>()
  const clock = fakeHost(on, files, 'D:\\Work\\game')
  const calls: { tool: string; [k: string]: unknown }[] = []
  const reply = (text: string) => ({ result: text, text })
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; [k: string]: unknown }
    calls.push(call)
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return reply('{"title":"Recreate VFX Gymboard Niagara","group":null}')
    if (call.tool === 'mcp__ccd_sidebar__list_groups') return reply('[{"id":"cg-1","name":"Done"}]')
    if (call.tool === 'mcp__ccd_sidebar__create_group') return reply('Created group "3090" with id cg-2a.')
    return reply('ok')
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'D:\\Work\\game', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\\Work\\game' })

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()

  const rename = calls.find(c => c.tool === 'mcp__ccd_session_mgmt__set_session_title')
  expect(rename).toMatchObject({ session_id: 'self', title: '[3090] Recreate VFX Gymboard Niagara' })
  expect(calls.find(c => c.tool === 'mcp__ccd_sidebar__move_sessions')).toMatchObject({ group_id: 'cg-2a' })
})
