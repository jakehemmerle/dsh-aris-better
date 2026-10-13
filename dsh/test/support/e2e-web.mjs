/**
 * Shared helpers for the Playwright web suites (aris-2cs.5): boot a rig web
 * profile carrying the ARIS bundle, drive the real client UI, and capture
 * failure artifacts. Real dsh web + mock model only; every HOME/DSH_HOME is
 * the rig's throwaway.
 */

import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { makeProfile, startWeb, sleep } from '../rig/rig.mjs'
import { startMockLlm } from '../rig/mock-llm.mjs'
import { arisPatch, ROOT } from './aris-bundle.mjs'

/** Where failure screenshots and page snapshots land (gitignored). */
export const ARTIFACTS = join(ROOT, 'dsh', 'test', 'artifacts')

/** Skills that only the ARIS corpus ships; their absence marks a non-ARIS session. */
export const ARIS_ONLY_SKILLS = ['auto-review-loop', 'arxiv', 'claims-drafting']

/** Reviewer tools only the ARIS preset grants. */
export const REVIEWER_TOOLS = ['mcp__codex__codex', 'mcp__codex__codex-reply']

/**
 * A mock model entry that accepts the reviewer's reasoning efforts: the pi-ai
 * provider resolves a model's thinking capability from its declared
 * `reasoningEfforts`, and an undeclared map means no reasoning, which the
 * router rightly rejects (P-05/P-07 effort ladder).
 */
export function mockModel(id, name) {
  return {
    id, name, contextWindow: 128000, maxTokens: 8000, input: ['text'],
    reasoningEfforts: { off: null, high: 'high', xhigh: 'xhigh', max: 'max' },
  }
}

/**
 * One web scenario: mock model, rig profile with the ARIS bundle, workspace
 * Documents pinned inside the rig, browser page. `models` and `reviewer`
 * shape the executor and reviewer routing (see dsh/settings.mjs).
 */
export async function startScenario(t, { name, models, reviewer, script } = {}) {
  const mock = await startMockLlm({ script })
  const p = makeProfile({
    kind: 'web',
    mock,
    ...(models ? { models } : {}),
  })
  appendFileSync(join(p.dir, 'cordis.patch.yml'), '\n' + arisPatch())
  // Pin the Documents dir so the default workspace auto-creates inside the
  // rig home (dsh-api-workspace-controller config.documentsDirectory).
  appendFileSync(join(p.dir, 'cordis.patch.yml'),
    '\n- id: workspace-controller\n  config:\n    documentsDirectory: ' + p.home + '\n')
  if (reviewer) {
    // The host row's config.reviewer tunes the reviewer (dsh/settings.mjs):
    // a patch addresses the top-level aris-host row by id and merges config.
    appendFileSync(join(p.dir, 'cordis.patch.yml'),
      '\n- id: aris-host\n  config:\n    reviewer:\n      routes:\n'
      + reviewer.routes.map(r => '        - provider: ' + r.provider + '\n          model: ' + r.model).join('\n') + '\n')
  }
  const web = await startWeb(p)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    await web.stop().catch(() => {})
    await mock.close().catch(() => {})
    p.dispose()
  }
  t.after(cleanup)

  /** Navigate and get past the once-per-home Preview Notice modal. */
  return {
    mock, profile: p, web, page,
    async boot() {
      await page.goto(web.url, { waitUntil: 'networkidle' })
      await sleep(800)
      const cont = page.getByRole('button', { name: 'Continue' })
      if (await cont.count()) { await cont.first().click({ timeout: 8000 }); await sleep(500) }
      await sleep(400)
    },
    async capture(nameSuffix, error) {
      mkdirSync(ARTIFACTS, { recursive: true })
      const stamp = join(ARTIFACTS, name + '-' + nameSuffix + '-' + Date.now())
      await page.screenshot({ path: stamp + '.png', fullPage: true }).catch(() => {})
      writeFileSync(stamp + '.txt', 'error: ' + String(error) + '\n\n' + await page.evaluate(() => document.body.innerText).catch(() => ''))
      return stamp
    },
  }
}

/** Invariant: no error toast and no crash banner is on screen. */
export async function assertNoErrors(page) {
  const alerts = await page.locator('[role=alert]').allTextContents().catch(() => [])
  for (const text of alerts) {
    assert.match(text, /default workspace|saved|copied/i, 'unexpected error toast: ' + text)
  }
  const body = await page.evaluate(() => document.body.innerText)
  assert.doesNotMatch(body, /Something went wrong|Unhandled|EPIPE/i, 'crash banner on screen')
}

/** The new-session hero: the preset seat is present with the given label. */
export async function assertHero(page, seatLabel) {
  const seat = page.locator('button.cubgiG_seat').first()
  const label = ((await seat.textContent({ timeout: 8000 }).catch(() => null)) ?? '').trim()
  assert.equal(label, seatLabel, 'preset seat label')
  await assertNoErrors(page)
}

/** Open the preset picker and pick a preset by its menu label prefix. */
export async function pickPreset(page, labelPrefix) {
  await page.locator('button.cubgiG_seat').first().click({ timeout: 8000 })
  const item = page.getByRole('menuitem', { name: new RegExp('^' + labelPrefix) }).first()
  await item.waitFor({ state: 'visible', timeout: 8000 })
  const text = ((await item.textContent()) ?? '').trim()
  await item.click({ timeout: 8000 })
  await sleep(400)
  return text
}

/** Send one prompt from the composer and wait for the turn to complete. */
export async function submitPrompt(page, text, { timeout = 60000 } = {}) {
  const input = page.locator('[data-composer-input]').last()
  await input.focus({ timeout: 10000 })
  await page.keyboard.type(text, { delay: 15 })
  await sleep(250)
  await page.keyboard.press('Enter')
  // Completed marker in the transcript; generous for two model hops.
  await page.getByText(/Completed in \d/).first().waitFor({ state: 'visible', timeout })
  await sleep(600)
}

/** The conversation tabs every session carries; ARIS is the plugin tab. */
export async function assertConversationTabs(page) {
  for (const label of ['Chat', 'Trajectory', 'ARIS']) {
    const tab = page.getByText(label, { exact: true }).first()
    assert.ok(await tab.isVisible({ timeout: 8000 }).catch(() => false), 'conversation tab visible: ' + label)
  }
  await assertNoErrors(page)
}

/** Open the ARIS tab; the view must render one of its honest states. */
export async function openArisTab(page) {
  await page.getByText('ARIS', { exact: true }).first().click({ timeout: 8000 })
  const view = page.locator('.aris-view').first()
  assert.ok(await view.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false),
    'ARIS tab renders its view')
  const text = await view.textContent()
  assert.match(text, /Reading run artifacts|This session has no workspace|No review-stage\/REVIEW_STATE\.json yet|Reviewer independence|Artifacts/,
    'ARIS tab shows a known honest state, got: ' + text.slice(0, 200))
  await assertNoErrors(page)
  return text
}

/** Back to Chat; the transcript is still there. */
export async function openChatTab(page, expectText) {
  await page.getByText('Chat', { exact: true }).first().click({ timeout: 8000 })
  await sleep(400)
  if (expectText) {
    assert.ok(await page.getByText(expectText).first().isVisible({ timeout: 8000 }).catch(() => false),
      'Chat still shows ' + JSON.stringify(expectText))
  }
  await assertNoErrors(page)
}

/** System prompt of the n-th non-title model request (wire-level oracle). */
export function systemPromptOf(request) {
  return (request.messages ?? []).filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
}

/** Every tool name the request offered the model. */
export function offeredTools(request) {
  return (request.tools ?? []).map(t => t.function?.name).filter(Boolean)
}

