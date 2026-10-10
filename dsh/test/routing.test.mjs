import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effortCandidates, modelFamily, ReviewUnavailableError, selectReviewerRoute } from '../routing.mjs'
import { DEFAULT_ROUTES } from '../settings.mjs'

/** A fake llm.resolveCallConfig over an explicit route table. */
function resolverFor(table) {
  return async ({ provider, model, reasoningEffort }) => {
    const efforts = table[`${provider}/${model}`]
    if (efforts === undefined) throw new Error(`unknown route ${provider}/${model}`)
    if (!efforts.includes(reasoningEffort)) throw new Error(`unsupported effort ${reasoningEffort}`)
    return { provider, model, reasoningEffort, maxTokens: 128000 }
  }
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const JAKE = resolverFor({
  'openai-codex/gpt-6-astra': ALL_EFFORTS,
  'providerproxy/gpt-6-astra': ALL_EFFORTS,
  'anthropic/claude-opus-5-5': ALL_EFFORTS,
  'providerproxy/claude-opus-5-5': ALL_EFFORTS,
})

test('family comes from the model id, not the gateway route', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'anthropic')
  assert.equal(modelFamily('gpt-6.1-sol'), 'openai')
  assert.equal(modelFamily('gpt-5.3-codex-spark'), 'openai')
  assert.equal(modelFamily('deepseek-v4-pro'), 'deepseek')
  assert.equal(modelFamily('glm-5.3-flash'), 'zhipu')
  assert.equal(modelFamily('team-chat'), 'unknown')
  assert.equal(modelFamily('claude-vs-gpt-distill'), 'unknown')
})

test('effort ladder never drops below the requested tier', () => {
  assert.deepEqual(effortCandidates('ultra'), ['max', 'xhigh'])
  assert.deepEqual(effortCandidates('xhigh'), ['xhigh', 'max'])
  assert.deepEqual(effortCandidates(undefined), ['xhigh', 'max'])
  assert.deepEqual(effortCandidates('high'), ['high', 'xhigh', 'max'])
})

test('Claude executor gets the pinned GPT reviewer at the pinned tier', async () => {
  const selection = await selectReviewerRoute({
    executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'ultra',
    routes: DEFAULT_ROUTES,
    resolve: JAKE,
  })
  assert.deepEqual(selection.route, { provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'max', maxTokens: 128000 })
  assert.equal(selection.independence, 'verified-by-host-routing')
  assert.equal(selection.requestedModelHonored, true)
})

test('GPT executor never gets the same-family pin; it is rerouted to Claude', async () => {
  const selection = await selectReviewerRoute({
    executor: { provider: 'providerproxy', model: 'gpt-6.1-sol' },
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    routes: DEFAULT_ROUTES,
    resolve: JAKE,
  })
  assert.equal(selection.route.provider, 'anthropic')
  assert.equal(selection.route.model, 'claude-opus-5-5')
  assert.equal(selection.route.reasoningEffort, 'xhigh')
  assert.equal(selection.reviewerFamily, 'anthropic')
  assert.equal(selection.requestedModelHonored, false)
})

test('an unavailable route falls through to the next cross-family route', async () => {
  const selection = await selectReviewerRoute({
    executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    routes: DEFAULT_ROUTES,
    resolve: resolverFor({ 'providerproxy/gpt-6-astra': ALL_EFFORTS }),
  })
  assert.equal(selection.route.provider, 'providerproxy')
  assert.equal(selection.route.model, 'gpt-6-astra')
})

test('a route that only supports efforts below the floor is not used', async () => {
  await assert.rejects(
    selectReviewerRoute({
      executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
      requestedModel: undefined,
      requestedEffort: 'xhigh',
      routes: [{ provider: 'openai-codex', model: 'gpt-6-astra' }],
      resolve: resolverFor({ 'openai-codex/gpt-6-astra': ['low', 'medium', 'high'] }),
    }),
    ReviewUnavailableError,
  )
})

test('only same-family routes means REVIEW_UNAVAILABLE, never a self-review', async () => {
  await assert.rejects(
    selectReviewerRoute({
      executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
      requestedModel: 'claude-opus-5-5',
      requestedEffort: 'xhigh',
      routes: [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'providerproxy', model: 'claude-sonnet-5-5' }],
      resolve: JAKE,
    }),
    (error) => {
      assert.ok(error instanceof ReviewUnavailableError)
      assert.match(error.message, /^REVIEW_UNAVAILABLE/)
      assert.match(error.message, /same family as the executor \(anthropic\)/)
      return true
    },
  )
})

test('an executor of unknown family is reviewed but marked unverified', async () => {
  const selection = await selectReviewerRoute({
    executor: { provider: 'gateway', model: 'team-chat' },
    requestedModel: 'gpt-6-astra',
    requestedEffort: 'xhigh',
    routes: DEFAULT_ROUTES,
    resolve: JAKE,
  })
  assert.equal(selection.independence, 'unverified')
  assert.equal(selection.route.model, 'gpt-6-astra')
})
