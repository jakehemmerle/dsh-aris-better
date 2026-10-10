import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadThread, newThreadId, replayPrompt, saveThread } from '../threads.mjs'

test('a thread survives a save/load round trip and unknown or hostile ids load nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'aris-threads-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const thread = { version: 1, threadId: newThreadId(), reviewer: { provider: 'openai-codex', model: 'gpt-6-astra' }, rounds: [{ prompt: 'p1', response: 'r1' }] }
  await saveThread(dir, thread)
  assert.deepEqual(await loadThread(dir, thread.threadId), thread)
  assert.equal(await loadThread(dir, newThreadId()), undefined)
  assert.equal(await loadThread(dir, '../../etc/passwd'), undefined)
  assert.deepEqual(await readdir(dir), [`${thread.threadId}.json`])
})

test('replay carries every earlier round in order, then the new message', () => {
  const prompt = replayPrompt({
    threadId: 'aris-rv-x',
    rounds: [{ prompt: 'review v1', response: 'score 4' }, { prompt: 'fixed A', response: 'score 6' }],
  }, 'fixed B')
  const order = ['review v1', 'score 4', 'fixed A', 'score 6', 'fixed B'].map(part => prompt.indexOf(part))
  assert.ok(order.every(index => index >= 0))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.match(prompt, /<new-message round="3">\nfixed B\n<\/new-message>$/)
})
