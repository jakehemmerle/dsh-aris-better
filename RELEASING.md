# RELEASING dsh-aris-better

This plugin follows [Semantic Versioning 2.0.0](https://semver.org/) with
prerelease channels that match the DSH release the suites were qualified
against (the `new-dsh-plugin` skill's `references/release.md` is the
authoritative procedure; this file is the plugin's copy of it).

## Channel rule

- Develop against the pinned installed DSH **`0.2.1-alpha.2`** (fleet alpha
  exception, 2026-10-10; re-check `npm view @deepseek-ai/dsh dist-tags`
  before every release for a newer beta/stable).
- While qualified only against a DSH **alpha**, this plugin's version carries
  `-alpha.N`; against an RC it would carry `-rc.N`. The suffix drops only
  when the full suites pass against a stable DSH.
- The plugin's version is independent of DSH's number; the nix package
  version is derived from `package.json` (`flake.nix`).

## Version bump rules (while 0.x)

- **MINOR**: incompatible config, command, stored-state or behaviour change
  (SemVer allows these in 0.x as MINOR).
- **PATCH**: bug fix with no new capability (today's releases: DSH-level
  reviewer/effort bug fixes plus the spec-driven test system around them).

## Release gate (no bypass)

Run the complete gate in the repo's Nix environment against the pinned DSH:

1. `nix flake check` — the fast suites inside the Nix sandbox
   (`checks.fast-suite`, throwaway `HOME`, no network, mock model only).
2. Real-client suites: `nix run .#e2e` — Playwright properties against real
   dsh web (`web-properties.e2e.test.mjs`, W-01..W-05) and the dsh-TUI
   inertness property against a real dsh-TUI 0.14.0
   (`tui-inertness.e2e.test.mjs`, W-06). Recorded seeds and run counts live
   in `dsh/TESTING.md`; a failing **or skipped** required suite blocks the
   release, and every seed must be replayed, not assumed.
3. Re-run the real-client campaign for the release budget: **≥100 generated
   cases per surface spread over ≥3 recorded seeds**.

## Steps

1. Pull clean `main`; close or defer every open release-blocking bead.
2. Bump `package.json` **version** (`flake.nix` derives its package version
   from it). This plugin has no `peerDependencies`: dsh routes the plugin's
   bare `@deepseek-ai/*` imports to the loaded runtime's own packages, and
   the bundle artifacts tested are the pinned store build itself.
3. `CHANGELOG.md`: version, date, changes, the exact DSH and dsh-TUI
   versions tested, the commit tested, and the suite evidence (seeds, run
   counts, pass).
4. Commit `release: vX.Y.Z` (team prefix `5.3 FLASH: `), create the
   annotated tag `vX.Y.Z` on that commit, push the commit and the tag.
5. Consumers (nix-config) pin tagged revisions only. Local install and fleet
   rollout follow the skill's `rollout.md` — including Jake's acceptance of
   the installed revision **before** any fleet sync.

## Where the evidence lives

- `dsh/TESTING.md` — every property → test → surface → result, recorded
  seeds, mutation campaign (caught N/N), versions.
- `dsh/SPEC.md` §8 — the property IDs the evidence refers to.
- `dsh/test/artifacts/` (gitignored) — failure screenshots/page snapshots.
