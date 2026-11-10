import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { featureFromTitle, formatTable, isDoneTitle, adoptTitle, isInside, joinPath, storeVerdict, titleOf, type FleetRecord } from '../hooks/fleet'

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

  test("once the plugin titled the session, another title is the person's and is kept word for word", () => {
    const named = () => rec({ feature: 'Old work', appliedTitle: '[3090] Old work' })
    expect(adoptTitle(named(), '[3090] Old work')).toBe(false)
    expect(adoptTitle(named(), undefined)).toBe(false)
    const mine = named()
    expect(adoptTitle(mine, 'My own name')).toBe(true)
    expect(mine).toMatchObject({ feature: 'My own name', userTitle: 'My own name' })
    expect(titleOf(mine)).toBe('My own name')
    const prefixed = named()
    expect(adoptTitle(prefixed, '[3090] Kept prefix')).toBe(true)
    expect(titleOf(prefixed)).toBe('[3090] Kept prefix')
    // Taking the prefix off a plugin title is a rename too, not put back.
    const bare = named()
    expect(adoptTitle(bare, 'Old work')).toBe(true)
    expect(titleOf(bare)).toBe('Old work')
    // The plugin's last title, before a /feature reached the app, is not taken back as a rename.
    expect(adoptTitle(rec({ feature: 'New', appliedTitle: '[3090] Old' }), '[3090] Old')).toBe(false)
    expect(adoptTitle(rec(), '[3090] new session')).toBe(false)
  })

  test("the app's first title, before the plugin titled the session, goes under the machine prefix", () => {
    const fresh = rec({ feature: 'haiku name' })
    expect(adoptTitle(fresh, 'Recreate VFX Gymboard')).toBe(true)
    expect(fresh.userTitle).toBeUndefined()
    expect(titleOf(fresh)).toBe('[3090] Recreate VFX Gymboard')
  })

  test("a person's title takes the done mark after its prefix, or in front", () => {
    expect(titleOf(rec({ userTitle: 'Đuôi cáo', status: 'done' }))).toBe('✅ Đuôi cáo')
    expect(titleOf(rec({ userTitle: '[3090] Đuôi cáo', status: 'done' }))).toBe('[3090] ✅ Đuôi cáo')
    expect(titleOf(rec({ userTitle: '✅ Đuôi cáo', status: 'done' }))).toBe('✅ Đuôi cáo')
  })

  test('a store file is damaged when zero-filled or not a JSON object', () => {
    expect(storeVerdict('{"a":1}')).toBe('ok')
    expect(storeVerdict('\u0000'.repeat(64))).toBe('nul')
    expect(storeVerdict('{"a":')).toBe('bad')
    expect(storeVerdict('[]')).toBe('bad')
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
function fakeHost(on: On, files: Map<string, string>, cwd: string, env: Record<string, string> = {}, run: (args: readonly string[]) => number = () => 1) {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  files.set('C:/home/.claude/session-fleet.json', JSON.stringify(CONFIG))
  const clock = mock.clock(on, { now: Date.parse('2026-10-17T00:00:00.000Z') })
  on('fs.write', ($, e) => {
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  // A folder exists when a file lies under it.
  on('fs.exists', ($, e) => ({ value: files.has(slash(e.path)) || [...files.keys()].some(k => k.startsWith(slash(e.path) + '/')) }))
  on('fs.read', ($, e) => {
    const text = files.get(slash(e.path))
    return text === undefined ? { deny: `missing ${e.path}` } : { value: text }
  })
  on('process.run', ($, e) => ({ value: { exitCode: run(e.argv), stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
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
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return reply('{"title":"Recreate VFX Gymboard Niagara","group":null,"remoteControlState":"on"}')
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
  const remote = calls.filter(c => c.tool === 'mcp__ccd_session_mgmt__set_remote_control').map(c => c.enabled)
  expect(remote).toEqual([false, true])
})

test('a session the person renamed keeps that exact name instead of being put back', async ($, on) => {
  const files = new Map<string, string>()
  const clock = fakeHost(on, files, 'D:\\Work\\game')
  const old: FleetRecord = { ...JSON.parse('{}'), machine: '3090', sessionId: 'sess-1', cwd: 'D:\\Work\\game', feature: 'Old work', status: 'active', startedAt: '', updatedAt: '', appliedTitle: '[3090] Old work' }
  files.set('R:/reg/sessions/3090/sess-1.json', JSON.stringify(old))
  const titles: unknown[] = []
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; title?: string }
    const info = '{"title":"Tên tôi tự đặt","group":{"id":"cg-1","name":"3090"}}'
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return { result: info, text: info }
    if (call.tool === 'mcp__ccd_session_mgmt__set_session_title') titles.push(call.title)
    return { result: 'ok', text: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'D:\\Work\\game', surface: 'desktop', isInteractive: true })

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()

  expect(titles).toEqual([])
  const saved = JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}') as FleetRecord
  expect(saved).toMatchObject({ feature: 'Tên tôi tự đặt', userTitle: 'Tên tôi tự đặt' })
})

test('a rename that keeps the machine prefix is kept as it is', async ($, on) => {
  const files = new Map<string, string>()
  const clock = fakeHost(on, files, 'D:\\Work\\game')
  const old: FleetRecord = { machine: '3090', sessionId: 'sess-1', cwd: 'D:\\Work\\game', feature: 'Old work', status: 'active', startedAt: '', updatedAt: '', appliedTitle: '[3090] Old work' }
  files.set('R:/reg/sessions/3090/sess-1.json', JSON.stringify(old))
  const titles: unknown[] = []
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; title?: string }
    const info = '{"title":"[3090] Đổi tên giữ tiền tố","group":{"id":"cg-1","name":"3090"}}'
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return { result: info, text: info }
    if (call.tool === 'mcp__ccd_session_mgmt__set_session_title') titles.push(call.title)
    return { result: 'ok', text: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'D:\\Work\\game', surface: 'desktop', isInteractive: true })

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()

  expect(titles).toEqual([])
  const saved = JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}') as FleetRecord
  expect(saved.feature).toBe('Đổi tên giữ tiền tố')
})

test('a zero-filled plugin store file is copied aside and reset at session start', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files, 'D:\\Work\\game')
  const dir = 'C:/home/.claude/plugins/store'
  files.set(dir, '')
  files.set(`${dir}/broken_x.json`, '\u0000'.repeat(32))
  files.set(`${dir}/fine_y.json`, '{"k":1}')
  on('fs.list', ($, e) =>
    slash(e.path) === dir
      ? { value: [{ name: 'broken_x.json', kind: 'file' }, { name: 'fine_y.json', kind: 'file' }] }
      : { value: [] },
  )
  await $.session.start({ cwd: 'D:\\Work\\game', surface: 'desktop', isInteractive: true })

  expect(files.get(`${dir}/broken_x.json`)).toBe('{}\n')
  expect(files.get(`${dir}/fine_y.json`)).toBe('{"k":1}')
  expect([...files.keys()].some(k => k.startsWith('C:/home/.claude/plugins/store-quarantine/') && k.endsWith('broken_x.json'))).toBe(true)
})

test('done keeps the title the session already has, and the person reads no model instructions', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files, 'D:/Work/game')
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string }
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return { result: '{"title":"[3090] Cutscene lighting"}', text: '{"title":"[3090] Cutscene lighting"}' }
    return { result: 'ok', text: 'ok' }
  })
  on('command.run', () => ({ text: '' }))
  on('prompt.submit', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'D:/Work/game', surface: 'desktop', isInteractive: true })

  const ran = await $.command.run({ command: 'done', args: '' } as never)
  expect(ran.text).toBe('Marked done: [3090] ✅ Cutscene lighting. Moving it to Done and syncing to the other machines.')
  expect(ran.text ?? '').not.toContain('mcp__')
})

test('the registry follows what the session is doing, and names its Remote Control session', async ($, on) => {
  const files = new Map<string, string>()
  const clock = fakeHost(on, files, 'D:\\Work\\game', { APPDATA: 'C:/home/AppData/Roaming', COMPUTERNAME: 'DESKTOP-A4192P7' })
  files.set(
    'C:/home/AppData/Roaming/Claude/claude-code-sessions/acct/org/local_abc.json',
    JSON.stringify({ sessionId: 'local_abc', bridgeSessionIds: ['session_old', 'session_01New'], lastActivityAt: 5 }),
  )
  on('fs.list', ($, e) => {
    const dir = slash(e.path).replace(/\/$/, '') + '/'
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(dir)) continue
      const rest = path.slice(dir.length).split('/')
      names.set(rest[0], rest.length > 1 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind })) } as never
  })
  const record = () => JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}') as FleetRecord
  let duringQuestion: string | undefined
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string }
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') { const info = '{"sessionId":"local_abc","title":"x"}'; return { result: info, text: info } }
    if (call.tool === 'AskUserQuestion') duringQuestion = record().live?.state
    return { result: 'ok', text: 'ok' }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'D:\Work\game', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\Work\game' })

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(record().live?.state).toBe('working')
  expect(record().remoteSession).toBe('session_01New')
  // The computer's name, as RustDesk shows it, opens this machine's screen from another.
  expect(record().host).toBe('DESKTOP-A4192P7')

  await $.tool.call({ tool: 'AskUserQuestion', input: { questions: [] } } as never)
  expect(duringQuestion).toBe('waiting')
  expect(record().live?.state).toBe('working')

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  expect(record().live?.state).toBe('idle')
})

test('a wait that failed to reach the registry is pushed again, and the turn end goes out at once', async ($, on) => {
  const files = new Map<string, string>()
  files.set('R:/reg/.git/HEAD', 'ref: refs/heads/main')
  let online = false
  const pushes: boolean[] = []
  const clock = fakeHost(on, files, 'D:\Work\game', {}, args => {
    if (args[0] !== 'git' || args[1] !== 'push') return 0
    pushes.push(online)
    return online ? 0 : 1
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}) as never)
  await $.session.start({ cwd: 'D:\Work\game', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\Work\game' })

  await $.classic.Notification({ session_id: 'sess-1', cwd: 'D:\Work\game', message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  await clock.advance(1_000)
  await clock.settle()
  // Offline: the start and the wait were tried and failed.
  expect(pushes.length).toBeGreaterThan(0)
  expect(pushes.every(ok => !ok)).toBe(true)

  // The network is back: the retry pushes the wait.
  online = true
  await clock.advance(60_000)
  await clock.settle()
  expect(pushes.at(-1)).toBe(true)

  // The turn ends: pushed within a second, not after a long delay.
  const before = pushes.length
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  // A second for the delay, then the registry lock's short check.
  for (let step = 0; step < 4; step++) {
    await clock.advance(500)
    await clock.settle()
  }
  expect(pushes.length).toBeGreaterThan(before)
  expect(JSON.parse(files.get('R:/reg/sessions/3090/sess-1.json') ?? '{}').live?.state).toBe('idle')
})

test('a Remote Control call the app never answers neither stops the group move nor later syncs', async ($, on) => {
  const files = new Map<string, string>()
  const clock = fakeHost(on, files, 'D:\Work\game')
  const calls: string[] = []
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string }
    calls.push(call.tool)
    const info = '{"title":"Fresh app title","group":null,"remoteControlState":"on"}'
    if (call.tool === 'mcp__ccd_session_mgmt__get_session') return { result: info, text: info }
    if (call.tool === 'mcp__ccd_sidebar__list_groups') return { result: '[{"id":"cg-9","name":"3090"}]', text: '[{"id":"cg-9","name":"3090"}]' }
    if (call.tool === 'mcp__ccd_session_mgmt__set_remote_control') return new Promise(() => {}) as never
    return { result: 'ok', text: 'ok' }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'D:\Work\game', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\Work\game' })

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()
  expect(calls).toContain('mcp__ccd_sidebar__move_sessions')
  expect(calls.indexOf('mcp__ccd_sidebar__move_sessions')).toBeLessThan(calls.indexOf('mcp__ccd_session_mgmt__set_remote_control'))

  // Both hung Remote Control calls (off, then on) time out, and the next turn's sync runs.
  await clock.advance(25_000)
  await clock.settle()
  await clock.advance(25_000)
  await clock.settle()
  const gets = calls.filter(t => t === 'mcp__ccd_session_mgmt__get_session').length
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await clock.settle()
  expect(calls.filter(t => t === 'mcp__ccd_session_mgmt__get_session').length).toBeGreaterThan(gets)
})

test('a sync waits while another session of the machine holds the registry lock, and undoes a half-done rebase', async ($, on) => {
  const files = new Map<string, string>()
  files.set('R:/reg/.git/HEAD', 'ref: refs/heads/main')
  files.set('R:/reg/.git/rebase-merge/autostash', 'abc')
  // Another session holds the lock right now.
  files.set('R:/reg/.git/session-fleet.lock', JSON.stringify({ owner: 'other-session', at: Date.parse('2026-10-17T00:00:00.000Z') }))
  const ran: string[] = []
  const clock = fakeHost(on, files, 'D:\Work\game', {}, argv => {
    if (argv[0] === 'git') ran.push(argv[1])
    return 0
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: 'D:\Work\game', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', session_id: 'sess-1', cwd: 'D:\Work\game' })
  await clock.advance(3_000)
  await clock.settle()
  expect(ran).toEqual([])

  // The other session lets go: this one goes on, undoing the half-done rebase first.
  files.set('R:/reg/.git/session-fleet.lock', '{}')
  files.delete('R:/reg/.git/rebase-merge/autostash')
  files.set('R:/reg/.git/rebase-merge/x', '')
  for (let step = 0; step < 6; step++) {
    await clock.advance(500)
    await clock.settle()
  }
  expect(ran[0]).toBe('rebase')
  expect(ran).toContain('push')
  expect(files.get('R:/reg/.git/session-fleet.lock')).toBe('{}')
})
