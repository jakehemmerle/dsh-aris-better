/**
 * The /aris run-status RPC projects the loop's durable artifacts (SPEC 3.1).
 * Honesty is the contract: what ARIS maintains is reported as it is on disk —
 * missing artifacts are absent, never guessed; a broken state file is an error
 * string shown verbatim; criticisms are lifted verbatim or not at all. The
 * handler is exercised through the inject seam registerRunStatus actually uses.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import fc from 'fast-check'
import { ARIS_RPC_ENDPOINT, ARIS_STATE_ROUTE, registerRunStatus, runStatusHandler } from '../run-status.mjs'

/**
 * Mount the RPC like a host with connection+sessions. The registration seam
 * is the Fetch route registerRunStatus actually uses; the projection tests
 * below drive the transport-free core, so a wire change cannot bend them.
 */
function mountedHandler(workspaces) {
  let route
  const sessions = { get: id => (workspaces[id] ? { header: { cwd: workspaces[id] } } : undefined) }
  const scoped = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (r) => { route = r } } },
    sessions,
  }
  registerRunStatus({ inject: (needs, fn) => { assert.deepEqual(needs, ['connection', 'sessions']); fn(scoped) } })
  return { route, core: runStatusHandler(sessions) }
}

const call = (mounted, sessionId) => (mounted.core ?? mounted)('state', { sessionId })

test('unknown endpoint and missing sessionId are structured errors, never throws', async () => {
  const { core: handler } = mountedHandler({})
  assert.deepEqual(await handler('other', {}), { ok: false, error: { code: 'UNKNOWN_ENDPOINT', message: 'unknown ARIS endpoint "other"' } })
  const noSession = await call({ core: handler }, undefined)
  assert.equal(noSession.ok, false)
  assert.equal(noSession.error.code, 'BAD_REQUEST')
  const missing = await call({ core: handler }, 'no-such-session')
  assert.deepEqual(missing, { ok: true, value: { workspace: undefined, artifacts: [] } }, 'an unknown session is an empty projection')
})

test('an empty workspace projects every artifact as absent and no state', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { ok, value } = await call(mountedHandler({ s1: workspace }), 's1')
  assert.equal(ok, true)
  assert.equal(value.workspace, workspace)
  assert.equal(value.state, undefined)
  assert.equal(value.stateError, undefined)
  assert.equal(value.pipeline, undefined)
  assert.equal(value.criticisms, undefined)
  const names = value.artifacts.map(a => a.path).sort()
  assert.deepEqual(names, [
    'review-stage/ACQUITTAL_LOG.jsonl',
    'review-stage/AUTO_REVIEW.md',
    'review-stage/REVIEWER_MEMORY.md',
    'review-stage/REVIEW_STATE.json',
  ], 'every artifact ARIS maintains is listed')
  for (const artifact of value.artifacts) assert.equal(artifact.exists, false, artifact.path + ' is reported absent, never guessed')
})

test('a valid REVIEW_STATE.json passes through and artifacts report existence with size', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const state = { round: 3, verdict: 'revise', score: 7, extra: 'kept' }
  await mkdir(join(workspace, 'review-stage'), { recursive: true })
  await writeFile(join(workspace, 'review-stage/REVIEW_STATE.json'), JSON.stringify(state))
  await writeFile(join(workspace, 'review-stage/AUTO_REVIEW.md'), 'body')
  const { value } = await call(mountedHandler({ s: workspace }), 's')
  assert.deepEqual(value.state, state, 'the state file passes through untouched')
  const stateArtifact = value.artifacts.find(a => a.path.endsWith('REVIEW_STATE.json'))
  assert.equal(stateArtifact.exists, true)
  assert.equal(stateArtifact.size, JSON.stringify(state).length)
  const missing = value.artifacts.find(a => a.path.endsWith('ACQUITTAL_LOG.jsonl'))
  assert.equal(missing.exists, false)
})

test('a malformed state file surfaces an error string, never a guess', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'review-stage'), { recursive: true })
  await writeFile(join(workspace, 'review-stage/REVIEW_STATE.json'), '{not json')
  const { value } = await call(mountedHandler({ s: workspace }), 's')
  assert.equal(value.state, undefined)
  assert.match(value.stateError, /REVIEW_STATE\.json is not valid JSON/)
})

test('for any body, a JSON-array or non-object state file is also a stateError', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'review-stage'), { recursive: true })
  await writeFile(join(workspace, 'review-stage/REVIEW_STATE.json'), '[1,2]')
  const { value } = await call(mountedHandler({ s: workspace }), 's')
  assert.match(value.stateError, /is not a JSON object/)
})

test('criticisms are lifted verbatim from the latest Key criticisms block, or absent', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'review-stage'), { recursive: true })
  await writeFile(join(workspace, 'review-stage/AUTO_REVIEW.md'), [
    '# Round 2',
    '## Scores',
    '- Key criticisms',
    '   1. The proof of lemma 2 is incomplete.',
    '   2.  Baseline numbers are not reproducible.',
    '',
    'later prose that is not a numbered item',
  ].join('\n'))
  const { value } = await call(mountedHandler({ s: workspace }), 's')
  assert.deepEqual(value.criticisms, ['The proof of lemma 2 is incomplete.', 'Baseline numbers are not reproducible.'])

  await writeFile(join(workspace, 'review-stage/AUTO_REVIEW.md'), 'no block here')
  const { value: none } = await call(mountedHandler({ s: workspace }), 's')
  assert.equal(none.criticisms, undefined, 'a log without the block yields nothing')
})

test('property: artifacts on disk are exactly the reported-existing ones (missing or present, never guessed)', async (t) => {
  const ARTIFACTS = ['review-stage/REVIEW_STATE.json', 'review-stage/AUTO_REVIEW.md', 'review-stage/REVIEWER_MEMORY.md', 'review-stage/ACQUITTAL_LOG.jsonl']
  await fc.assert(
    fc.asyncProperty(
      fc.set(fc.constantFrom(...ARTIFACTS), { minLength: 0, maxLength: ARTIFACTS.length }),
      fc.option(fc.constantFrom('deepseek-official', 'anthropic'), { nil: undefined }),
      async (present, executor) => {
        const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-p-'))
        try {
          await mkdir(join(workspace, 'review-stage'))
          for (const relative of present) await writeFile(join(workspace, relative), 'x')
          const run = {
            run_id: 'r1', updated: 'T2', executor_model: executor, executor_family: 'anthropic',
            phases: [{ phase: 'plan', status: 'done', artifact: 'plan.md', reviewer: 'gpt', review_independence: 'verified-by-host-routing', verdict_id: 'v1' }],
          }
          if (executor !== undefined) await mkdir(join(workspace, '.aris', 'runs'), { recursive: true })
          if (executor !== undefined) await writeFile(join(workspace, '.aris/runs/run.json'), JSON.stringify(run))
          const { value } = await call(mountedHandler({ s: workspace }), 's')
          const reported = value.artifacts.filter(a => a.exists).map(a => a.path).sort()
          assert.deepEqual(reported, [...present].sort())
          if (executor !== undefined) {
            assert.equal(value.pipeline.runId, 'r1')
            assert.equal(value.pipeline.executor, executor)
            assert.equal(value.pipeline.phases[0].status, 'done', 'phase status passes through as stored')
          } else {
            assert.equal(value.pipeline, undefined)
          }
        } finally {
          await rm(workspace, { recursive: true, force: true })
        }
      },
    ),
    { numRuns: 25 },
  )
})

test('the newest pipeline run wins and unparseable runs are skipped', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, '.aris', 'runs'), { recursive: true })
  await writeFile(join(workspace, '.aris/runs/old.json'), JSON.stringify({ run_id: 'old', updated: 'T1', phases: [{ phase: 'plan', status: 'done' }] }))
  await writeFile(join(workspace, '.aris/runs/broken.json'), '{oops')
  await writeFile(join(workspace, '.aris/runs/not-an-object.json'), '"x"')
  await writeFile(join(workspace, '.aris/runs/new.json'), JSON.stringify({ run_id: 'new', updated: 'T2', phases: [{ phase: 'review', status: 'accepted', reviewer: 'gpt' }] }))
  const { value } = await call(mountedHandler({ s: workspace }), 's')
  assert.equal(value.pipeline.runId, 'new')
  assert.deepEqual(value.pipeline.phases, [{ phase: 'review', status: 'accepted', artifact: undefined, reviewer: 'gpt', reviewerFamily: undefined, independence: undefined, verdictId: undefined }])
})

/** The registered route, driven through a wire-shaped POST. */
async function wire(route, method, payload, headers = { 'content-type': 'application/json' }) {
  return route.fetch(new Request('http://dsh.internal' + ARIS_STATE_ROUTE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: 'w1', method, payload }),
  }))
}

test('wire contract: one exact POST route on the shared /api gateway', () => {
  const { route } = mountedHandler({})
  assert.equal(route.path, ARIS_STATE_ROUTE)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('wire: the canonical client-request envelope frames the core projection', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aris-rs-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { route } = mountedHandler({ s: workspace })
  const res = await wire(route, ARIS_RPC_ENDPOINT, { sessionId: 's' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'w1')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.workspace, workspace)
  assert.deepEqual(body.result.value.artifacts.map(a => a.exists), [false, false, false, false])
})

test('wire: foreign methods and envelopes fail with the rpcFetchHandler shapes', async () => {
  const { route } = mountedHandler({})
  const badType = await wire(route, ARIS_RPC_ENDPOINT, {}, { 'content-type': 'text/plain' })
  assert.equal(badType.status, 415)
  // An envelope-consistent request with no sessionId fails at the core: its
  // own BAD_REQUEST, framed with the wire's details record.
  const body = await wire(route, ARIS_RPC_ENDPOINT, {}, { 'content-type': 'application/json' })
  const envelope = await body.json()
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error.code, 'BAD_REQUEST')
  assert.deepEqual(envelope.result.error.details, {}, 'the wire frames every core failure with a details record')
  const foreign = await wire(route, 'other', { sessionId: 's' })
  assert.equal((await foreign.json()).result.error.code, 'gateway/bad-request')
})
