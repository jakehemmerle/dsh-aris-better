# ARIS mode for DeepSeek Harness 0.2

English | [中文](README_CN.md)

> A fork of the upstream [`dsh-aris`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/tree/dsh-aris) branch for DeepSeek Harness (dsh) 0.2.x. The full ARIS project — every workflow, the docs, and the other host adaptations — lives on upstream [`main`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep). Design and rationale: [`dsh/SPEC.md`](dsh/SPEC.md).

ARIS runs as its own **agent preset**. Pick **ARIS** in the preset picker next to Standard and PTC, and that session gets all 84 ARIS skills plus an independent reviewer. Other presets, and your default model, are untouched.

The reviewer runs **inside dsh** as a subagent, on the providers your profile already has (anthropic, openai-codex, providerproxy, deepseek-official, any custom route). It is always from a **different model family** than the session's model — a Claude session is reviewed by GPT, a GPT session by Claude. If no such route is available the review fails with `REVIEW_UNAVAILABLE`; it never falls back to self-review. No Codex CLI, Python bridge, or extra login is needed.

The skills are unmodified upstream `main` (`26b95cf`, 2026-10-07). They keep calling `mcp__codex__codex` / `mcp__codex__codex-reply`; this package serves those tool names from dsh.

## Install

```sh
dsh plugin --profile web add link:/absolute/path/to/this/checkout   # or a packed tarball
```

Restart dsh (`dsh web`, or your service) — plugin code loads at startup. Then open a new session, choose **ARIS** in the preset picker before the first message, and type `/` to see the ARIS skills.

`dsh plugin` shells out to **pnpm**, which dsh does not bundle.

Check the layer applied:

```sh
dsh --profile web --dump-config | grep -nE 'aris-host|preset-aris'
```

## How the reviewer works

| Skill call | What runs |
|---|---|
| `mcp__codex__codex {prompt, model, config.model_reasoning_effort, sandbox, cwd}` | Picks a reviewer route, starts a dsh child session on it, returns its answer. |
| `mcp__codex__codex-reply {threadId, prompt}` | Same route/effort/sandbox; the child sees every earlier round of the thread. |

Route selection:

1. The executor is the calling session's live model; its family comes from the model id (so one gateway serving both Claude and GPT is handled).
2. A pinned `model` (most skills pin `gpt-6-astra`) is used if it is a different family and some configured provider serves it.
3. Otherwise the first configured reviewer route of a different family wins. Defaults, in order: `openai-codex/gpt-6-astra`, `providerproxy/gpt-6-astra`, `anthropic/claude-opus-5-5`, `providerproxy/claude-opus-5-5`, `deepseek-official/deepseek-v4-pro`.
4. Effort never drops below the requested tier: `ultra` → `max` then `xhigh`; `xhigh` → `xhigh` then `max`.

Every result starts with one line the skills record into `REVIEW_STATE.json`:

```
ARIS reviewer metadata (not part of the reviewer response): threadId=aris-rv-… round=1 reviewer=openai-codex/gpt-6-astra effort=xhigh reviewer_family=openai executor=anthropic/claude-opus-5-5 executor_family=anthropic independence=verified-by-host-routing requested_model=gpt-6-astra requested_model_used=yes
```

The reviewer gets `read`, `read_image`, `glob`, `grep`, `web_search`, `web_fetch` and `skill`; `sandbox: workspace-write` adds `bash`/`write`/`edit`. It cannot delegate or call the reviewer tools. Threads persist in `$DSH_HOME/aris/reviewer-threads/` and survive restarts.

Override the routes (and `timeoutMs`, default 20 minutes) on the host row in your profile patch. dsh patches cannot address rows nested inside a preset, so the knobs live on `aris-host`:

```yaml
- id: aris-host
  config:
    reviewer:
      routes:
        - { provider: openai-codex, model: gpt-6.1-sol }
        - { provider: anthropic, model: claude-opus-5-5 }
```

## Optional rows (disabled)

| Row | Enable when |
|---|---|
| `aris-scope-limits` | You want the reviewer's scope limits applied to the executor too (costs tokens every request). |
| `aris-grok` | The `grok` CLI is installed: adds `grok` / `grok-reply` consultation tools (upstream #454). |
| `aris-antigravity` | The `agy` CLI is installed: adds `antigravity` / `antigravity-reply`. |

These consultation bridges are not reviewer routes and never satisfy an acceptance gate.

## The ARIS tab

Sessions get a read-only **ARIS** tab beside Chat and Trajectory. It reads `review-stage/REVIEW_STATE.json` from the session's workspace and shows who reviewed the latest round and whether the families differ. It never writes, advances a round, or turns a score into a completion decision.

## Tests

```sh
DSH_ROOT=<prefix>/lib/node_modules/@deepseek-ai/dsh npm test
```

`preset-drift.test.mjs` compares the preset's copied Standard rows against the installed dsh; run it after every dsh upgrade.

## Known limits

- **Tracks one dsh line.** Verified on dsh `0.2.1-alpha.2`. Presets were redesigned in 2026-09; re-run the tests on every upgrade.
- **Web only.** dsh presets are a Web-surface concept; the headless and TUI profiles do not show ARIS mode.
- **No per-preset model.** ARIS mode uses the session's model; dsh 0.2.1 has no preset-level default.
- **Replay cost.** Each reply round resends the thread's earlier rounds to a fresh reviewer child.
- **Do not also install the upstream Codex MCP server** in this preset: it registers the same tool names.
