# DeepSeek Harness 0.2 的 ARIS 模式

[English](README.md) | 中文

> 这是上游 [`dsh-aris`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/tree/dsh-aris) 分支面向 DeepSeek Harness（dsh）0.2.x 的 fork。完整的 ARIS 项目在上游 [`main`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)。设计说明见 [`dsh/SPEC.md`](dsh/SPEC.md)（英文）。

ARIS 以独立的 **Agent 预设** 运行：在预设选择器里（Standard、PTC 旁边）选 **ARIS**，该会话即获得全部 84 个 ARIS 技能和一个独立审稿人。其他预设和默认模型不受影响。

审稿人作为子代理运行在 **dsh 内部**，使用 profile 已配置的 provider（anthropic、openai-codex、providerproxy、deepseek-official 或任意自定义路由），并且始终来自与当前会话模型 **不同的模型家族**：Claude 会话由 GPT 审稿，GPT 会话由 Claude 审稿。若没有可用的跨家族路由，审稿以 `REVIEW_UNAVAILABLE` 失败，绝不退化为自审。不需要 Codex CLI、Python 桥接或额外登录。

技能与上游 `main`（`26b95cf`，2026-10-07）一致、未作修改；它们继续调用 `mcp__codex__codex` / `mcp__codex__codex-reply`，由本包在 dsh 内提供同名工具。

## 安装

```sh
dsh plugin --profile web add link:/本仓库的绝对路径   # 或打包后的 tarball
```

安装后重启 dsh（插件代码只在启动时加载），新建会话，在发送第一条消息前选择 **ARIS**，输入 `/` 即可看到 ARIS 技能。`dsh plugin` 依赖 PATH 上的 **pnpm**。

## 审稿路由

1. 执行者 = 当前会话的实际模型，家族由模型 id 判断（同一网关同时提供 Claude 与 GPT 也能区分）。
2. 已配置的审稿路由是唯一的审稿模型。技能固定的 `model`（多数为 `gpt-6-astra`）只会把提供该模型的路由排到最前。
3. 使用第一个家族不同且可用的路由。默认顺序：`openai-codex/gpt-6.1-sol`、`providerproxy/gpt-6.1-sol`、`anthropic/claude-opus-5-5`、`providerproxy/claude-opus-5-5`、`deepseek-official/deepseek-v4-pro`。因此 GPT 审稿使用 GPT-6.1 Sol，而不是 Astra。
4. 推理强度不低于请求档位：`ultra` → `max`，再 `xhigh`；`xhigh` → `xhigh`，再 `max`。

每次结果首行是元数据（threadId、实际审稿模型与家族、执行者模型与家族、独立性），技能会把它写入 `REVIEW_STATE.json`。审稿线程保存在 `$DSH_HOME/aris/reviewer-threads/`，重启后可继续。

在 profile patch 中通过宿主行覆盖路由（dsh patch 无法定位预设内部的行）：

```yaml
- id: aris-host
  config:
    reviewer:
      routes:
        - { provider: openai-codex, model: gpt-6.1-sol }
        - { provider: anthropic, model: claude-opus-5-5 }
```

## 可选行（默认关闭）

`aris-scope-limits`（把审稿人的范围约束也施加给执行者）、`aris-grok` / `aris-antigravity`（需要 `grok` / `agy` CLI 的直接咨询工具，不是审稿路由）。

## 已知限制

- 仅在 dsh `0.2.1-alpha.2` 上验证；每次升级 dsh 后运行 `DSH_ROOT=... npm test`（含预设漂移检测）。
- 预设只存在于 Web 端；headless 与 TUI 不显示 ARIS 模式。
- dsh 0.2.1 没有按预设设置默认模型，ARIS 模式使用会话模型。
- 每轮回复都会把该线程之前的轮次重发给新的审稿子会话。
- 不要在同一预设中再安装上游 Codex MCP 服务器：工具名会冲突。
