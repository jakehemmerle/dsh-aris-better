/**
 * Reviewer settings, configured on the host `aris-host` row.
 *
 * dsh patches can address top-level rows by id but not rows nested inside a
 * preset, and replacing a preset's config replaces its whole plugin list. So
 * the reviewer's knobs live on the host row, which publishes them here; the
 * preset-scoped reviewer reads them at call time. Both rows load this same
 * module file, so they share one instance.
 */

import { defaultThreadDir } from './threads.mjs'

/**
 * Reviewer routes in preference order; the first cross-family one that resolves wins.
 * These are the only reviewer models: a skill's `gpt-6-astra` pin is not a route here,
 * so GPT reviews run on gpt-6.1-sol.
 */
export const DEFAULT_ROUTES = Object.freeze([
  { provider: 'openai-codex', model: 'gpt-6.1-sol' },
  { provider: 'providerproxy', model: 'gpt-6.1-sol' },
  { provider: 'anthropic', model: 'claude-opus-5-5' },
  { provider: 'providerproxy', model: 'claude-opus-5-5' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
])

/** ARIS's own threshold for calling a review hung. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/**
 * @param {unknown} config - `aris-host` config.reviewer.
 * @returns {{routes: {provider: string, model: string}[], subagentProvider: string, timeoutMs: number, threadDir: string}}
 */
export function parseReviewerSettings(config) {
  const value = config ?? {}
  const routes = value.routes ?? DEFAULT_ROUTES
  if (!Array.isArray(routes) || routes.some(route => typeof route?.provider !== 'string' || typeof route?.model !== 'string')) {
    throw new Error('aris-host: config.reviewer.routes must be a list of {provider, model}')
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('aris-host: config.reviewer.timeoutMs must be a positive integer')
  return {
    routes: routes.map(({ provider, model }) => ({ provider, model })),
    subagentProvider: value.subagentProvider ?? 'spawn',
    timeoutMs,
    threadDir: value.threadDir ?? defaultThreadDir(),
  }
}

let published

/**
 * @param {ReturnType<typeof parseReviewerSettings>} settings
 * @returns {() => void} withdraws exactly this publication.
 */
export function publishReviewerSettings(settings) {
  published = settings
  return () => {
    if (published === settings) published = undefined
  }
}

/** @returns the host row's settings, or the defaults when the host row is absent. */
export function reviewerSettings() {
  return published ?? parseReviewerSettings(undefined)
}
