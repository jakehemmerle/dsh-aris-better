/**
 * Reviewer threads: the durable record behind `threadId`.
 *
 * Each review round runs in a fresh child session, so continuity lives here:
 * the route, sandbox and working directory fixed by the first call, and every
 * prior request/response pair, which the next round replays to the reviewer.
 * One JSON file per thread, replaced atomically.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const THREAD_ID = /^aris-rv-[0-9a-f-]{36}$/

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} `$DSH_HOME/aris/reviewer-threads`.
 */
export function defaultThreadDir(env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'aris', 'reviewer-threads')
}

/** @returns {string} a fresh thread id. */
export function newThreadId() {
  return `aris-rv-${randomUUID()}`
}

/** @param {unknown} id @returns {boolean} */
export function isThreadId(id) {
  return typeof id === 'string' && THREAD_ID.test(id)
}

/**
 * @param {string} dir
 * @param {{threadId: string}} thread
 */
export async function saveThread(dir, thread) {
  if (!isThreadId(thread.threadId)) throw new Error(`invalid reviewer threadId "${thread.threadId}"`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${thread.threadId}.json`)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(thread, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

/**
 * @param {string} dir
 * @param {string} threadId
 * @returns {Promise<object | undefined>} the thread, or undefined when unknown.
 */
export async function loadThread(dir, threadId) {
  if (!isThreadId(threadId)) return undefined
  let text
  try {
    text = await readFile(join(dir, `${threadId}.json`), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const thread = JSON.parse(text)
  if (thread?.threadId !== threadId || !Array.isArray(thread.rounds)) {
    throw new Error(`reviewer thread file for ${threadId} is malformed`)
  }
  return thread
}

/**
 * The prompt for round N: earlier rounds verbatim, then the new message.
 * @param {{threadId: string, rounds: {prompt: string, response: string}[]}} thread
 * @param {string} prompt - the new message.
 * @returns {string}
 */
export function replayPrompt(thread, prompt) {
  const next = thread.rounds.length + 1
  const history = thread.rounds.flatMap((round, index) => [
    `<round n="${index + 1}" role="request">\n${round.prompt}\n</round>`,
    `<round n="${index + 1}" role="your-response">\n${round.response}\n</round>`,
  ])
  return [
    `You are continuing ARIS review thread ${thread.threadId} as the same independent reviewer. `
    + 'Your earlier rounds in this thread follow, oldest first. Keep your earlier findings in mind, '
    + 're-check the artifacts yourself, and say explicitly which earlier concerns are resolved and which still stand.',
    ...history,
    `<new-message round="${next}">\n${prompt}\n</new-message>`,
  ].join('\n\n')
}
