/**
 * The aris-host row is process-wide (SPEC 3.1), so its teardown matters: dsh
 * disposes host rows on shutdown and on config reload, and anything the row
 * leaked would survive into the next composition. The apply/dispose contract
 * is tested at the unit seam (recording ctx) and the real lifecycle on the
 * rig: dsh web boots with the bundle, stops cleanly, and leaves the profile
 * tree fully removable (SPEC 6.1, disposal half).
 */

import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.mjs'
import { DEFAULT_ROUTES, reviewerSettings } from '../settings.mjs'
import { ARIS_RPC_CHANNEL } from '../run-status.mjs'
import { makeProfile, startWeb } from './rig/rig.mjs'
import { startMockLlm } from './rig/mock-llm.mjs'
import { dshRoot } from './support/dsh-root.mjs'
import { arisPatch, ROOT } from './support/aris-bundle.mjs'

/** index.mjs publishes its package root (the repo), one level above dsh/. */
const PACKAGE_ROOT = ROOT

/**
 * A recording stand-in for the host ctx: effects register and keep their
 * dispose functions, inject callbacks see a fake connection/sessions scope
 * whose rpc.handle records channels. disposeAll() runs dsh's LIFO teardown.
 */
function recordingCtx() {
  const effects = []
  const injections = []
  const rpcHandlers = new Map()
  const keep = (fn, label) => {
    const dispose = fn()
    effects.push({ label, dispose: typeof dispose === 'function' ? dispose : undefined })
  }
  const connection = {
    rpc: {
      handle(channel, handler) {
        rpcHandlers.set(channel, handler)
        return () => rpcHandlers.delete(channel)
      },
    },
  }
  const sessions = { get: () => undefined }
  return {
    effects, injections, rpcHandlers,
    ctx: {
      effect: keep,
      inject(needs, fn) {
        injections.push([...needs])
        fn({ effect: keep, connection, sessions })
      },
    },
    labels: () => effects.map(entry => entry.label),
    disposeAll() { while (effects.length) effects.pop().dispose?.() },
  }
}

test('apply publishes exactly the reviewer settings, ARIS_REPO and the run-status RPC', () => {
  const routes = [{ provider: 'gateway', model: 'gpt-6.1-sol' }]
  const h = recordingCtx()
  delete process.env.ARIS_REPO
  try {
    apply(h.ctx, { reviewer: { routes } })
    assert.deepEqual(h.labels(), ['ARIS reviewer settings', 'ARIS package root', 'ARIS run-status RPC'])
    assert.deepEqual(h.injections, [['connection', 'sessions']])
    assert.deepEqual(reviewerSettings().routes, routes, 'the configured routes are live for the preset reviewer')
    assert.equal(process.env.ARIS_REPO, PACKAGE_ROOT)
    assert.ok(h.rpcHandlers.has(ARIS_RPC_CHANNEL), 'the /aris channel is mounted')
  } finally {
    h.disposeAll()
  }
})

test('dispose withdraws everything: env restored, settings back to defaults, RPC unmounted', () => {
  const h = recordingCtx()
  delete process.env.ARIS_REPO
  try {
    apply(h.ctx, {})
    h.disposeAll()
    assert.equal(process.env.ARIS_REPO, undefined, 'ARIS_REPO set by the row is deleted again')
    assert.deepEqual(reviewerSettings().routes, DEFAULT_ROUTES, 'settings fall back to the defaults')
    assert.equal(h.rpcHandlers.size, 0, 'the run-status handler is withdrawn')
  } finally {
    delete process.env.ARIS_REPO
  }
})

test('an operator-set ARIS_REPO wins and survives disposal untouched', () => {
  const h = recordingCtx()
  process.env.ARIS_REPO = '/operator/aris'
  try {
    apply(h.ctx, {})
    assert.equal(process.env.ARIS_REPO, '/operator/aris', 'the row never overrides an operator value')
    h.disposeAll()
    assert.equal(process.env.ARIS_REPO, '/operator/aris', 'disposal deletes only what the row set')
  } finally {
    delete process.env.ARIS_REPO
  }
})

test('a bad config fails activation before any effect lands', () => {
  const h = recordingCtx()
  delete process.env.ARIS_REPO
  try {
    assert.throws(() => apply(h.ctx, { reviewer: { routes: 'nope' } }), /routes must be a list/)
    assert.equal(h.effects.length, 0, 'no effects registered')
    assert.equal(process.env.ARIS_REPO, undefined)
    assert.equal(h.rpcHandlers.size, 0)
  } finally {
    delete process.env.ARIS_REPO
  }
})

test('the row can be applied again after disposal (config reload)', () => {
  const h = recordingCtx()
  delete process.env.ARIS_REPO
  try {
    apply(h.ctx, {})
    h.disposeAll()
    apply(h.ctx, { reviewer: { timeoutMs: 5 } })
    assert.equal(reviewerSettings().timeoutMs, 5)
    assert.equal(process.env.ARIS_REPO, PACKAGE_ROOT)
    h.disposeAll()
    assert.equal(process.env.ARIS_REPO, undefined, 'second disposal is clean too')
  } finally {
    delete process.env.ARIS_REPO
  }
})

test('the real host row loads and unloads cleanly on dsh web (rig lifecycle)', async (t) => {
  dshRoot()
  const mock = await startMockLlm()
  const p = makeProfile({ kind: 'web', mock })
  t.after(async () => { await mock.close(); p.dispose() })
  appendFileSync(join(p.dir, 'cordis.patch.yml'), '\n' + arisPatch())

  const web = await startWeb(p)
  t.after(() => web.stop())
  const page = await web.fetch('/')
  assert.equal(page.status, 200, 'the profile with the ARIS bundle serves the web app')

  await web.stop()
  const arisErrors = p.logs().split('\n').filter(line => /aris/i.test(line) && /error|fail|cannot|throw/i.test(line))
  assert.deepEqual(arisErrors, [], 'no ARIS error lines in the dsh logs')
  // p.dispose() in t.after is the hard teardown assertion: it throws while any
  // file of the profile tree is still held or left behind.
})