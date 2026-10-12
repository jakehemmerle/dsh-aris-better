import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadThread } from '../threads.mjs'
import { loadReviewer, makeAgent } from './support/host.mjs'

// The reviewer runs on the real installed dsh (defineTool, subagent and scope
// seams); only the child sessions, the route resolver and the mounted-tool
// table are faked. See SPEC.md section 3.3 for the product contract.

const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill']
const WRITE_TOOLS = ['bash', 'pwsh', 'write', 'edit']
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]
const CLAUDE = () => makeAgent('anthropic', 'claude-opus-5-5')
const ROUTES = [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }]

/**
 * @param {object} [o]
 * @param {string[]} [o.mounted]
 * @param {(spec: object, index: number) => object} [o.child]
 */
async function harness(t, { mounted = ALL_TOOLS, child } = {}) {
  const threadDir = await mkdtemp(join(tmpdir(), 'aris-reviewer-'))
  t.after(() => rm(threadDir, { recursive: true, force: true }))
  const h = await loadReviewer({
    mounted,
    routes: ROUTES,
    threadDir,
    resolve: async () => ({ maxTokens: 4096 }),
    child: child ?? (() => ({ text: 'verdict: accept' })),
  })
  t.after(() => h.unload())
  return { h, threadDir }
}

test('registering the reviewer tools passes the host schema validation', async (t) => {
  const { h } = await harness(t)
  assert.deepEqual([...h.registered.keys()].sort(), ['mcp__codex__codex', 'mcp__codex__codex-reply'])
})

test('a read-only sandbox mounts exactly the read tools present in the caller scope', async (t) => {
  const { h } = await harness(t)
  const { value } = await h.start({ prompt: 'review the draft' }, CLAUDE())
  const allow = h.activations[0].request.toolFilter.allow
  assert.deepEqual([...allow].sort(), [...READ_TOOLS].sort())
  assert.equal(h.activations[0].request.toolFilter.deny, undefined)
  assert.equal(value.independence, 'verified-by-host-routing')
})

test('a writable sandbox adds exactly the write tools, and unmounted tools are dropped', async (t) => {
  const writable = await harness(t)
  const { value } = await writable.h.start({ prompt: 'fix and review', sandbox: 'workspace-write' }, CLAUDE())
  assert.deepEqual([...writable.h.activations[0].request.toolFilter.allow].sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort())
  assert.equal(value.independence, 'verified-by-host-routing')

  const narrow = await harness(t, { mounted: READ_TOOLS })
  await narrow.h.start({ prompt: 'fix and review', sandbox: 'danger-full-access' }, CLAUDE())
  assert.deepEqual(
    [...narrow.h.activations[0].request.toolFilter.allow].sort(),
    [...READ_TOOLS].sort(),
    'write tools outside the caller scope are dropped, never granted',
  )
})

test('the reviewer child cannot delegate, recurse or review: subagent and reviewer tools are absent', async (t) => {
  const { h } = await harness(t, { mounted: [...ALL_TOOLS, 'subagent', 'workflow', 'mcp__codex__codex'] })
  await h.start({ prompt: 'x', sandbox: 'workspace-write' }, CLAUDE())
  const allow = h.activations[0].request.toolFilter.allow
  for (const forbidden of ['subagent', 'workflow', 'mcp__codex__codex', 'mcp__codex__codex-reply']) {
    assert.equal(allow.includes(forbidden), false, forbidden)
  }
})

test('start records round 1 on disk and reply replays every earlier round', async (t) => {
  const { h, threadDir } = await harness(t, {
    child: (_spec, index) => ({ text: 'answer ' + index }),
  })
  const first = await h.start({ prompt: 'review v1' }, CLAUDE())
  assert.equal(first.value.round, 1)
  const after1 = await loadThread(threadDir, first.value.threadId)
  assert.equal(after1.rounds.length, 1)
  assert.equal(after1.rounds[0].response, 'answer 0')
  assert.equal(after1.reviewer.provider, 'openai-codex')
  assert.equal(after1.reviewer.family, 'openai')
  assert.equal(after1.sandbox, 'read-only')

  const second = await h.reply({ prompt: 're-check after the fix', threadId: first.value.threadId }, CLAUDE())
  assert.equal(second.value.round, 2)
  const after2 = await loadThread(threadDir, first.value.threadId)
  assert.equal(after2.rounds.length, 2)
  assert.equal(after2.rounds[1].prompt, 're-check after the fix')

  const round2 = h.activations[1].request.prompt.map(block => block.text).join('')
  assert.match(round2, /<round n="1" role="request">\nreview v1\n<\/round>/)
  assert.match(round2, /<round n="1" role="your-response">\nanswer 0\n<\/round>/)
  assert.match(round2, /<new-message round="2">\nre-check after the fix\n<\/new-message>/)
  // The reply reuses the thread's fixed route: same agentOptions as round 1.
  assert.deepEqual(h.activations[1].request.agentOptions, h.activations[0].request.agentOptions)
})

test('the conversationId alias opens the same thread', async (t) => {
  const { h } = await harness(t)
  const first = await h.start({ prompt: 'review v1' }, CLAUDE())
  const second = await h.reply({ prompt: 'again', conversationId: first.value.threadId }, CLAUDE())
  assert.equal(second.value.round, 2)
})

test('model-visible output starts with the metadata line the corpus parses', async (t) => {
  const { h } = await harness(t)
  const first = await h.start({ prompt: 'review v1' }, CLAUDE())
  assert.match(first.text, new RegExp(
    '^ARIS reviewer metadata \\(not part of the reviewer response\\): '
    + 'threadId=aris-rv-[0-9a-f-]{36} round=1 '
    + 'reviewer=openai-codex/gpt-6\\.1-sol effort=xhigh reviewer_family=openai '
    + 'executor=anthropic/claude-opus-5-5 executor_family=anthropic '
    + 'independence=verified-by-host-routing\\n',
  ))
  // A skill-pinned model that no route serves is reported honestly.
  const pinned = await h.start({ prompt: 'x', model: 'gpt-6-astra' }, CLAUDE())
  assert.match(pinned.text, /requested_model=gpt-6-astra requested_model_used=no/)
})

test('replying from an executor of the reviewer family fails closed (never self-review)', async (t) => {
  const { h, threadDir } = await harness(t)
  const first = await h.start({ prompt: 'review v1' }, CLAUDE())
  const threadId = first.value.threadId
  await assert.rejects(
    h.reply({ prompt: 'next round', threadId }, makeAgent('openai-codex', 'gpt-6.1-sol')),
    (error) => {
      assert.match(error.message, /^REVIEW_UNAVAILABLE/)
      assert.match(error.message, /same family/)
      return true
    },
  )
  const thread = await loadThread(threadDir, threadId)
  assert.equal(thread.rounds.length, 1, 'a rejected reply records no round')
})

test('a child that does not complete, or completes empty, is REVIEW_UNAVAILABLE', async (t) => {
  const errored = await harness(t, { child: () => ({ stopReason: 'error', diagnostic: 'boom' }) })
  await assert.rejects(errored.h.start({ prompt: 'x' }, CLAUDE()), (error) => {
    assert.match(error.message, /^REVIEW_UNAVAILABLE/)
    assert.match(error.message, /ended with error: boom/)
    return true
  })
  const empty = await harness(t, { child: () => ({ stopReason: 'completed', text: '   ' }) })
  await assert.rejects(empty.h.start({ prompt: 'x' }, CLAUDE()), /REVIEW_UNAVAILABLE.*no response/)
  // A failed start leaves no thread on disk.
  const { h, threadDir } = errored
  assert.equal(await loadThread(threadDir, h.activations[0].childId ? 'aris-rv-00000000-0000-4000-8000-000000000000' : ''), undefined)
})

test('two concurrent replies on one thread both land (aris-2cs.12)', async (t) => {
  const { h, threadDir } = await harness(t, {
    child: (_spec, index) => ({ text: 'answer ' + index, delayMs: 100 }),
  })
  const first = await h.start({ prompt: 'review v1' }, CLAUDE())
  const threadId = first.value.threadId
  const [a, b] = await Promise.all([
    h.reply({ prompt: 'concurrent A', threadId }, CLAUDE()),
    h.reply({ prompt: 'concurrent B', threadId }, CLAUDE()),
  ])
  const thread = await loadThread(threadDir, threadId)
  assert.equal(thread.rounds.length, 3, 'both concurrent rounds recorded on top of round 1')
  assert.deepEqual(
    thread.rounds.slice(1).map(round => round.prompt).sort(),
    ['concurrent A', 'concurrent B'],
    'neither reply is lost or duplicated',
  )
  assert.equal(new Set([a.value.round, b.value.round]).size, 2, 'the two replies report distinct round numbers')
})

test('unloading withdraws both tools and every effect', async (t) => {
  const threadDir = await mkdtemp(join(tmpdir(), 'aris-reviewer-'))
  t.after(() => rm(threadDir, { recursive: true, force: true }))
  const h = await loadReviewer({
    mounted: ALL_TOOLS,
    routes: ROUTES,
    threadDir,
    resolve: async () => ({}),
  })
  assert.equal(h.registered.size, 2)
  h.unload()
  assert.equal(h.registered.size, 0)
  h.unload() // idempotent
  assert.equal(h.registered.size, 0)
})
