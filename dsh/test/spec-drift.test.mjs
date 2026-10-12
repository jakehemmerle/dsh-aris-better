/**
 * SPEC.md drift guard (aris-2cs.15): the numbers and lists SPEC states about
 * this repository are re-derived here, so the spec cannot silently diverge
 * from the corpus and the reviewer. Repo-local facts only: anything needing
 * the installed dsh lives in preset-drift.test.mjs.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BT = String.fromCharCode(96) // backtick, as used in SPEC code spans
const SPEC = () => readFileSync(join(ROOT, 'dsh', 'SPEC.md'), 'utf8')

/** Yields every file under a corpus directory. */
function* corpusFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* corpusFiles(path)
    else if (entry.isFile()) yield path
  }
}

function corpusCounts() {
  let plain = 0
  let reply = 0
  for (const dir of ['skills', 'tools', 'templates', 'mcp-servers']) {
    for (const file of corpusFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      plain += (text.match(/mcp__codex__codex(?!-reply)/g) ?? []).length
      reply += (text.match(/mcp__codex__codex-reply/g) ?? []).length
    }
  }
  return { plain, reply }
}

test('SPEC states the corpus call-site counts this repository actually has (aris-2cs.15)', () => {
  const { plain, reply } = corpusCounts()
  const pattern = new RegExp(
    'corpus calls ' + BT + 'mcp__codex__codex' + BT + ' \\((\\d+) call sites\\) and '
    + BT + 'mcp__codex__codex-reply' + BT + ' \\((\\d+)\\)',
  )
  const match = pattern.exec(SPEC())
  assert.ok(
    match,
    'SPEC.md states the corpus call-site counts as: corpus calls ' + BT + 'mcp__codex__codex' + BT
    + ' (N call sites) and ' + BT + 'mcp__codex__codex-reply' + BT + ' (M).'
    + ' Recounted from the corpus: plain=' + plain + ' reply=' + reply,
  )
  assert.equal(Number(match[1]), plain, 'mcp__codex__codex: SPEC says ' + match[1] + ', corpus has ' + plain)
  assert.equal(Number(match[2]), reply, 'mcp__codex__codex-reply: SPEC says ' + match[2] + ', corpus has ' + reply)
})

test('SPEC layout lists every module in dsh/ (aris-2cs.15)', () => {
  const spec = SPEC()
  const modules = readdirSync(join(ROOT, 'dsh')).filter(name => name !== 'test' && !name.startsWith('.') && name !== 'SPEC.md')
  assert.ok(modules.includes('run-status.mjs'))
  for (const module of modules) {
    const pattern = new RegExp('\\b' + module.replace(/[.]/g, '\\.') + '\\b')
    assert.match(spec, pattern, 'SPEC section 3.1 is missing ' + module)
  }
})

test('SPEC documents every tool list the reviewer grants (aris-2cs.15)', () => {
  const reviewer = readFileSync(join(ROOT, 'dsh', 'reviewer.mjs'), 'utf8')
  const spec = SPEC()
  for (const [constant, section] of [['READ_ONLY_TOOLS', 'read-only tools'], ['WRITE_TOOLS', 'writable-sandbox tools']]) {
    const match = new RegExp('const ' + constant + ' = \\[([^\\]]*)\\]').exec(reviewer)
    assert.ok(match, 'reviewer.mjs declares ' + constant)
    const tools = [...match[1].matchAll(/'([a-z_]+)'/g)].map(entry => entry[1])
    assert.ok(tools.length > 0, constant + ' is non-empty')
    for (const tool of tools) {
      assert.match(spec, new RegExp(BT + tool + BT), 'SPEC section 3.3 ' + section + ' must name ' + BT + tool + BT)
    }
  }
})
