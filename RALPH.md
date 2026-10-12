# Ralph loop state

Effort epic: `aris-2cs` (3 rounds). Read this file and `bd ready` at the start of every round.

## Round A (2026-10-12, "ROUND A") — DONE, reported to lead

Recovered the crashed turn's uncommitted work, then:

- 2a878c4 "5.3 FLASH: rig acceptance: ARIS bundle composes aris-host + preset-aris and
  nothing else (SPEC 6.1/6.3)" — finished the mid-write `dsh/test/acceptance-rig.test.mjs`
  (the composed row name is a `file://` URL in dump-config, not a plain path), extracted the
  shared bundle helpers to `dsh/test/support/aris-bundle.mjs`. Pushed (62c9e91..2a878c4).
- 656ce59 aris-2cs.16: aris-host row disposal — 5 unit-seam tests (publish exactly
  {settings, ARIS_REPO, run-status RPC}, withdraw exactly those, operator `ARIS_REPO` wins,
  bad config fails before effects, re-apply after dispose) + real rig lifecycle (dsh web
  boots with the bundle, stops cleanly, no ARIS error lines, profile tree fully removable).
- 418034a aris-2cs.18: `/aris` run-status projection honesty — endpoints, empty workspace,
  pass-through, malformed/array state errors verbatim, criticisms verbatim or absent,
  artifact-presence fast-check property, newest-run selection.
- 3147518 + f18fc26 aris-2cs.17: routing fast-check properties (13): family derivation
  (pattern-per-family, not per-keyword), effort ladder exactness, candidate order/pins/
  dedup/skips, purity, candidate-major × effort-minor selection (route preferred over
  effort tier), fail-closed REVIEW_UNAVAILABLE with exact attempt accounting, maxTokens
  pass-through. Seeds 20261012, 1339444460, 1665507952 all green.
- SPEC §8 written (dsh/SPEC.md): P-01..P-14 with ID+oracle+surface, W-01..W-06 listed as
  pending, §6 acceptance items mapped to IDs (closes aris-2cs.2 with the drift fixes from
  6a7f3f7/62c9e91).
- dsh/TESTING.md written (aris-2cs.7): full traceability property → test → surface →
  result, seeds/versions, honest gaps (W-01..W-06, CI, release gate).
- aris-2cs.8 mutation campaign: **caught 6/6** observable mutants planted one at a time
  (max-effort regression, same-family guard deleted, loop order swapped, ARIS_REPO cleanup
  dropped, routes validation deleted, guessed artifact existence); one equivalent mutant
  recorded (deferred parse under the eager unit seam). The loop-order mutant survived
  until the route-over-effort property was added — that red/green is f18fc26.
- Beads closed with evidence: .11 (1b62452/3f5fe36), .12 (da84de3/f2e48b8), .13 (82a1317),
  .14 (1c1b8bb), .15 (6a7f3f7/62c9e91), .2, .7, .8, .16, .17, .18. Still open: .3 (Nix env),
  .5 (Playwright web), .6 (TUI inertness), .9 (release — HELD FOR ROUND B), .10 (CI), epic.
- Full suite after everything: **56/56 green** (FC_SEED=20261012, ~2.3 s).

## Environment for running suites

- DSH_BIN=/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2/bin/dsh (NOT the
  managed wrapper — it exports real provider keys), DSH_ROOT=…/lib/node_modules/@deepseek-ai/dsh.
- Node v24.21.0; fast-check 4.10.2 in dsh/test/node_modules (gitignored; package-lock.json
  is the committed source of the test-only deps).

## Gotchas

- `dump-config` reports module paths as `file://` URLs even when the patch names plain paths.
- `modelFamily` is a boolean per family pattern, not a keyword counter: `doubao-bytedance`
  is bytedance, `claude-gpt` is unknown (single shared boundary is consumed by the first
  match — same re semantics as tools/review_gate.py).
- `bd create`/`update` here do not auto-commit (hooks unwired); commit the
  `.beads/` export deliberately.
- The test `support/` path is 3 levels under the repo root, not 2.

## Round B plan

- aris-2cs.3 Nix environment (flake.nix: package, devShell, checks, e2e app).
- aris-2cs.5 Playwright property suites over real dsh web (picker, ARIS tab, reviewer tools).
- aris-2cs.6 dsh-TUI inertness. aris-2cs.10 CI job for dsh/.
- aris-2cs.9 RELEASING.md + CHANGELOG.md; cut the release **only if** all required suites
  are green on the release target.
