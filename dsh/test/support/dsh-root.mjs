/**
 * Locate the installed @deepseek-ai/dsh package directory, or fail loudly.
 *
 * Order: $DSH_ROOT -> the vendored rig's installed-launcher probe -> resolving
 * the package from this checkout's location (works when the plugin is
 * installed into a dsh profile's node_modules). A missing dsh is a hard
 * failure, never a skip: every suite here is a required suite (aris-2cs.13).
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { paths } from '../rig/rig.mjs'

export function dshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    paths().dshRoot,
    (() => {
      try {
        return dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
      } catch {
        return undefined
      }
    })(),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'package.json'))) return root
  }
  throw new Error(
    'dsh not found: set DSH_ROOT to the @deepseek-ai/dsh package directory'
    + ' (e.g. <prefix>/lib/node_modules/@deepseek-ai/dsh; nix develop sets it),'
    + ' or run the suite where the managed dsh launcher is installed',
  )
}
