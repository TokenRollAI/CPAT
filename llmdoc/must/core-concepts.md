# CPAT 核心概念（必读）

**CPAT = Context Patch as Tool**：agent 通过一个受校验的 `context_update` 工具，对自己的可见 context blocks 提交原子 patch。核心命题：context 管理从被动阈值压缩变成 agent 的主动决策——runtime 只发预算压力信号，选择压缩什么的是 agent。

## 心智模型

- **ContextBlock**：可寻址、可修补的工作态单元（id / kind / visibility / content）。每条消息进入系统即成 block。
- **ContextView**：按可见性过滤、按 block 顺序渲染的下一轮消息列表。
- **单份存储**：每个 payload 进系统只存一次（ContentStore，键 `<blockId>@v<version>`）；`payload_offload` 是零拷贝视图翻转（content: string → ArtifactRef），`artifact://<key>` 是唯一恢复通道。溯源由 append-only Journal 承担。
- **核心工具只有一个**：`context_update`（事务式——任一 op 被拒整体不生效）；辅以 `artifact_get` 恢复 offload 全文。

## 预算压力阶梯

70% `soft`（注入 budget_report，agent 收窄新探索、等待边界维护）→ 80% `must_act`（普通任务回合避免 broad task tools；边界 pass 或临近溢出时最小 patch / `no_context_update_needed`）→ 95% `critical`（runtime 兜底强制 offload ≥300 token 的 inline tool_result）。

## 关键术语

- **op 八种**：默认启用 6 个 `compact` / `payload_offload` / `set_visibility` / `restore` / `merge` / `fold`；默认 gated 2 个 `replace` / `redact`（需 `--allow-replace` / `--allow-redact`）。可逆性/代价升序：`set_visibility=archived` < `payload_offload` < `restore` < `compact`/`fold`/`merge`。`restore` 是 offload 的零拷贝逆操作；`merge` 归并语义重叠块；`fold` 折叠连续子任务区间。
- **chain_atomicity**：tool-call 链（assistant 头 + 全部 tool results，含已 offload 的）必须整体 patch，否则下一轮 API 400。链归属看 `api.tool_call_id`，不看 kind。
- **runtime-owned**：budget_report、manifest、api_required 块归 runtime 管，agent 不可 patch。

## 工程事实

- Node ≥ 23.6 原生跑 TS，零运行时依赖。`npm test`（离线）/ `npm run demo`。
- 项目文档用简体中文，技术名词/代码保留英文。

深入：`llmdoc/architecture/context-runtime.md`、`llmdoc/architecture/agent-protocol.md`。
