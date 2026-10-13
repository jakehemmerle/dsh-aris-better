/**
 * aris-2cs.5 -- Playwright property tests against real dsh web (SPEC 6.2-6.6,
 * W-01..W-05): fast-check generated action sequences over the ARIS preset
 * picker, the ARIS tab and the reviewer tools in a real dsh web (rig + mock
 * model), invariants after each step, FC_SEED/FC_NUM_RUNS replay, failure
 * screenshots. Presets are web-only at dsh 0.2.1, so the TUI half of
 * section 6 is the inertness suite (aris-2cs.6).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'
import {
  ARIS_ONLY_SKILLS, REVIEWER_TOOLS, assertConversationTabs, assertHero,
  assertNoErrors, mockModel, offeredTools, openArisTab, openChatTab, pickPreset,
  startScenario, submitPrompt, systemPromptOf,
} from './support/e2e-web.mjs'
import { sleep } from './rig/rig.mjs'

const SEED = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED)
const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 25)
if (process.env.FC_SEED !== undefined) console.log(`[web-properties] FC_SEED=${process.env.FC_SEED} numRuns=${NUM_RUNS}`)

const PRESETS = ['ARIS', 'Standard mode', 'PTC mode']

test('property: generated picker/tab/session sequences keep every invariant (W-01 picker+tab surface)', { timeout: 600000 }, async (t) => {
  const s = await startScenario(t, { name: 'property' })
  await s.boot()
  await assertHero(s.page, 'Standard mode')

  const actions = fc.record({
    preset: fc.option(fc.constantFrom(...PRESETS), { nil: undefined }),
    startSession: fc.boolean(),
    visitArisTab: fc.boolean(),
    backToChat: fc.boolean(),
    newSession: fc.boolean(),
  })

  await fc.assert(
    fc.asyncProperty(actions, async (action) => {
      const page = s.page
      // Restart from a clean hero so every run sees the same machine.
      await page.getByRole('button', { name: 'New session' }).first().click({ timeout: 15000 })
      await sleep(500)

      // The conversation tabs (Chat/Trajectory/ARIS) exist only inside a
      // session, so tab actions start one when needed and never run on a hero.
      let sessionStarted = false
      const ensureSession = async () => {
        if (!sessionStarted) {
          await submitPrompt(page, 'property probe ' + (action.preset ?? 'default'))
          sessionStarted = true
        }
      }

      if (action.preset !== undefined) {
        await pickPreset(page, action.preset)
        await assertHero(page, action.preset)
      }
      if (action.startSession) {
        await ensureSession()
        await assertConversationTabs(page)
      }
      if (action.visitArisTab) {
        await ensureSession()
        await openArisTab(page)
      }
      if (action.backToChat) {
        await ensureSession()
        await openChatTab(page, 'pong from')
      }
      if (action.newSession) {
        await page.getByRole('button', { name: 'New session' }).first().click({ timeout: 15000 })
        await sleep(500)
        await assertHero(page, action.preset ?? 'Standard mode')
      }
    }),
    { seed: SEED, numRuns: NUM_RUNS },
  )

  // Every session turn went to the mock default model, whatever the picker did.
  const turns = s.mock.turns()
  assert.ok(turns.length >= NUM_RUNS, 'a turn per session-starting run, got ' + turns.length)
  for (const turn of turns) assert.equal(turn.model, 'mock-alpha', 'executor model stays the rig default')
})

test('W-02: a Standard session offers no reviewer tools and no ARIS skills', { timeout: 240000 }, async (t) => {
  const s = await startScenario(t, { name: 'standard-isolation' })
  await s.boot()
  await submitPrompt(s.page, 'standard isolation probe')
  const turn = s.mock.turns().at(-1)
  assert.ok(turn, 'the turn reached the mock model')
  assert.equal(turn.model, 'mock-alpha')
  const tools = offeredTools(turn)
  for (const reviewer of REVIEWER_TOOLS) assert.ok(!tools.includes(reviewer), 'Standard must not offer ' + reviewer)
  const sys = systemPromptOf(turn)
  for (const skill of ARIS_ONLY_SKILLS) {
    assert.ok(!sys.includes(skill), 'Standard prompt must not list ARIS skill ' + skill)
  }
  await openArisTab(s.page) // the tab still renders its honest empty state
})

test('W-02: a PTC session offers no reviewer tools and no ARIS skills', { timeout: 240000 }, async (t) => {
  const s = await startScenario(t, { name: 'ptc-isolation' })
  await s.boot()
  await pickPreset(s.page, 'PTC mode')
  await assertHero(s.page, 'PTC mode')
  await submitPrompt(s.page, 'ptc isolation probe')
  const turn = s.mock.turns().at(-1)
  assert.ok(turn, 'the turn reached the mock model')
  assert.equal(turn.model, 'mock-alpha')
  const tools = offeredTools(turn)
  for (const reviewer of REVIEWER_TOOLS) assert.ok(!tools.includes(reviewer), 'PTC must not offer ' + reviewer)
  const sys = systemPromptOf(turn)
  for (const skill of ARIS_ONLY_SKILLS) {
    assert.ok(!sys.includes(skill), 'PTC prompt must not list ARIS skill ' + skill)
  }
})

/** Text of every message in one mock request, for title detection. */
function requestText(request) {
  return (request.messages ?? []).map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p?.text ?? '').join('') : '')).join('\n')
}

/**
 * A cross-family review scenario, keyed on models (not arrival order): the
 * session-title request may arrive inside turns() and, with two executor
 * hops, the order varies. The executor's first real turn calls the reviewer
 * tool; the reviewer child answers with the verdict; later executor turns
 * acknowledge.
 */
function reviewScript({ executor, reviewer }) {
  let executorTurns = 0
  return (req) => {
    if (req.title || /generate the session title/.test(requestText(req))) return { text: 'Mock title' }
    if (req.model === executor) {
      executorTurns += 1
      if (executorTurns === 1) {
        return { toolCalls: [{ name: 'mcp__codex__codex', arguments: { prompt: 'Review the draft: the catalyst yields 74%.' } }] }
      }
      return { text: 'Review recorded.' }
    }
    if (req.model === reviewer) return { text: 'Verdict: accepted (score 9/10). The draft is reproducible.' }
    return { text: 'Review recorded.' }
  }
}

/** The tool-result message that carries the metadata line and the verdict. */
function toolResultText(requests) {
  const hits = []
  for (const r of requests) {
    for (const m of r.messages ?? []) {
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => p?.text ?? '').join('') : ''
      if (m.role !== 'user' && m.role !== 'assistant' && /reviewer=|REVIEW_UNAVAILABLE/.test(text)) hits.push(text)
    }
  }
  return hits
}

test('W-03: Claude executor reviews through the GPT route with metadata and verdict', { timeout: 240000 }, async (t) => {
  const s = await startScenario(t, {
    name: 'claude-executor',
    models: [mockModel('claude-mock', 'Claude Mock'), mockModel('gpt-mock', 'GPT Mock')],
    reviewer: { routes: [{ provider: 'mock', model: 'gpt-mock' }] },
    script: reviewScript({ executor: 'claude-mock', reviewer: 'gpt-mock' }),
  })
  await s.boot()
  await pickPreset(s.page, 'ARIS')
  await assertHero(s.page, 'ARIS')
  await submitPrompt(s.page, 'review the draft please', { timeout: 120000 })

  assert.ok(s.mock.turns().some(r => r.model === 'gpt-mock'),
    'the reviewer child ran on the routed GPT-family mock model')
  const results = toolResultText(s.mock.turns())
  const meta = results.find(text => /reviewer=mock\/gpt-mock .*reviewer_family=openai .*executor=mock\/claude-mock executor_family=anthropic/.test(text))
  assert.ok(meta, 'tool result carries the metadata line, got: ' + JSON.stringify(results).slice(0, 400))
  assert.match(meta, /Verdict: accepted/, 'the child verdict is lifted into the tool result')
})

test('W-04: a GPT executor is routed to the Claude route', { timeout: 240000 }, async (t) => {
  const s = await startScenario(t, {
    name: 'gpt-executor',
    models: [mockModel('gpt-mock', 'GPT Mock'), mockModel('claude-mock', 'Claude Mock')],
    reviewer: { routes: [{ provider: 'mock', model: 'claude-mock' }] },
    script: reviewScript({ executor: 'gpt-mock', reviewer: 'claude-mock' }),
  })
  await s.boot()
  await pickPreset(s.page, 'ARIS')
  await assertHero(s.page, 'ARIS')
  await submitPrompt(s.page, 'review the draft please', { timeout: 120000 })

  const turns = s.mock.turns()
  assert.ok(turns.some(r => r.model === 'claude-mock'),
    'the reviewer child ran on the routed Claude-family mock model')
  // The executor model itself appears (turn 1 opens, and the loop re-queries
  // it with the tool result); the review hop itself must be the Claude turn.
  assert.ok(turns[0]?.model === 'gpt-mock' && turns.filter(r => r.model === 'claude-mock').length === 1,
    'one executor turn opens (gpt) and exactly one Claude child turn, got ' + JSON.stringify(turns.map(r => r.model)))
  const results = toolResultText(turns)
  const meta = results.find(text => /reviewer=mock\/claude-mock .*reviewer_family=anthropic .*executor=mock\/gpt-mock executor_family=openai/.test(text))
  assert.ok(meta, 'tool result carries the metadata line, got: ' + JSON.stringify(results).slice(0, 400))
})

test('W-05: same-family-only routes fail closed with REVIEW_UNAVAILABLE', { timeout: 240000 }, async (t) => {
  const s = await startScenario(t, {
    name: 'fail-closed',
    models: [mockModel('claude-mock', 'Claude Mock'), mockModel('gpt-mock', 'GPT Mock')],
    reviewer: { routes: [{ provider: 'mock', model: 'claude-mock' }] },
    script: reviewScript({ executor: 'claude-mock', reviewer: 'gpt-mock' }),
  })
  await s.boot()
  await pickPreset(s.page, 'ARIS')
  await assertHero(s.page, 'ARIS')
  await submitPrompt(s.page, 'review the draft please', { timeout: 120000 })

  assert.ok(!s.mock.turns().some(r => r.model === 'gpt-mock'),
    'the unused GPT model was never called: no cross-family child, no fallback')
  const results = toolResultText(s.mock.turns())
  assert.ok(results.some(text => /REVIEW_UNAVAILABLE/.test(text)),
    'the tool result fails closed with REVIEW_UNAVAILABLE, got: ' + JSON.stringify(results).slice(0, 400))
})

