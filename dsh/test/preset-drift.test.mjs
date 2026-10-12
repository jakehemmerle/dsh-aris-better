/**
 * The ARIS preset copies dsh's Standard preset rows. dsh has no preset
 * inheritance, so this test is what notices when an upgrade changes Standard.
 *
 * Needs the installed dsh, located by dsh-root.mjs: DSH_ROOT, the managed
 * launcher, or this package installed into a dsh profile. A missing dsh is a
 * hard failure, never a skip (aris-2cs.13).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { dshRoot } from './support/dsh-root.mjs'

const ARIS_ONLY = new Set(['persona', 'aris-skills', 'aris-reviewer', 'aris-scope-limits', 'aris-grok', 'aris-antigravity', 'tool-presentation'])

test('ARIS preset matches the installed Standard preset outside its own rows', async () => {
  const root = dshRoot()
  const require = createRequire(join(root, 'package.json'))
  const yaml = require('js-yaml')
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => ({ js: source }) })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  const load = async path => yaml.load(await readFile(path, 'utf8'), { schema })

  const standardPath = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'standard.patch.yml')
  const standard = (await load(standardPath))[0].insert[0].config.plugins
  const aris = (await load(new URL('../cordis.patch.yml', import.meta.url))).at(-1).insert.find(row => row.id === 'preset-aris').config.plugins

  const expected = standard.filter(row => !ARIS_ONLY.has(row.id))
  const actual = aris.filter(row => !ARIS_ONLY.has(row.id))
  assert.deepEqual(actual, expected, `Standard preset changed in ${standardPath}; re-copy its rows into dsh/cordis.patch.yml`)
})
