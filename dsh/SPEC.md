# dsh-aris-better: fork proposal and product spec

Status: proposal + reference implementation on branch `dsh-next` of
[`jakehemmerle/dsh-aris-better`](https://github.com/jakehemmerle/dsh-aris-better), a fork of
`wanshuiyin/Auto-claude-code-research-in-sleep`.
Target: DeepSeek Harness (dsh) `0.2.1-alpha.2` (and the `0.2.x` line).

## 1. Why fork

`dsh-aris` 0.1.1 (2026-09-16) is the last release of the upstream DSH branch.
It was verified against dsh `0.1.1-rc.1`; dsh is now `0.2.0-rc.2` / `0.2.1-alpha.2`.

Problems with 0.1.1 on current dsh:

| Problem | Effect |
|---|---|
| Host-level layer | ARIS skills, the `codex` MCP server and scope limits mount into **every** preset (Standard, PTC, Creator), not just research sessions. |
| `agent-default-model` override | Installing the bundle rewrote the deployment default model to `deepseek-official/deepseek-v4-pro` for all sessions (and dropped its effort). |
| Reviewer runs outside dsh | Codex CLI + `python3` + a stdio bridge are mandatory; `failOnStartupError: true` makes the whole profile refuse to boot if any is missing. |
| Reviewer independence is declared, not enforced | The Codex route never sees the executor model; independence is `caller_declared` at best. |
| Corpus is stale | 43 upstream commits behind `main` (no `/lean-formalize`, grok/antigravity bridges, Skill grants, tool fixes). |
| Obsolete API use | `connection.rpc.handle(…, {authority: 'loopback'})` — the third argument no longer exists. |

Upstream has no open issue or branch work for dsh 0.2.x, so this is a fork,
not a PR series. The corpus (skills/, tools/, templates/, mcp-servers/) stays
byte-identical to upstream `main` so it can be re-merged at any time; only
`dsh/`, `package.json` and the READMEs differ.

## 2. Product

**ARIS mode** is a new agent preset in the dsh Web preset picker, next to
Standard, PTC, Minimal and Creator. Choosing it for a session gives that
session — and only that session — the ARIS research workflow.

### Goals
1. ARIS is opt-in per session. Other presets and the deployment default model are untouched.
2. The independent reviewer runs inside dsh as a subagent, on whatever providers the profile already has (anthropic, openai-codex, providerproxy, deepseek-official, any pi-ai route). No Codex CLI, no Python bridge, no extra login.
3. "A loop can DRIVE, it cannot ACQUIT" is enforced by code: the reviewer is always routed to a different model family than the executor; if no such route resolves, the review fails closed.
4. The 84 upstream skills run unmodified.
5. The reviewer is a first-class dsh child session: visible in the session tree, logged, interruptible, governed by the session's permission policy.

### Non-goals
- Re-implementing ARIS skills as dsh workflows. Skills already orchestrate; dsh's `workflow` tool is available in the preset for fan-out, but no skill is rewritten.
- Codex CLI as a reviewer backend. Users who want it can still add the upstream `codex-exec` MCP bridge themselves; it is not shipped as a preset row because it would register the same tool names.
- Headless / TUI presets. dsh presets are a Web-surface concept at 0.2.1.

## 3. Design

### 3.1 Package layout (`dsh/`)

| Module | Row | Scope | Purpose |
|---|---|---|---|
| `index.mjs` | `aris-host` | host | Publishes `ARIS_REPO` and the reviewer settings (`config.reviewer`); serves the ARIS tab's read-only RPC. Loads the `dsh.client` browser half. |
| `skills.mjs` | `aris-skills` (preset child) | preset | Mounts `skills/` at bundled rank 600 with provider name `aris`. |
| `reviewer.mjs` | `aris-reviewer` (preset child) | preset | Registers the reviewer tools (§3.3). |
| `routing.mjs` | — | pure | Model-family derivation, route and effort selection. Unit-tested. |
| `threads.mjs` | — | pure I/O | Persists reviewer threads. Unit-tested. |
| `settings.mjs` | — | shared | Default routes/timeout; the host row publishes overrides, the reviewer reads them per call. A profile patch can address the top-level `aris-host` row but not rows nested inside the preset. |
| `host-require.mjs` | — | — | Resolves `@deepseek-ai/*` from the bundle or from the running dsh (store-path installs). |
| `scope-limits.mjs` | `aris-scope-limits` (preset child, disabled) | preset | Optional executor-side scope limits (unchanged). |
| `bridge.mjs` | `aris-grok`, `aris-antigravity` (preset children, disabled) | preset | Optional upstream `grok-exec` / `antigravity-exec` MCP consultation bridges. |
| `client.js` | — | browser | ARIS tab (run status, reviewer identity). |
| `cordis.patch.yml` | — | bundle | Inserts `aris-host` and `preset-aris`. No `agent-default-model` row. |

### 3.2 The preset

`preset-aris` (`@deepseek-ai/dsh-agent-preset`, `id: aris`, `order: 5`) is the
Standard preset's plugin list at dsh 0.2.1-alpha.2 plus:

- a research persona prefix,
- `aris-skills` (the user's own skill roots stay mounted through the normal `skill-filesystem` row and win on name conflicts),
- `aris-reviewer`,
- `aris-scope-limits` (disabled), `aris-grok` / `aris-antigravity` (disabled),
- `dsh-agent-tool-presentation` pinned to `native` (review loops need per-step results).

Workflows (`workflow` tool, `workflow-ptc` engine) stay enabled for the
fan-out pattern in `shared-references/fan-out-pattern.md`.

`test/preset-drift.test.mjs` compares the copied Standard rows against the
installed `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`, so a dsh
upgrade that changes Standard fails loudly instead of silently diverging.

### 3.3 Reviewer: Codex contract, dsh execution

The skills call `mcp__codex__codex` (146 call sites) and
`mcp__codex__codex-reply` (74). The preset registers native tools with those
exact names and argument shapes:

| Tool | Arguments | Behaviour |
|---|---|---|
| `mcp__codex__codex` | `prompt` (req), `model`, `config.model_reasoning_effort`, `sandbox` (`read-only` \| `workspace-write` \| `danger-full-access`), `cwd` | Starts a reviewer thread. |
| `mcp__codex__codex-reply` | `prompt` (req), `threadId` (`conversationId` alias) | Continues a thread with the same route, effort, sandbox and cwd. |

Each call starts a `spawn` subagent (`delivery: 'caller'`; its tool allow-list omits `subagent`, `workflow` and the reviewer tools, so it cannot delegate or recurse) with:
- `agentOptions` = the selected reviewer route,
- `persona` = an independent-reviewer prefix,
- `toolFilter.allow` = read-only tools (`read`, `read_image`, `glob`, `grep`, `web_search`, `web_fetch`, `skill`), plus `bash`/`write`/`edit` for `workspace-write` and `danger-full-access`. Names absent from the caller's scope are dropped.

**Route selection** (pure, `routing.mjs`):
1. Executor = the calling agent's resolved route (`parentAgentOptionsForDelegation`). Family from the model id (port of `tools/review_gate.py:derive_model_family`).
2. The configured reviewer routes are the only reviewer models. If the skill pinned `model` (most pin `gpt-6-astra`), routes serving exactly that model are tried first; a pin no route serves is ignored.
3. Take the first route whose family differs from the executor's.
4. A route is usable only if `llm.resolveCallConfig` accepts it with an effort on the request's ladder, never below the requested tier (`max`→`max`; `xhigh`→`xhigh`,`max`; `high`→`high`,`xhigh`,`max`; …). The one exception is Codex's top tier, which dsh has no name for: `ultra`→`max`,`xhigh`, whose floor is `xhigh`.
5. No usable cross-family route → tool error `REVIEW_UNAVAILABLE` with the reason. No same-family fallback. An unknown executor family is allowed but labelled `independence=unverified`.

Default reviewer routes (override with `aris-host` `config.reviewer.routes`):

```
openai-codex/gpt-6.1-sol, providerproxy/gpt-6.1-sol,
anthropic/claude-opus-5-5, providerproxy/claude-opus-5-5,
deepseek-official/deepseek-v4-pro
```

**Threads.** `threadId` is an ARIS id (`aris-rv-<uuid>`). Each round runs a
fresh child whose prompt carries the prior rounds' requests and responses, so
the reviewer keeps its critique history across rounds and across dsh
restarts (file store: `$DSH_HOME/aris/reviewer-threads/<id>.json`). This is
the same replay model as `codex exec resume`.

**Result.** Model-visible text starts with one metadata line, then the
reviewer's answer:

```
ARIS reviewer metadata (not part of the reviewer response): threadId=… reviewer=openai-codex/gpt-6.1-sol effort=xhigh reviewer_family=openai executor=anthropic/claude-opus-5-5 executor_family=anthropic independence=verified-by-host-routing
```

Skills record `reported_reviewer_model` and families from that line, so
`REVIEW_STATE.json` / `ACQUITTAL_LOG.jsonl` carry the real reviewer identity
and `review_gate.py --round-backend codex` keeps working unchanged.

### 3.4 Executor model

dsh 0.2.1 has no per-preset default model. ARIS mode uses the session's model
(deployment default or the picker). The reviewer side adapts to it, so any
executor works: Claude executor → GPT reviewer, GPT executor → Claude
reviewer, DeepSeek/GLM executor → GPT reviewer.

## 4. Upstream changes carried in (main `26b95cf`, 2026-10-07)

| Upstream change | How it lands |
|---|---|
| `/lean-formalize` skill (#461) and proof-skill routing | Skill corpus (auto-mounted). Its Codex reviewer calls go through §3.3. |
| `grok-exec` / `antigravity-exec` bridges (#454) | Shipped; optional disabled preset rows (need the `grok` / `agy` CLIs). |
| `Skill` grant on 5 skills (#440) | Corpus. |
| auto-review-loop `xhigh` tier wording (#442) | Corpus. |
| verify_papers / arxiv_fetch / research_wiki fixes, S2 API key (#445, #447, #450) | `tools/` (corpus). |
| watchdog lock (#443), alphaXiv host (#452), mermaid fix (#460) | Corpus. |

## 5. Install

npm-style (any dsh 0.2.x Web profile):

```sh
dsh plugin --profile web add link:/path/to/dsh-aris   # or the packed tarball
# restart dsh web, open a new session, pick "ARIS" in the preset picker
```

Nix (store-path install): insert `aris-host` (`name: <store>/dsh/index.mjs`) and the `preset-aris` row from `dsh/cordis.patch.yml` with its `@jakehemmerle/dsh-aris/*` child names replaced by `<store>/dsh/<module>.mjs`. `host-require.mjs` resolves dsh's own packages from the running CLI, so no `node_modules` is needed. The browser half is declared in `package.json` the same way as the store-path `dsh-usage-limits` plugin already in this setup; verify the tab appears after the first Nix rollout.

## 6. Acceptance

1. `dsh --profile <p> --dump-config` shows `aris-host` and `preset-aris`; no `agent-default-model` change.
2. Web preset picker lists ARIS; the preset activates (not `broken`).
3. Standard/PTC sessions do not list ARIS skills or the reviewer tools.
4. In an ARIS session with a Claude executor, `mcp__codex__codex` runs a GPT-family child and returns metadata + verdict; `mcp__codex__codex-reply` continues it with prior-round memory.
5. With a GPT executor the reviewer routes to Claude.
6. With every cross-family route removed, the tool returns `REVIEW_UNAVAILABLE`.
7. Unit tests: `DSH_ROOT=<dsh package dir> npm test`.

## 7. Risks

- **dsh churn.** Presets were redesigned on 2026-09-18; the preset copy and the drift test are the guard. Re-verify on every dsh bump.
- **Replay cost.** Long multi-round threads resend prior rounds. Reviewer windows are 272k–1M tokens; ARIS loops cap at 4–5 rounds.
- **Tool name collision.** Installing the upstream `codex-exec` MCP server in the same preset would register the same names; don't.
- **Permission policy.** Reviewer children inherit the session's approval/sandbox preset; `read-only` is enforced by tool filtering, not by an OS sandbox.
