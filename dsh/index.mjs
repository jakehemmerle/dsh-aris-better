/**
 * Host half of the ARIS bundle. Everything model-facing (skills, reviewer,
 * scope limits) lives in the `aris` agent preset; this row only does what
 * must be process-wide:
 *   1. publish the package root as ARIS_REPO so skills reach their helper scripts
 *   2. publish the reviewer settings (config.reviewer) to the preset's reviewer
 *   3. serve the ARIS tab's read-only projection of the loop artifacts
 * It is also the Loader entry through which dsh finds the package's browser half.
 */

import { fileURLToPath } from 'node:url'
import { registerRunStatus } from './run-status.mjs'
import { parseReviewerSettings, publishReviewerSettings } from './settings.mjs'

export const name = 'aris-host'

/** Package root; identical in a git checkout, under node_modules, or in the Nix store. */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

export function apply(ctx, config) {
  // Parse before any effect so a bad config fails this row's activation loudly.
  const reviewer = parseReviewerSettings(config?.reviewer)
  ctx.effect(() => publishReviewerSettings(reviewer), 'ARIS reviewer settings')

  // ARIS skills resolve shared helpers through $ARIS_REPO/tools
  // (skills/shared-references/integration-contract.md). An operator-set value wins.
  ctx.effect(() => {
    const inherited = process.env.ARIS_REPO
    if (inherited === undefined) process.env.ARIS_REPO = PACKAGE_ROOT
    return () => {
      if (inherited === undefined && process.env.ARIS_REPO === PACKAGE_ROOT) {
        delete process.env.ARIS_REPO
      }
    }
  }, 'ARIS package root')

  registerRunStatus(ctx)
}
