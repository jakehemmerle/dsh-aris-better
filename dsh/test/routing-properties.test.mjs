/**
 * fast-check properties for the pure routing core (SPEC 3.3, properties
 * P-04..P-07 in SPEC section 8): what must hold for EVERY model id, effort
 * tier and route list, not just the curated examples in routing.test.mjs.
 *
 * Seeds are pinned in TESTING.md; FC_SEED/FC_NUM_RUNS override them.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import { candidateRoutes, effortCandidates, modelFamily, ReviewUnavailableError, selectReviewerRoute } from '../routing.mjs'

const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Keyword -> family, the SPEC's port of tools/review_gate.py:derive_model_family. */
const FAMILY_KEYWORDS = {
  openai: ['gpt', 'chatgpt', 'codex', 'oracle', 'o1', 'o3', 'o4'],
  anthropic: ['claude', 'sonnet', 'opus', 'haiku', 'anthropic'],
  google: ['gemini', 'google'],
  deepseek: ['deepseek'],
  moonshot: ['kimi', 'moonshot'],
  qwen: ['qwen', 'tongyi'],
  zhipu: ['glm', 'zhipu'],
  minimax: ['minimax', 'abab'],
  xiaomi: ['mimo', 'xiaomi'],
  bytedance: ['doubao', 'bytedance', 'volcengine'],
  xai: ['grok'],
  meta: ['llama'],
  mistral: ['mistral', 'mixtral'],
}
const FAMILIES = Object.keys(FAMILY_KEYWORDS)
const ALL_KEYWORDS = Object.values(FAMILY_KEYWORDS).flat()
/** Filler words containing no family keyword, so delimiting stays unambiguous. */
const FILLER = ['nova', 'core', 'spark', 'air', 'mini', 'pro', 'team', 'chat']

/** The keyword parts of a name, and how many distinct families they span. */
function keywordFamilies(name) {
  const parts = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const keywords = parts.filter(part => ALL_KEYWORDS.includes(part))
  return [...new Set(keywords.map(part => FAMILIES.find(f => FAMILY_KEYWORDS[f].includes(part))))]
}

/** A model id with exactly one delimited keyword from the given family, random case and shape. */
const singleFamilyName = (family) => fc.tuple(
  fc.option(fc.constantFrom(...FILLER), { nil: undefined }),
  fc.constantFrom(...FAMILY_KEYWORDS[family]),
  fc.option(fc.constantFrom('4', '5.5', '6.1-sol', '-v3-pro', '7-x'), { nil: undefined }),
  fc.option(fc.constantFrom(...FILLER), { nil: undefined }),
  fc.constantFrom('-', '_', '/', '@'),
  fc.boolean(),
).map(([prefix, keyword, digits, suffix, sep, shout]) => {
  const casing = shout ? keyword.toUpperCase() : keyword
  return [prefix, casing, digits, suffix].filter(Boolean).join(sep)
})

const ambiguousName = fc.tuple(
  fc.constantFrom(...ALL_KEYWORDS),
  fc.constantFrom(...FILLER), // always between the keywords: one shared separator would be consumed by the first match (see the quirk test below)
  fc.constantFrom(...ALL_KEYWORDS),
).filter(([a, b]) => {
  const fa = FAMILIES.find(f => FAMILY_KEYWORDS[f].includes(a))
  return a !== b || FAMILY_KEYWORDS[fa].length > 1 // two delimited keywords, same or different families
}).map(([a, filler, b]) => [a, filler, b].join('-'))

const keywordFreeName = fc.tuple(
  fc.option(fc.constantFrom(...FILLER), { nil: undefined }),
  fc.option(fc.constantFrom(...FILLER), { nil: undefined }),
  fc.option(fc.constantFrom('9', '1.0', 'x'), { nil: undefined }),
).filter(parts => parts.filter(Boolean).length > 0)
  .map(parts => parts.join('-'))

/** Names whose derived family is known, paired with that family. */
const knownNameArb = fc.constantFrom(...FAMILIES).chain(family => singleFamilyName(family).map(name => ({ family, name })))
/** Any generated name, known or not. */
const anyNameArb = fc.oneof(fc.constantFrom(...FAMILIES).chain(singleFamilyName), keywordFreeName, ambiguousName)

test('P-04: a model id with exactly one delimited keyword derives exactly that family', () => {
  fc.assert(fc.property(
    knownNameArb,
    ({ family, name }) => {
      assert.deepEqual(keywordFamilies(name), [family], 'generator sanity: ' + name + ' names exactly one family')
      assert.equal(modelFamily(name), family, name + ' -> ' + family)
    },
  ), { numRuns: fcNumRuns(300) })
})

test('P-04: the family is the single family the keywords name, else unknown (any shape)', () => {
  fc.assert(fc.property(
    fc.oneof(keywordFreeName, ambiguousName, fc.constantFrom(undefined, null, 42, {})),
    (value) => {
      const families = typeof value === 'string' ? keywordFamilies(value) : []
      const expected = families.length === 1 ? families[0] : 'unknown'
      assert.equal(modelFamily(value), expected, value + ' -> ' + expected)
    },
  ), { numRuns: fcNumRuns(300) })
})

test('P-04: several keywords of one family stay that family; several families are unknown', () => {
  // Family patterns match per family (boolean), not per keyword occurrence:
  // 'doubao' and 'bytedance' are two keywords of the ONE bytedance pattern.
  assert.equal(modelFamily('doubao-bytedance'), 'bytedance')
  assert.equal(modelFamily('gemini-google'), 'google')
  // Keywords naming two families never resolve (the routing.test.mjs example
  // puts a filler word between; even adjacent, two families stay unknown).
  assert.equal(modelFamily('claude-gpt'), 'unknown')
  assert.equal(modelFamily('claude-vs-gpt-distill'), 'unknown')
})

test('P-05: effort candidates are exactly the ladder from the requested tier upward', () => {
  fc.assert(fc.property(
    fc.constantFrom(...LADDER),
    fc.constantFrom('-', '_', ''),
    fc.boolean(),
    (tier, _, shout) => {
      const requested = shout ? tier.toUpperCase() : tier
      assert.deepEqual(effortCandidates(requested), LADDER.slice(LADDER.indexOf(tier)), requested)
    },
  ), { numRuns: fcNumRuns(200) })
})

test('P-05: ultra maps to max with the xhigh floor; an omitted effort is the xhigh review tier', () => {
  for (const requested of ['ultra', 'ULTRA']) {
    assert.deepEqual(effortCandidates(requested), ['max', 'xhigh'], String(requested))
  }
  for (const requested of [undefined, '']) {
    assert.deepEqual(effortCandidates(requested), ['xhigh', 'max'], String(requested))
  }
})

test('P-05: an unknown tier is offered verbatim, then the xhigh floor and max', () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z]{2,8}$/).filter(word => !LADDER.includes(word) && word !== 'ultra'),
    (junk) => assert.deepEqual(effortCandidates(junk), [junk, 'xhigh', 'max'], junk),
  ), { numRuns: fcNumRuns(100) })
})

/** Route lists over a small provider pool with generated model ids. */
const routeArb = fc.record({
  provider: fc.constantFrom('openai-codex', 'anthropic', 'providerproxy', 'deepseek-official', 'gateway-x'),
  model: anyNameArb,
})
const routesArb = fc.array(routeArb, { minLength: 0, maxLength: 6 })
const executorFamilyArb = fc.oneof(fc.constantFrom(...FAMILIES), fc.constant('unknown'))

test('P-06: candidates keep configured order, pins first, deduped, never unknown- or same-family', () => {
  fc.assert(fc.property(
    routesArb,
    executorFamilyArb,
    fc.option(fc.constantFrom(...ALL_KEYWORDS), { nil: undefined }),
    (routes, executorFamily, pinKeyword) => {
      // A pin only ever reorders: build it from a route that exists, or leave it unserved.
      const serving = pinKeyword === undefined ? undefined : routes.find(route => route.model.includes(pinKeyword))
      const requestedModel = serving?.model ?? (pinKeyword === undefined ? undefined : 'no-route-serves-this')
      const { candidates, skipped } = candidateRoutes({ executorFamily, requestedModel, routes })

      // No duplicates, and every candidate comes from the configured routes.
      const keys = candidates.map(candidate => candidate.provider + '/' + candidate.model)
      assert.equal(new Set(keys).size, keys.length, 'no duplicate candidates')
      const configured = new Set(routes.map(route => route.provider + '/' + route.model))
      for (const key of keys) assert.ok(configured.has(key), key + ' is configured')

      // Families: never the executor's, never unknown.
      for (const candidate of candidates) {
        assert.notEqual(candidate.family, 'unknown')
        if (executorFamily !== 'unknown') assert.notEqual(candidate.family, executorFamily)
        assert.equal(candidate.requested, candidate.model === requestedModel)
      }

      // Order: pins first as a group; within each group the configured order
      // is preserved (first-occurrence indices strictly increase).
      const indexOf = key => routes.findIndex(route => route.provider + '/' + route.model === key)
      const requestedFlags = candidates.map(candidate => candidate.requested)
      const increasing = list => list.every((value, i) => i === 0 || value > list[i - 1])
      const pinned = keys.filter((_, i) => requestedFlags[i]).map(indexOf)
      const unpinned = keys.filter((_, i) => !requestedFlags[i]).map(indexOf)
      assert.ok(increasing(pinned), 'pinned candidates keep the configured order')
      assert.ok(increasing(unpinned), 'unpinned candidates keep the configured order')

      // skipped + candidates partition the configured routes.
      const skippedKeys = skipped.map(line => line.slice(0, line.indexOf(':')))
      assert.equal(skippedKeys.length + keys.length, configured.size, 'every configured route is a candidate or skipped')

      // If any cross-family route with a known family exists, candidates are non-empty.
      const hasCrossFamily = routes.some((route) => {
        const family = modelFamily(route.model)
        return family !== 'unknown' && (executorFamily === 'unknown' || family !== executorFamily)
      })
      assert.equal(candidates.length > 0, hasCrossFamily)
    },
  ), { numRuns: fcNumRuns(300) })
})

test('P-06: the function is pure: same inputs, same output', () => {
  fc.assert(fc.property(routesArb, executorFamilyArb, fc.option(fc.string(), { nil: undefined }), (routes, family, pin) => {
    const a = candidateRoutes({ executorFamily: family, requestedModel: pin, routes })
    const b = candidateRoutes({ executorFamily: family, requestedModel: pin, routes })
    assert.deepEqual(a, b)
  }), { numRuns: fcNumRuns(100) })
})

test('P-06: selection tries candidate-major, effort-minor, in exactly that order', async () => {
  await fc.assert(fc.asyncProperty(
    routesArb.filter(routes => candidateRoutes({ executorFamily: 'anthropic', requestedModel: undefined, routes }).candidates.length > 0),
    fc.constantFrom(...LADDER, 'ultra'),
    async (routes, requestedEffort) => {
      const calls = []
      const selection = await selectReviewerRoute({
        executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
        requestedModel: undefined,
        requestedEffort,
        routes,
        resolve: async (route) => { calls.push(route); return {} },
      })
      const { candidates } = candidateRoutes({ executorFamily: 'anthropic', requestedModel: undefined, routes })
      const efforts = effortCandidates(requestedEffort)
      const expectedFirst = { provider: candidates[0].provider, model: candidates[0].model, reasoningEffort: efforts[0] }
      assert.deepEqual(calls, [expectedFirst], 'the first acceptable pair is taken and nothing else is tried')
      assert.deepEqual(selection.route, expectedFirst)
      assert.equal(selection.executorFamily, 'anthropic')
      assert.equal(selection.independence, 'verified-by-host-routing')
      assert.equal(selection.requestedModelHonored, false)
    },
  ), { numRuns: fcNumRuns(150) })
})

test('P-06: the route is preferred over the effort tier: candidates iterate major, efforts minor', async () => {
  await fc.assert(fc.asyncProperty(
    routesArb.filter(routes => candidateRoutes({ executorFamily: 'anthropic', requestedModel: undefined, routes }).candidates.length >= 2),
    fc.constantFrom(...LADDER, 'ultra'),
    async (routes, requestedEffort) => {
      const { candidates } = candidateRoutes({ executorFamily: 'anthropic', requestedModel: undefined, routes })
      const efforts = effortCandidates(requestedEffort)
      if (efforts.length < 2) return // single-effort requests cannot separate the orders
      const calls = []
      // candidates[0] rejects its best effort but accepts the next one; every
      // later candidate accepts anything. Route-first means candidates[0] still wins.
      const selection = await selectReviewerRoute({
        executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
        requestedModel: undefined,
        requestedEffort,
        routes,
        resolve: async (route) => {
          calls.push(route)
          const first = route.provider === candidates[0].provider && route.model === candidates[0].model
          if (first && route.reasoningEffort === efforts[0]) throw new Error('top tier unavailable for the preferred route')
          return {}
        },
      })
      assert.deepEqual(
        calls,
        [
          { provider: candidates[0].provider, model: candidates[0].model, reasoningEffort: efforts[0] },
          { provider: candidates[0].provider, model: candidates[0].model, reasoningEffort: efforts[1] },
        ],
        'the preferred route is retried at its next effort before any other route is tried',
      )
      assert.equal(selection.route.provider, candidates[0].provider)
      assert.equal(selection.route.model, candidates[0].model)
      assert.equal(selection.route.reasoningEffort, efforts[1])
    },
  ), { numRuns: fcNumRuns(150) })
})

test('P-07: selection fails closed with REVIEW_UNAVAILABLE after exactly every candidate x effort pair', async () => {
  await fc.assert(fc.asyncProperty(
    routesArb,
    fc.option(fc.constantFrom(...FAMILIES), { nil: undefined }),
    fc.constantFrom(...LADDER, 'ultra'),
    async (routes, executorFamily, requestedEffort) => {
      // Deterministic single-keyword executor for the sampled family.
      const executor2 = executorFamily === undefined
        ? { provider: 'gateway-x', model: 'team-chat' }
        : { provider: 'provider-x', model: FAMILY_KEYWORDS[executorFamily][0] }

      const calls = []
      await assert.rejects(
        selectReviewerRoute({
          executor: executor2,
          requestedModel: undefined,
          requestedEffort,
          routes,
          resolve: async (route) => { calls.push(route); throw new Error('nope') },
        }),
        (error) => {
          assert.ok(error instanceof ReviewUnavailableError)
          assert.match(error.message, /^REVIEW_UNAVAILABLE/)
          const { candidates } = candidateRoutes({ executorFamily, requestedModel: undefined, routes })
          // Routes that differ only by identity dedup to one skip (the CI
          // shrink found two identical deepseek-official/air-spark-1.0 rows).
          const uniqueRoutes = new Set(routes.map(r => r.provider + '/' + r.model)).size
          const efforts = effortCandidates(requestedEffort)
          assert.equal(calls.length, candidates.length * efforts.length, 'every pair was tried once: ' + calls.length)
          assert.equal(error.attempts.length, calls.length + (uniqueRoutes - candidates.length), 'attempts list every unique skip and every failure')
          assert.match(error.message, new RegExp(efforts.join('\|')))
          return true
        },
      )
    },
  ), { numRuns: fcNumRuns(200) })
})

test('P-07: a resolving route that only offers below-floor efforts still fails closed', async () => {
  await fc.assert(fc.asyncProperty(
    routesArb.filter(routes => candidateRoutes({ executorFamily: 'anthropic', requestedModel: undefined, routes }).candidates.length > 0),
    async (routes) => {
      await assert.rejects(
        selectReviewerRoute({
          executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
          requestedEffort: 'max',
          routes,
          resolve: async (route) => { throw new Error('effort ' + route.reasoningEffort + ' unsupported') },
        }),
        ReviewUnavailableError,
      )
    },
  ), { numRuns: fcNumRuns(100) })
})

test('P-06: the route carries the resolver maxTokens, so the child never inherits the executor cap', async () => {
  const selection = await selectReviewerRoute({
    executor: { provider: 'anthropic', model: 'claude-opus-5-5' },
    routes: [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }],
    resolve: async () => ({ maxTokens: 8192 }),
  })
  assert.equal(selection.route.maxTokens, 8192)
})

function fcNumRuns(defaultRuns) {
  const fromEnv = Number(process.env.FC_NUM_RUNS)
  return Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : defaultRuns
}