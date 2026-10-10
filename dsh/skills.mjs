/**
 * Mount the ARIS skill corpus into the preset that declares this row.
 *
 * Bundled rank (600): a project or user skill with the same name wins.
 * The path is resolved here because the declarative layer cannot locate the
 * package when it is loaded by absolute path.
 */

import { fileURLToPath } from 'node:url'
import { hostImport } from './host-require.mjs'

export const name = 'aris-skills'
export const inject = ['skills']

const SKILL_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

export async function apply(ctx) {
  const skillFilesystem = await hostImport('@deepseek-ai/dsh-skill-filesystem')
  await ctx.plugin(skillFilesystem, {
    providerName: 'aris',
    includeDefaultRoots: false,
    bundledSkillDir: SKILL_ROOT,
    watch: false,
  })
}
