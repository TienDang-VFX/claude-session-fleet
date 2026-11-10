// node --test codex/fleet-hook.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { needsPerson, nextState } from './fleet-hook.mjs'

test('a "Needs you" line decides, nothing means no', () => {
  assert.equal(needsPerson('Done.\n\nNeeds you: nothing (anh Tiến: review và merge 4 PR trên)'), false)
  assert.equal(needsPerson('Done.\n**Needs you:** approve the merge of #37160'), true)
  assert.equal(needsPerson('Xong.\nNeeds you: không'), false)
})

test('without that line, a closing question waits for the person', () => {
  assert.equal(needsPerson('Tiến có muốn mình trả lời xác nhận ngay trong thread đó không?'), true)
  assert.equal(needsPerson('Mình đã kiểm tra lại lúc 13:36. Mình chưa approve hay merge PR nào.'), false)
  assert.equal(needsPerson(''), false)
})

test('events move the thread between working, waiting and idle', () => {
  assert.equal(nextState('UserPromptSubmit', {}, 'idle'), 'working')
  assert.equal(nextState('PermissionRequest', {}, 'working'), 'waiting')
  assert.equal(nextState('PostToolUse', {}, 'waiting'), 'working')
  assert.equal(nextState('PreToolUse', {}, 'working'), undefined)
  assert.equal(nextState('Stop', { last_assistant_message: 'Needs you: pick a branch name' }, 'working'), 'waiting')
  assert.equal(nextState('Stop', { last_assistant_message: 'All done.' }, 'working'), 'idle')
  assert.equal(nextState('SessionEnd', {}, 'waiting'), 'idle')
})
