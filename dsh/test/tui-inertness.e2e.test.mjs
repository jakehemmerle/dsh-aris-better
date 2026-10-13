/**
 * aris-2cs.6 -- dsh-TUI inertness property against a real dsh-TUI (SPEC 6,
 * W-06): loading the ARIS bundle into a real dsh-TUI profile must not break
 * or alter Launchpad or chat under generated key sequences. TUI profiles in
 * throwaway HOMEs, private tmux sockets, mock model only; a plain profile
 * runs the same probes as the baseline. Presets are web-only at dsh 0.2.1,
 * so the TUI surface must stay free of preset behavior -- inert, not
 * preset-aware.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProfile, sleep, startTui } from './rig/rig.mjs'
import { startMockLlm } from './rig/mock-llm.mjs'
import { arisPatch, flattenRows, loadYaml } from './support/aris-bundle.mjs'
import { dshRoot } from './support/dsh-root.mjs'

const SEED = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED)
const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 25)
if (process.env.FC_SEED !== undefined) console.log(`[tui-inertness] FC_SEED=${process.env.FC_SEED} numRuns=${NUM_RUNS}`)

/** Markers that must never appear while the TUI is alive. */
const CRASH = /panic|fatal|EPIPE|unhandled|\[\[exited/i

/**
 * A launchpad probe: type words and require each to echo. A fixed sleep
 * raced the TUI's first-input readiness historically (the rig selftest's
 * Launchpad Enter drop), an echo deadline is the honest shape.
 */
async function launchpadSequence(tui, words) {
  const echoes = []
  for (const word of words) {
    tui.text(word)
    const deadline = Date.now() + 5000
    let echoed = false
    while (Date.now() < deadline && !(echoed = tui.capture().includes(word))) await sleep(100)
    echoes.push(echoed)
    if (!echoed) break
  }
  return echoes
}

/** Chat probe: submit a prompt, expect the mock reply on screen. */
async function chatProbe(tui, mock, prompt) {
  const before = mock.turns().length
  await tui.submit(prompt, { until: () => mock.turns().length > before })
  await tui.waitFor(/pong from mock-alpha/, { timeout: 30000 })
  return { turns: mock.turns().length, screen: tui.capture() }
}

/** One TUI scenario: mock, profile, optional bundle rows, live TUI. */
async function startTuiScenario(t, { name, bundle, script } = {}) {
  const mock = await startMockLlm({ script })
  const p = makeProfile({ kind: 'tui', mock })
  if (bundle) appendFileSync(join(p.dir, 'cordis.patch.yml'), '\n' + arisPatch())
  const tui = startTui(p)
  t.after(async () => { await tui.kill(); await mock.close(); p.dispose() })
  return { mock, profile: p, tui }
}

test('baseline: a TUI profile without the bundle types and chats normally', { timeout: 240000 }, async (t) => {
  const s = await startTuiScenario(t, { name: 'plain' })
  await s.tui.waitFor(/\S/, { timeout: 30000 }) // the TUI rendered something
  await sleep(600)
  const echoes = await launchpadSequence(s.tui, ['baseline', 'probe'])
  assert.ok(echoes.every(Boolean), 'every typed word echoes on the Launchpad: ' + JSON.stringify(echoes))
  assert.doesNotMatch(s.tui.capture(), CRASH)
  const { turns, screen } = await chatProbe(s.tui, s.mock, 'baseline chat probe')
  assert.equal(turns, 1, 'exactly one model turn')
  assert.equal(s.mock.turns()[0].model, 'mock-alpha', 'the default mock model served the chat')
  assert.doesNotMatch(screen, CRASH)
})

test('property: the ARIS-loaded TUI stays inert under generated key sequences (W-06)', { timeout: 600000 }, async (t) => {
  const s = await startTuiScenario(t, { name: 'aris-tui', bundle: true })
  await s.tui.waitFor(/\S/, { timeout: 30000 })
  await sleep(600) // historical first-input drop: settle once the frame exists

  const words = fc.array(fc.constantFrom('aris', 'inert', 'loop', 'review', 'probe', 'tab'), { minLength: 1, maxLength: 3 })
  const edits = fc.array(fc.constantFrom('BSpace', 'C-u'), { maxLength: 2 })

  let chatActive = false
  await fc.assert(
    fc.asyncProperty(words, edits, fc.boolean(), async (words, edits, submit) => {
      // Only Escape BACK from a submitted chat (verified probe: Escape on the
      // Launchpad itself opens the transverse Sessions screen, not a reset).
      if (chatActive) {
        await s.tui.keys('Escape')
        await sleep(400)
        chatActive = false
      }
      // Start each run from a clean Launchpad prompt so the echo probe sees
      // exactly this run's words.
      await s.tui.keys('C-u')
      await sleep(200)
      const echoes = await launchpadSequence(s.tui, words)
      assert.ok(echoes.every(Boolean), 'typed words echo with the bundle loaded: ' + JSON.stringify({ words, echoes }))
      for (const edit of edits) {
        s.tui.keys(edit)
        await sleep(150)
      }
      assert.doesNotMatch(s.tui.capture(), CRASH)
      if (submit) {
        const tail = words.at(-1)
        await sleep(250)
        await s.tui.submit(tail, { until: () => s.mock.turns().length > 0 })
        chatActive = true
        await s.tui.waitFor(/pong from mock-alpha/, { timeout: 30000 })
        assert.doesNotMatch(s.tui.capture(), CRASH)
      }
    }),
    { seed: SEED, numRuns: NUM_RUNS },
  )

  // The chat surface with the bundle: same model, same reply as the baseline.
  const { turns } = await chatProbe(s.tui, s.mock, 'aris inertness chat probe')
  assert.ok(turns >= 1, 'chat works with the bundle loaded')
  assert.ok(s.mock.turns().every(r => r.model === 'mock-alpha'), 'the mock default model serves every turn')

  // Inertness on the host: no ARIS error lines in the rig logs.
  const logs = s.profile.logs()
  assert.ok(!/aris.*(error|failed)|failed.*aris/i.test(logs), 'no ARIS errors in dsh logs: ' + logs.slice(-400))
})

test('the TUI profile with the bundle still composes aris-host and preset-aris', { timeout: 120000 }, async (t) => {
  const s = await startTuiScenario(t, { name: 'aris-tui-compose', bundle: true })
  const dump = await s.profile.dumpConfig()
  assert.equal(dump.status, 0, 'dump-config succeeds: ' + dump.stderr.slice(0, 300))
  // dump-config reports module paths as file URLs (see acceptance-rig), so
  // compose against the parsed row tree, like the web profile tests do.
  const rows = flattenRows(loadYaml(dshRoot(), dump.stdout))
  assert.ok(rows.find(row => row.id === 'aris-host'), 'aris-host composes in a TUI profile')
  assert.ok(rows.find(row => row.id === 'preset-aris'), 'preset-aris composes in a TUI profile')
})

