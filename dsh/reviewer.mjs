/**
 * ARIS's independent reviewer, run inside dsh.
 *
 * The skills address the reviewer through the Codex MCP contract
 * (`mcp__codex__codex` to open a thread, `mcp__codex__codex-reply` to continue
 * it). This preset-scoped plugin registers native tools under those exact names
 * and arguments, so the corpus runs unmodified, but each round executes as a
 * dsh `spawn` subagent on a route from a different model family than the
 * calling agent (see routing.mjs). The reviewer is a logged, interruptible
 * child session with read-only tools unless the call asks for a writable
 * sandbox.
 */

import { hostImport } from './host-require.mjs'
import { modelFamily, selectReviewerRoute } from './routing.mjs'
import { reviewerSettings } from './settings.mjs'
import { isThreadId, loadThread, newThreadId, replayPrompt, saveThread } from './threads.mjs'

export const name = 'aris-reviewer'
export const inject = ['tools', 'subagents', 'llm']

const READ_ONLY_TOOLS = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill']
const WRITE_TOOLS = ['bash', 'pwsh', 'write', 'edit']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']

const PERSONA = 'You are an independent reviewer in the ARIS research workflow, running on the {{model}} model. '
  + 'You did not produce the work under review. Verify claims against the artifacts yourself with your tools; '
  + 'never rely on the author\'s summary. Be specific, adversarial and calibrated, and follow the output format '
  + 'the request asks for. Do not modify files unless the request explicitly asks you to. Reply with the review '
  + 'itself: it is returned verbatim to the author.'

/** @returns {string} the model-visible metadata line. */
function metadataLine(value) {
  const { reviewer, executor } = value
  return 'ARIS reviewer metadata (not part of the reviewer response): '
    + `threadId=${value.threadId} round=${value.round} `
    + `reviewer=${reviewer.provider}/${reviewer.model} effort=${reviewer.reasoningEffort} reviewer_family=${reviewer.family} `
    + `executor=${executor.provider ?? '?'}/${executor.model ?? '?'} executor_family=${executor.family} `
    + `independence=${value.independence}`
    + (value.requestedModel === undefined ? '' : ` requested_model=${value.requestedModel} requested_model_used=${value.requestedModelUsed ? 'yes' : 'no'}`)
}

/** @returns {string} the text of a child's final assistant output. */
function outputText(blocks) {
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('').trim()
}

export async function apply(ctx) {
  const [{ defineTool }, { parentAgentOptionsForDelegation }, { scopeOf }] = await Promise.all([
    hostImport('@deepseek-ai/dsh-tools'),
    hostImport('@deepseek-ai/dsh-subagent'),
    hostImport('@deepseek-ai/dsh-scope'),
  ])

  /** The calling agent's live route and family. */
  function executorOf(agent) {
    const options = parentAgentOptionsForDelegation(agent)
    return { provider: options.provider, model: options.model, family: modelFamily(options.model) }
  }

  /** Run one review round in a fresh child and record it on the thread. */
  async function runRound(exec, thread, prompt, settings) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('the ARIS reviewer must be called by an agent')
    const executor = executorOf(agent)
    if (executor.family !== 'unknown' && executor.family === thread.reviewer.family) {
      throw new Error(
        `REVIEW_UNAVAILABLE: thread ${thread.threadId} is reviewed by ${thread.reviewer.family}, `
        + `the same family as the current executor ${executor.provider}/${executor.model}. Start a new thread.`,
      )
    }

    const scope = scopeOf(agent.ctx)
    const wanted = thread.sandbox === 'read-only' ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
    const allow = wanted.filter(tool => ctx.tools.get(tool, scope) !== undefined)
    if (allow.length === 0) throw new Error('REVIEW_UNAVAILABLE: none of the reviewer\'s read tools are mounted in this preset')
    const round = thread.rounds.length + 1
    const text = round === 1 ? prompt : replayPrompt(thread, prompt)
    const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(settings.timeoutMs)])

    const { reasoningEffort, maxTokens, provider, model } = thread.reviewer
    const activation = await ctx.subagents.startActivation({
      provider: settings.subagentProvider,
      label: `ARIS review r${round}`,
      delivery: 'caller',
      signal,
      request: {
        parent: agent,
        prompt: [{ type: 'text', text }],
        ...thread.cwd === undefined ? {} : { cwd: thread.cwd },
        agentOptions: { provider, model, reasoningEffort, ...maxTokens === undefined ? {} : { maxTokens } },
        persona: PERSONA,
        // The allow-list excludes subagent, workflow and these reviewer tools, so the
        // reviewer cannot delegate or recurse; depth stays under the host setting.
        toolFilter: { allow },
      },
    })
    let result
    try {
      const aborted = Promise.withResolvers()
      const onAbort = () => aborted.reject(signal.reason ?? new Error('review aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        result = await Promise.race([activation.result, aborted.promise])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    } finally {
      await activation.dispose().catch((error) => {
        ctx.logger?.warn?.(`aris-reviewer: child dispose failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const response = outputText(result.output)
    if (result.stopReason !== 'completed' || response === '') {
      throw new Error(
        `REVIEW_UNAVAILABLE: reviewer ${provider}/${model} ended with ${result.stopReason}`
        + (result.diagnostic ? `: ${result.diagnostic}` : '') + (response === '' ? ' and no response' : ''),
      )
    }

    thread.rounds.push({ at: new Date().toISOString(), childId: activation.childId, prompt, response })
    thread.updatedAt = new Date().toISOString()
    await saveThread(settings.threadDir, thread)
    return {
      threadId: thread.threadId,
      round,
      content: response,
      reviewer: thread.reviewer,
      executor,
      independence: executor.family === 'unknown' ? 'unverified' : 'verified-by-host-routing',
      ...thread.requestedModel === undefined ? {} : { requestedModel: thread.requestedModel, requestedModelUsed: thread.requestedModelUsed },
    }
  }

  const output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string', required: true },
        round: { type: 'integer', required: true },
        content: { type: 'string', required: true },
        reviewer: { type: 'json', required: true },
        executor: { type: 'json', required: true },
        independence: { type: 'string', required: true },
        requestedModel: { type: 'string' },
        requestedModelUsed: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: `${metadataLine(value)}\n\n${value.content}` }],
  }

  const start = defineTool({
    name: 'mcp__codex__codex',
    description: 'Open an independent ARIS review thread. The reviewer runs as a dsh subagent on a model family '
      + 'different from yours, chosen by the harness; `model` is a preference that is used only when it is a '
      + 'different family and available. The result starts with a metadata line carrying the threadId and the '
      + 'actual reviewer and executor models; continue the thread with mcp__codex__codex-reply.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete review request, including absolute paths of the artifacts to review.' },
      model: { type: 'string', description: 'Preferred reviewer model id (e.g. gpt-6-astra).' },
      config: {
        type: 'object',
        additionalProperties: true,
        description: 'Codex-style options; only model_reasoning_effort is used (xhigh, ultra, max, high, ...).',
        properties: { model_reasoning_effort: { type: 'string' } },
      },
      sandbox: { type: 'string', enum: SANDBOXES, description: 'read-only (default) gives the reviewer read/search tools only.' },
      cwd: { type: 'string', description: 'Reviewer working directory; defaults to yours.' },
      'approval-policy': { type: 'string', description: 'Accepted for Codex compatibility and ignored: the session permission policy applies.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('the ARIS reviewer must be called by an agent')
      const executor = executorOf(exec.agent)
      const settings = reviewerSettings()
      const selection = await selectReviewerRoute({
        executor,
        requestedModel: args.model,
        requestedEffort: args.config?.model_reasoning_effort,
        routes: settings.routes,
        resolve: route => ctx.llm.resolveCallConfig(route, exec.signal),
      })
      const now = new Date().toISOString()
      const thread = {
        version: 1,
        threadId: newThreadId(),
        createdAt: now,
        updatedAt: now,
        sandbox: args.sandbox ?? 'read-only',
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        reviewer: { ...selection.route, family: selection.reviewerFamily },
        ...args.model === undefined ? {} : { requestedModel: args.model, requestedModelUsed: selection.requestedModelHonored },
        rounds: [],
      }
      return runRound(exec, thread, args.prompt, settings)
    },
  })

  const reply = defineTool({
    name: 'mcp__codex__codex-reply',
    description: 'Continue an ARIS review thread. The same reviewer route, effort, sandbox and working directory '
      + 'are reused, and the reviewer sees every earlier round of the thread.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The next message to the reviewer.' },
      threadId: { type: 'string', description: 'threadId from the metadata line of an earlier result.' },
      conversationId: { type: 'string', description: 'Deprecated alias of threadId.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const threadId = args.threadId ?? args.conversationId
      if (!isThreadId(threadId)) throw new Error(`unknown reviewer threadId "${threadId}"; open a thread with mcp__codex__codex`)
      const settings = reviewerSettings()
      const thread = await loadThread(settings.threadDir, threadId)
      if (thread === undefined) throw new Error(`unknown reviewer threadId "${threadId}"; open a thread with mcp__codex__codex`)
      return runRound(exec, thread, args.prompt, settings)
    },
  })

  ctx.effect(() => ctx.tools.register(start), 'ARIS reviewer: mcp__codex__codex')
  ctx.effect(() => ctx.tools.register(reply), 'ARIS reviewer: mcp__codex__codex-reply')
}
