/**
 * SPEC section 6.1 (and the composition half of 6.3) against a real dsh:
 * a rig profile carrying the ARIS bundle composes aris-host and preset-aris,
 * touches nothing else (agent-default-model stays the rig's mock row), and a
 * plain profile composes none of it. The picker/turn halves of section 6 are
 * the Playwright suites (aris-2cs.5).
 */

import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { makeProfile } from './rig/rig.mjs'
import { startMockLlm } from './rig/mock-llm.mjs'
import { dshRoot } from './support/dsh-root.mjs'
import { arisPatch, flattenRows, loadYaml, ROOT } from './support/aris-bundle.mjs'

test('an ARIS web profile composes aris-host and preset-aris and changes nothing else (SPEC 6.1)', async (t) => {
  dshRoot() // hard requirement, clear message when missing
  const mock = await startMockLlm()
  const p = makeProfile({ kind: 'web', mock })
  t.after(async () => { await mock.close(); p.dispose() })
  appendFileSync(join(p.dir, 'cordis.patch.yml'), '\n' + arisPatch())

  const dump = await p.dumpConfig()
  assert.equal(dump.status, 0, 'composition succeeds: ' + dump.stderr.slice(0, 400))
  const rows = flattenRows(loadYaml(dshRoot(), dump.stdout))

  const host = rows.find(row => row.id === 'aris-host')
  // dump-config reports module paths as file URLs (plain paths in a Nix store install).
  assert.equal(host?.name, pathToFileURL(join(ROOT, 'dsh', 'index.mjs')).href)

  const preset = rows.find(row => row.id === 'preset-aris')
  assert.equal(preset?.config?.id, 'aris')
  assert.equal(preset?.config?.name, 'ARIS')
  assert.equal(preset?.config?.order, 5)
  const plugins = preset.config.plugins
  const ids = plugins.map(row => row.id)
  for (const required of ['persona', 'aris-skills', 'aris-reviewer', 'tool-presentation']) {
    assert.ok(ids.includes(required), 'preset mounts ' + required)
  }
  assert.equal(plugins.find(row => row.id === 'aris-scope-limits')?.disabled, true, 'executor-side scope limits ship disabled')
  assert.equal(plugins.find(row => row.id === 'tool-presentation')?.config?.mode, 'native')

  const defaultModel = rows.find(row => row.id === 'agent-default-model')
  assert.deepEqual(
    { provider: defaultModel?.config?.provider, model: defaultModel?.config?.model },
    { provider: 'mock', model: 'mock-alpha' },
    'the bundle adds no agent-default-model row of its own (SPEC 6.1)',
  )
})

test('a profile without the bundle composes no ARIS rows (SPEC 6.3, composition half)', async (t) => {
  dshRoot()
  const p = makeProfile({ kind: 'web' })
  t.after(() => p.dispose())
  const dump = await p.dumpConfig()
  assert.equal(dump.status, 0)
  const ids = flattenRows(loadYaml(dshRoot(), dump.stdout)).map(row => row.id)
  for (const id of ids) assert.ok(!String(id).startsWith('aris'), 'unexpected ARIS row ' + id)
})
