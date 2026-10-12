/**
 * Fast-layer host for the preset-scoped reviewer: loads the real reviewer.mjs
 * against the real installed dsh packages (defineTool, parentAgentOptionsForDelegation,
 * scopeOf), with only the external boundaries faked: the subagent provider
 * (child runs), the LLM route resolver and the mounted-tool table.
 *
 * dsh must be present: dsh-root.mjs locates it (DSH_ROOT, the managed
 * launcher, or a profile install) and throws when it is missing — a hard
 * failure, never a skip.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dshRoot } from './dsh-root.mjs'

export { dshRoot }

/** Make @deepseek-ai/* resolvable for host-require.mjs (createRequire honours NODE_PATH globals). */
export function exposeDshModules() {
  const modules = join(dshRoot(), 'node_modules')
  const current = (process.env.NODE_PATH ?? '').split(':').filter(Boolean)
  if (!current.includes(modules)) {
    process.env.NODE_PATH = [modules, ...current].join(':')
    createRequire(import.meta.url)('node:module')._initPaths()
  }
  return modules
}

exposeDshModules()
const settingsModule = await import('../../settings.mjs')
const reviewerModule = await import('../../reviewer.mjs')

/** An agent whose live request header carries the executor route. */
export function makeAgent(provider, model) {
  const header = { config: { provider, model } }
  return {
    ctx: {},
    options: { provider, model, maxTokens: 4096 },
    session: { requestHeader: () => header },
    /** Switch the executor route (e.g. a /model change mid-thread). */
    route(nextProvider, nextModel) { header.config = { provider: nextProvider, model: nextModel } },
  }
}

/**
 * @param {object} o
 * @param {Set<string>|string[]} o.mounted - tool names the caller's scope has.
 * @param {(route) => object|Promise<object>} o.resolve - llm.resolveCallConfig (throw = rejected).
 * @param {(request, index) => {stopReason?: string, text?: string, diagnostic?: string, delayMs?: number}} [o.child]
 * @param {{provider: string, model: string}[]} o.routes
 * @param {string} o.threadDir
 */
export async function loadReviewer({ mounted, resolve, child, routes, threadDir, timeoutMs = 60000 }) {
  const mountedSet = new Set(mounted)
  const registered = new Map()
  const disposers = []
  const activations = []
  let disposed = 0
  const ctx = {
    tools: {
      get: name => (mountedSet.has(name) ? { name } : undefined),
      register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) },
    },
    llm: { resolveCallConfig: async route => resolve(route) },
    subagents: {
      async startActivation(spec) {
        const index = activations.push(spec) - 1
        const plan = (child ?? (() => ({ text: 'review ok' })))(spec, index) ?? {}
        const childId = `child-${index}`
        const result = (async () => {
          if (plan.delayMs) await new Promise(r => setTimeout(r, plan.delayMs))
          return {
            stopReason: plan.stopReason ?? 'completed',
            output: plan.text === undefined ? [] : [{ type: 'text', text: plan.text }],
            ...plan.diagnostic ? { diagnostic: plan.diagnostic } : {},
          }
        })()
        let wasDisposed = false
        return {
          childId,
          result,
          async dispose() { if (wasDisposed) throw new Error('double dispose'); wasDisposed = true; disposed += 1 },
        }
      },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    logger: { warn() {} },
  }
  const settings = settingsModule.parseReviewerSettings({ routes, threadDir, timeoutMs })
  const withdraw = settingsModule.publishReviewerSettings(settings)
  await reviewerModule.apply(ctx)
  const call = async (name, args, agent, signal = new AbortController().signal) => {
    const tool = registered.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    const value = await tool.execute(args, { agent, signal })
    return { value, text: tool.output.render(args, value).map(b => b.text).join('') }
  }
  return {
    registered, activations,
    disposedCount: () => disposed,
    start: (args, agent, signal) => call('mcp__codex__codex', args, agent, signal),
    reply: (args, agent, signal) => call('mcp__codex__codex-reply', args, agent, signal),
    unload() { while (disposers.length) disposers.pop()(); withdraw() },
  }
}
