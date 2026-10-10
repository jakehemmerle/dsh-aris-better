/**
 * Import `@deepseek-ai/*` modules from the running dsh.
 *
 * The bundle has no dependencies of its own: dsh packages version in lockstep
 * with the CLI. Installed into a profile they resolve through the profile's
 * module fallback; loaded by absolute path (e.g. from the Nix store) they do
 * not resolve at all. The running dsh's own entry point resolves both ways and
 * yields the exact module instances dsh itself uses, so it is tried first.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requirers = [
  ...process.argv[1] ? [createRequire(pathToFileURL(process.argv[1]))] : [],
  createRequire(import.meta.url),
]

/**
 * @param {string} specifier - bare package specifier, e.g. `@deepseek-ai/dsh-tools`.
 * @returns {Promise<any>} the module namespace.
 */
export async function hostImport(specifier) {
  const failures = []
  for (const require of requirers) {
    let resolved
    try {
      resolved = require.resolve(specifier)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    return import(pathToFileURL(resolved).href)
  }
  throw new Error(`dsh-aris: cannot resolve ${specifier} from the running dsh:\n${failures.join('\n')}`)
}
