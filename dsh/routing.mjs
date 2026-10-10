/**
 * Reviewer route selection: which provider/model/effort reviews the work.
 *
 * ARIS's invariant is that the executor never acquits itself. Here that is a
 * routing rule, not a declaration: the reviewer is the first configured route
 * whose model family differs from the executor's and that the LLM service
 * accepts at the requested effort tier. No usable route means no review.
 */

/** Family patterns, ported from tools/review_gate.py:derive_model_family. */
const FAMILY_PATTERNS = [
  ['openai', /(^|[^a-z0-9])(gpt|chatgpt|codex|oracle|o1|o3|o4)([^a-z0-9]|$)/],
  ['anthropic', /(^|[^a-z0-9])(claude|sonnet|opus|haiku|anthropic)([^a-z0-9]|$)/],
  ['google', /(^|[^a-z0-9])(gemini|google)([^a-z0-9]|$)/],
  ['deepseek', /(^|[^a-z0-9])(deepseek)[0-9.]*([^a-z0-9]|$)/],
  ['moonshot', /(^|[^a-z0-9])(kimi|moonshot)[0-9.]*([^a-z0-9]|$)/],
  ['qwen', /(^|[^a-z0-9])(qwen|tongyi)[0-9.]*([^a-z0-9]|$)/],
  ['zhipu', /(^|[^a-z0-9])(glm|zhipu)[0-9.]*([^a-z0-9]|$)/],
  ['minimax', /(^|[^a-z0-9])(minimax|abab)[0-9.]*([^a-z0-9]|$)/],
  ['xiaomi', /(^|[^a-z0-9])(mimo|xiaomi)[0-9.]*([^a-z0-9]|$)/],
  ['bytedance', /(^|[^a-z0-9])(doubao|bytedance|volcengine)[0-9.]*([^a-z0-9]|$)/],
  ['xai', /(^|[^a-z0-9])(grok)[0-9.]*([^a-z0-9]|$)/],
  ['meta', /(^|[^a-z0-9])(llama)[0-9.]*([^a-z0-9]|$)/],
  ['mistral', /(^|[^a-z0-9])(mistral|mixtral)[0-9.]*([^a-z0-9]|$)/],
]

/**
 * Model family from a model id, never from the provider route: one gateway
 * (e.g. providerproxy) serves several families.
 * @param {string | undefined} model - provider-owned model id.
 * @returns {string} the single matching family, or `unknown` for none or several.
 */
export function modelFamily(model) {
  if (typeof model !== 'string') return 'unknown'
  const name = model.trim().toLowerCase()
  const families = FAMILY_PATTERNS.filter(([, pattern]) => pattern.test(name)).map(([family]) => family)
  return families.length === 1 ? families[0] : 'unknown'
}

const ORDERED_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Efforts to try, best match first, never below the requested tier.
 * Codex's `ultra` sits above `xhigh`; dsh routes call that tier `max`.
 * An omitted effort is ARIS's regular review tier, `xhigh`.
 * @param {string | undefined} requested - `config.model_reasoning_effort` from the skill.
 * @returns {string[]} effort ids in preference order.
 */
export function effortCandidates(requested) {
  const effort = requested === undefined || requested === '' ? 'xhigh' : String(requested).toLowerCase()
  if (effort === 'ultra' || effort === 'max') return ['max', 'xhigh']
  const index = ORDERED_EFFORTS.indexOf(effort)
  if (index === -1) return [effort, 'xhigh', 'max']
  return ORDERED_EFFORTS.slice(index)
}

/** Thrown when no configured route can review this executor's work. */
export class ReviewUnavailableError extends Error {
  /** @param {string} message @param {string[]} attempts */
  constructor(message, attempts) {
    super(message)
    this.name = 'ReviewUnavailableError'
    this.attempts = attempts
  }
}

/**
 * Ordered, de-duplicated candidate routes for one review.
 * @param {object} input
 * @param {string} input.executorFamily
 * @param {string | undefined} input.requestedModel - the skill's pinned reviewer model.
 * @param {{provider: string, model: string}[]} input.routes - configured reviewer routes.
 * @returns {{candidates: {provider: string, model: string, family: string, requested: boolean}[], skipped: string[]}}
 */
export function candidateRoutes({ executorFamily, requestedModel, routes }) {
  const candidates = []
  const skipped = []
  const seen = new Set()
  const add = (provider, model, requested) => {
    const key = `${provider}/${model}`
    if (seen.has(key)) return
    seen.add(key)
    const family = modelFamily(model)
    if (family === 'unknown') {
      skipped.push(`${key}: model family unknown, independence cannot be checked`)
      return
    }
    if (executorFamily !== 'unknown' && family === executorFamily) {
      skipped.push(`${key}: same family as the executor (${family})`)
      return
    }
    candidates.push({ provider, model, family, requested })
  }
  if (typeof requestedModel === 'string' && requestedModel !== '') {
    for (const provider of new Set(routes.map(route => route.provider))) add(provider, requestedModel, true)
  }
  for (const route of routes) add(route.provider, route.model, false)
  return { candidates, skipped }
}

/**
 * Pick the reviewer route.
 * @param {object} input
 * @param {{provider?: string, model?: string}} input.executor - the calling agent's route.
 * @param {string | undefined} input.requestedModel
 * @param {string | undefined} input.requestedEffort
 * @param {{provider: string, model: string}[]} input.routes
 * @param {(config: {provider: string, model: string, reasoningEffort: string}) => Promise<unknown>} input.resolve
 *   accepts a route at an effort or throws (`llm.resolveCallConfig`).
 * @returns {Promise<{route: {provider: string, model: string, reasoningEffort: string}, reviewerFamily: string,
 *   executorFamily: string, independence: string, requestedModelHonored: boolean}>}
 * @throws {ReviewUnavailableError} when no candidate resolves.
 */
export async function selectReviewerRoute({ executor, requestedModel, requestedEffort, routes, resolve }) {
  const executorFamily = modelFamily(executor?.model)
  const { candidates, skipped } = candidateRoutes({ executorFamily, requestedModel, routes })
  const attempts = [...skipped]
  const efforts = effortCandidates(requestedEffort)
  for (const candidate of candidates) {
    for (const reasoningEffort of efforts) {
      const route = { provider: candidate.provider, model: candidate.model, reasoningEffort }
      let resolved
      try {
        resolved = await resolve(route)
      } catch (error) {
        attempts.push(`${candidate.provider}/${candidate.model}@${reasoningEffort}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      // The route's own output cap, so the child never inherits the executor's.
      const maxTokens = resolved?.maxTokens
      return {
        route: typeof maxTokens === 'number' ? { ...route, maxTokens } : route,
        reviewerFamily: candidate.family,
        executorFamily,
        independence: executorFamily === 'unknown' ? 'unverified' : 'verified-by-host-routing',
        requestedModelHonored: candidate.requested,
      }
    }
  }
  const executorLabel = executor?.model === undefined ? 'unknown executor' : `${executor.provider ?? '?'}/${executor.model} (${executorFamily})`
  throw new ReviewUnavailableError(
    `REVIEW_UNAVAILABLE: no configured reviewer route from a different model family than ${executorLabel} `
    + `accepts effort ${efforts.join('|')}. Tried:\n- ${attempts.join('\n- ') || '(no routes configured)'}`,
    attempts,
  )
}
