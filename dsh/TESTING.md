# TESTING.md — dsh/ verification traceability

Every SPEC §8 property maps to at least one test below. Required suites never
skip: a missing dsh is a hard failure (aris-2cs.13). Last full run: **56/56
green, 2026-10-12, FC_SEED=20261012** (see Versions).

## How to run

```sh
export DSH_BIN=/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2/bin/dsh
export DSH_ROOT=/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2/lib/node_modules/@deepseek-ai/dsh
cd dsh/test && node --test          # full suite (~2.3 s)
FC_SEED=20261012 node --test        # pinned fast-check seeds
FC_NUM_RUNS=25 node --test          # shrink the property budget for quick loops
```

Use the store `dsh` directly, not the managed launcher wrapper: the wrapper
exports real provider keys into the environment. The rig isolates `HOME`,
`DSH_HOME`, ports and tmux sockets, and model calls go to the in-process mock.

## Property → test → surface → last result

| Property | Test file | Level / surface | Last result |
|---|---|---|---|
| P-01 | `test/acceptance-rig.test.mjs` — "an ARIS web profile composes aris-host and preset-aris and changes nothing else (SPEC 6.1)" | rig, real `dsh --dump-config` | green (2a878c4) |
| P-02 | `test/acceptance-rig.test.mjs` — "a profile without the bundle composes no ARIS rows (SPEC 6.3)" | rig, real `dsh --dump-config` | green (2a878c4) |
| P-03 | `test/preset-drift.test.mjs` — "ARIS preset matches the installed Standard preset outside its own rows" | contract vs installed `standard.patch.yml` | green (82a1317; fails loudly without dsh) |
| P-04 | `test/routing.test.mjs` (examples) + `test/routing-properties.test.mjs` (P-04 ×3) | unit | green (3147518) |
| P-05 | `test/routing.test.mjs` (examples, incl. aris-2cs.11) + `test/routing-properties.test.mjs` (P-05 ×3) | unit | green (3147518) |
| P-06 | `test/routing-properties.test.mjs` (order/dedup/skip, purity, route-over-effort, maxTokens) + `test/routing.test.mjs` (pin honouring, fallthrough) | unit properties + contract | green (f18fc26) |
| P-07 | `test/routing-properties.test.mjs` (fail-closed ×2) + `test/routing.test.mjs` (below-floor, same-family-only) + `test/reviewer.test.mjs` (reply-time guard) | unit properties + contract | green (3147518) |
| P-08 | `test/reviewer.test.mjs` — schema validation, read-only/writable tool sets, narrow-scope dropping, no delegation/recursion | contract on real dsh seams | green (1c1b8bb) |
| P-09 | `test/threads.test.mjs` (round trip, hostile ids, replay order) + `test/reviewer.test.mjs` (round recording, replay blocks, alias) | unit + contract | green (e3f7135, 1c1b8bb) |
| P-10 | `test/reviewer.test.mjs` — "model-visible output starts with the metadata line the corpus parses" | contract | green (1c1b8bb) |
| P-11 | `test/host-disposal.test.mjs` — 5 unit-seam tests (publish, withdraw, operator env, bad config, re-apply) + rig web lifecycle | unit seam + rig (real dsh web) | green (656ce59) |
| P-12 | `test/run-status.test.mjs` — endpoints, empty workspace, pass-through, malformed state, array state, criticisms, artifact presence property, newest-run selection | unit seam | green (418034a) |
| P-13 | `test/spec-drift.test.mjs` — call-site counts, §3.1 layout, reviewer tool lists | drift guard (repo-local) | green (62c9e91) |
| P-14 | `test/reviewer.test.mjs` — "two concurrent replies on one thread both land (aris-2cs.12)" | contract | green (f2e48b8) |

W-01…W-06 (picker/turn/TUI surfaces, §8 list) are **not yet observed**; they are
aris-2cs.5 (Playwright over real dsh web) and aris-2cs.6 (dsh-TUI inertness), both
waiting on the Nix environment bead aris-2cs.3. No test in this table skips.

## fast-check campaign

- Library: fast-check 4.10.2 (dev-only, never shipped — see `test/package.json`).
- Suites: `routing-properties.test.mjs` (13 properties, 100–300 runs each by default)
  and the artifact-presence property in `run-status.test.mjs` (25 runs).
- Seeds for the record (each: 20 property tests, all green): **20261012**,
  **1339444460**, **1665507952**. Fast-check honors `FC_SEED`/`FC_NUM_RUNS`;
  the suites also read `FC_NUM_RUNS` explicitly for the recorded default budgets.
- Findings: the property campaign surfaced the family-derivation boundary rule as
  a *pattern-per-family* boolean (P-04: `doubao-bytedance` → `bytedance`,
  `claude-gpt` → `unknown`), pinned by a dedicated test to keep the
  `review_gate.py` port honest.

## Mutation campaign (aris-2cs.8)

Planted one at a time in `dsh/`, targeted suites run, tree restored
(`git checkout --`). **Caught 6/6** observable mutants:

| # | Mutant | Killed by |
|---|---|---|
| M1 | `effortCandidates('max')` returns `['max', 'xhigh']` (the aris-2cs.11 bug) | P-05 property + aris-2cs.11 example (2 tests) |
| M2 | same-family guard deleted from `candidateRoutes` | P-06 property + 2 reviewer/routing examples (3 tests) |
| M3 | selection loops swapped: effort-major instead of candidate-major | survived initially → new property "the preferred route outranks its effort tier" (f18fc26) kills it (route-first is §3.3 (3)) |
| M4 | `index.mjs` ARIS_REPO effect returns no cleanup | host-disposal "dispose withdraws everything" + re-apply test (2 tests) |
| M5 | `settings.mjs` routes validation deleted | host-disposal "a bad config fails activation before any effect lands" (1 test) |
| M6 | `run-status.mjs` `describe()` catch returns `exists: true` | run-status empty-workspace + pass-through + presence property (3 tests) |

Equivalent mutant recorded: deferring `parseReviewerSettings` into the settings
effect survives the unit seam — the seam's `ctx.effect` evaluates eagerly, so the
bad config still throws before any effect lands. The guard's intent ("parse before
any effect") is pinned by the bad-config test's zero-effects assertion.

## Versions

- dsh: **0.2.1-alpha.2**, store build `i24c2k38bz3h86r0v7bjr4amk7d4vxrj` (both
  `DSH_BIN` and `DSH_ROOT` above).
- dsh-TUI: 0.14.0 available but **not exercised** this round (W-06 pending).
- Node: v24.21.0; fast-check 4.10.2; playwright-core 1.63.0 installed, unused yet.
- Suite count: 56 tests, 0 skipped, ~2.3 s (unit + contract + rig CLI + one real
  `dsh web` boot).

## Honest gaps

- W-01…W-05: no Playwright suites yet (aris-2cs.5) — blocked on aris-2cs.3 (Nix env).
- W-06: no TUI inertness run yet (aris-2cs.6).
- No CI job for `dsh/` yet (aris-2cs.10); suites run locally on this host only.
- `client.js` (browser half) has no direct tests; the ARIS tab's RPC is observed
  only through P-11/P-12 seams.
- Release gates (aris-2cs.9) deliberately untouched: held for ROUND B.