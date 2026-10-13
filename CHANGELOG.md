# Changelog

## 0.2.0-alpha.2 (2026-10-13)

Qualified against DSH `0.2.1-alpha.2` (the fleet's pinned alpha) and
dsh-TUI `0.14.0`; plugin commit tested: `dsh/test` + `dsh/*` sources at
`4fa7c00`. Evidence seeds and suite tables live in
[dsh/TESTING.md](dsh/TESTING.md).

### Fixed

- The ARIS tab polls a run-status RPC that mounts on dsh 0.2.1: dsh's
  `connection.rpc.handle` prefix channels are unusable from a plugin row in
  `0.2.1-alpha.2` (`webServer` is not injectable there), so the host mounts
  the projection as an exact Fetch route on the shared `/api` gateway
  (`POST /api/aris/state`) and the client calls it via
  `connection.rpc.call('/api', 'aris/state', …)`. Previously the tab showed
  `Error: transport failure for /aris/state: HTTP 405`. Unit seams, contract
  tests, real-browser suites and the SPEC now state this transport.
- Two concurrent `mcp__codex__codex-reply` calls on one reviewer thread no
  longer lose a round: load/run/save are serialized per thread
  (`dsh/reviewer.mjs`).
- An explicit `max` reasoning effort no longer drops the reviewer to
  `xhigh`: `effortCandidates('max')` is exactly `['max']` (`dsh/routing.mjs`;
  SPEC ladders say never below the requested tier).
- `host-require.mjs` resolves `@deepseek-ai/*` from the running dsh in both
  installations: the Nix package's nested `node_modules` and npm's hoisted
  layout.

### Added

- Spec-driven verification (SPEC §8 P-01..P-14): unit seams, fast-check
  property campaigns (recorded seeds in TESTING.md), real-client Playwright
  suites over `dsh web` (W-01..W-05) and a dsh-TUI inertness property
  (W-06; TUI presets are web-only at 0.2.1).
- Nix environment (`flake.nix`): `packages.default` (version derived from
  package.json, build identical to nix-config's deployment recipe),
  `packages.dsh-tui`/`packages.beads`, `devShells.default` with the pinned
  dsh/dsh-TUI, and `checks.fast-suite`; `nix run .#e2e` runs the
  real-client suites against the pinned dsh 0.2.1-alpha.2 and unpatched
  upstream dsh-TUI 0.14.0.
- GitHub Actions job (`dsh-test.yml`) running the fast suites on `main`
  and `dsh-next` with two recorded seeds; the pytest suite keeps its own
  separate workflow.
- Harness isolation hardening: XDG directories pinned into the throwaway
  rig HOME (`dsh/test/rig`), so desktop lookups never leak out of the rig.
- `RELEASING.md`: SemVer procedure with prerelease channel rules.

### Honest scope notes

- Presets are web-only at dsh 0.2.1: the TUI surface is inertness-tested
  (W-06); loading the bundle must not break or alter Launchpad or chat.
- `dsh-aris` semantics are unchanged beyond the fixes above: preset row
  composition, reviewer allowlist routing rules and skill surfaces behave
  as `dsh/SPEC.md` describes.
