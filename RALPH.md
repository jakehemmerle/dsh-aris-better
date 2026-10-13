# Ralph loop state

Effort epic: `aris-2cs` (3 rounds). Read this file and `bd ready` at the start of every round.

## Round C (2026-10-13, "ROUND C") — DONE, board complete

- Closure audit: all 13 closes (.1,.2,.4,.7,.8,.11–.18) re-verified against
  their recorded evidence: fast suite 58 → then 59 tests green on
  FC_SEED=20261012 (the ±1 from wire-contract additions)
  red→fix pairs re-reviewed in history (da84de3→f2e48b8, 1b62452→3f5fe36,
  6a7f3f7→62c9e91); mutants M1 and M3 replanted and killed again by exactly
  the recorded tests; SPEC §8 and TESTING.md tables checked line by line.
- aris-2cs.5 W-01/W-02 were RED for a REAL bug: dsh 0.2.1-alpha.2 cannot mount
  a plugin prefix RPC channel (`connection.rpc.handle` throws on the
  connection service's `webServer` scope for patch rows — probed live with a
  shape-matrix plugin). Red a677f20 → fix cf585d9: the host mounts
  `POST /api/aris/state` as an exact fetch route on the shared `/api` gateway
  and the client polls `connection.rpc.call('/api','aris/state',…)`. At
  campaign scale two more finds: the ARIS sidebar seat shares the preset tab's
  text (role=tab selectors), and the W-01 preset-reset oracle — a picked
  preset applies to the session you start; New session resets to Standard
  mode. Campaign green: 3 seeds × 40 cases × web 6 tests.
- aris-2cs.6: same-scale finds — once a session exists the TUI home hands the
  input to the sessions filter, so the property RESTARTS the client on the
  same profile per run (rig restart persistence); Escape/C-u semantics
  probed and pinned. 3 seeds × 40 cases × TUI 3 tests green.
- aris-2cs.10: `.github/workflows/dsh-test.yml` (fast suite, dsh/** paths on
  main + dsh-next, seed matrix) — the first CI run caught a LIVE bug the
  local suite misses: host-require resolved @deepseek-ai/* only through the
  Nix nested node_modules (npm hoists one level up) and the P-07 attempt
  oracle miscounted dedup skips; CI-opened fixes 4fa7c00, run 38336334099
  green on both seeds afterwards.
- aris-2cs.3: flake.nix (package/version from package.json, devShell with
  pinned dsh 0.2.1-alpha.2 + dsh-TUI 0.14.0 + chromium-1243 browsers,
  checks.fast-suite, apps.e2e): `nix flake check` green; fixing the flake's
  own scale bugs along the way (jq --argjson JSON string, npmDepsHash cycle
  to r/+rfdx…, e2eHome SC2155). The flake e2e app program runs green 9/9
  (direct exec; `nix run`'s launcher EACCESes the identical built program on
  this host — recorded in TESTING.md).
- aris-2cs.9: RELEASING.md + CHANGELOG.md; tag v0.2.0-alpha.2 only when
  every gate is green (flake check, CI, campaigns) — done.
- Beads closed with evidence: .3, .5, .6, .10, .9 + epic. `bd export`
  committed; every push to origin/main verified with the preflight script.

## Environment for running suites

- DSH_BIN=/nix/store/i24c2k38bz3h86r0v7bjr4amk7d4vxrj-dsh-0.2.1-alpha.2/bin/dsh
  (NOT the managed wrapper — it exports real provider keys),
  DSH_ROOT=…/lib/node_modules/@deepseek-ai/dsh.
- Node v24.21.0; fast-check 4.10.2, playwright-core 1.63.0 in dsh/test/node_modules
  (gitignored; package-lock.json is the committed source).
- Real-client browser: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers
  (`nix build github:NixOS/nixpkgs/b6c8664…#playwright-driver.browsers` → chromium-1243).

## Gotchas (new this round)

- `dump-config` reports module paths as `file://` URLs (see acceptance-rig).
- In the ARIS web UI, the session sidebar seat and the ARIS conversation tab
  share the text 'ARIS'; use role=tab.
- The dsh-TUI home screen routes typing to the sessions filter once a
  session exists; Escape from chat returns (verified), Escape on the home
  opens the transverse Sessions screen.
- dsh web cannot mount plugin prefix RPC channels in 0.2.1-alpha.2; mount
  exact `/api/*` fetch routes instead.
- fast-check examples that compare counts must derive skipped routes from a
  UNIQUE-route view — candidateRoutes dedups before it labels.
- bd create/update here do not auto-commit; commit `.beads/` deliberately.

## Next (for a future round, none pending in-scope)

- nix-config pins this tag after Jake's acceptance of the installed
  revision (the lead's table, not this repo).
- Optional follow-ups recorded as open beads elsewhere: theme/gesture
  variation properties; `nix run` launcher EACCES investigation.