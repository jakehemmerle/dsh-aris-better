/**
 * Shared helpers for suites that compose the real ARIS bundle into a rig
 * profile: the bundle's cordis.patch.yml with this package's self-names
 * rewritten to the checkout's real files, a js-yaml loader taken from the
 * installed dsh, and row flattening for dump-config trees.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Repo root: this file lives at <root>/dsh/test/support/. */
export const ROOT = new URL('../../../', import.meta.url).pathname

/** The bundle's patch, with this package's self-names rewritten to real files. */
export function arisPatch() {
  let patch = readFileSync(join(ROOT, 'dsh', 'cordis.patch.yml'), 'utf8')
  for (const [pkg, file] of [
    ['@jakehemmerle/dsh-aris/skills', 'skills.mjs'],
    ['@jakehemmerle/dsh-aris/reviewer', 'reviewer.mjs'],
    ['@jakehemmerle/dsh-aris/scope-limits', 'scope-limits.mjs'],
    ['@jakehemmerle/dsh-aris/bridge', 'bridge.mjs'],
    ['@jakehemmerle/dsh-aris', 'index.mjs'],
  ]) patch = patch.split("'" + pkg + "'").join("'" + join(ROOT, 'dsh', file) + "'")
  assert.ok(!patch.includes('@jakehemmerle/dsh-aris'), 'every self-name was rewritten')
  return patch
}

/** Load YAML with dsh's own js-yaml (same schema dsh uses for its patches). */
export function loadYaml(root, text) {
  const require = createRequire(join(root, 'package.json'))
  const yaml = require('js-yaml')
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => ({ js: source }) })
  return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })
}

/** Every composed row, descending into group configs. */
export function flattenRows(tree, acc = []) {
  for (const entry of Array.isArray(tree) ? tree : []) {
    acc.push(entry)
    if (Array.isArray(entry?.config)) flattenRows(entry.config, acc)
  }
  return acc
}
