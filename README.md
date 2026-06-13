# CPAT — Context Patch as Tool

基于 DeepSeek 的最小原型：让 agent 通过一个受控的 `context_update` 工具，对自己的可见
context blocks 提交原子 patch，由 runtime 校验后应用到下一轮 context view。

核心命题：**context 管理从被动阈值压缩变成 agent 的主动决策**。runtime 只发出
budget 压力信号；选择对哪些 block 做 compact / payload offload / archive 的是 agent 自己。

## 快速开始

```bash
# .env 提供 OPENAI_BASE_URL 与 API_KEY（DeepSeek 的 OpenAI 兼容端点）
cp .env.example .env

npm install          # blessed（TUI）为唯一运行时依赖，其余仅 dev
npm test             # 离线测试 patch 引擎（不调 API）
npm run demo         # 内置仓库分析任务，小预算强制触发 budget 压力
npm run tui          # 交互式 TUI：表单设置 max-context/模型/任务，实时显示每轮日志

# 自定义任务
node src/cli.ts run "你的任务" --workdir <目录> --max-context 16000 --model deepseek-v4-flash
```

任务工具：`list_dir` / `read_file` / `grep_search`（只读）、`write_file` / `bash`
（写入与执行，均限制在 `--workdir` 沙箱内：路径解析锁定 root，bash 的 cwd 钉死 root）。

要求 Node ≥ 23.6（原生运行 TypeScript）。每次运行的产物在 `runs/<时间戳>/`：
`journal.jsonl`（append-only 事件日志）、`content/`（单一内容存储）、
`metrics.json`、`answer.md`。

## 数据模型（与设计文稿的对应及偏差）

```
ContentStore   每个 payload 进入系统时只存一次，键为 <blockId>@v<version>，
               artifact://<key> 是唯一找回通道
Journal        append-only 事件日志（ingest / patch / llm_call），只记元数据与内容键
ContextBlock   可 patch 的工作状态，按 id 寻址（src/types.ts）
ContextView    下一次 LLM 调用真正渲染的 block 列表
```

相对设计文稿的两个核心调整（讨论后决定）：

1. **单一内容存储取代「raw log 全文 + artifact store 拷贝」**。原设计同一 payload 会存三份
   （raw log、block、offload 后的 artifact）。现在 payload 只存一次；`payload_offload`
   是纯视图层操作——block 从「内联渲染」切换为「渲染 ArtifactRef」，**零拷贝**、瞬时完成。
   append-only 的溯源语义由 Journal 承担。
2. **offload 不改变 block 的 kind**。kind 表示块「是什么」（tool_result 等），是否 offload
   是存储形态（content 是否为 ArtifactRef）。这是一次真实 API 400 的回归修复：offload 后的
   tool result 仍渲染为 `role:"tool"` 消息，必须保持 tool-call chain 成员身份。

## 协议流程

1. 每条 user / assistant / tool 消息进入系统即成为 block（id、kind、token 数、description）。
2. 每轮调用的消息列表 = block 顺序渲染（带 `[block:<id>]` 标签）+ 易变尾部
   （`<context_manifest>` 每轮重建，不落库——稳定 prefix 在前、变化集中在尾部，配合
   DeepSeek context caching）。
3. budget 压力阶梯（按下一轮 view 的校准估算）：
   - **70% soft**：注入 `budget_report` block（最大块 + 建议操作 + 必须保留项）；agent 自行决定。
   - **80% must_act**：agent 必须调用 `context_update` 或明确回复 `no_context_update_needed`。
   - **95% critical**：runtime 兜底，强制 offload 最大的内联 tool results（≥300 tokens）。
4. `context_update` 是事务：任一 operation 被拒则整体不生效，rejection 消息返回给 agent 重试。
5. DeepSeek thinking mode 的 `reasoning_content`：tool call 链未闭合时作为 `api_required`
   的 `reasoning_trace` block 随 assistant 消息回传（API 协议要求），链闭合后 runtime 自动释放。
   agent 的语义 patch 永远不影响 API 回放所需字段。

## 操作与校验规则

MVP 默认启用 `compact` / `payload_offload` / `set_visibility`；`replace` / `redact`
按阶段计划默认关闭（`--allow-replace` / `--allow-redact` 开启）。

校验规则（`src/runtime/patch.ts`）：

| 规则 | 含义 |
| --- | --- |
| `protected_kind` | system prompt、budget report、api_required 块不可 patch |
| `replace_protected` | user 原文只能 summarize/archive，不可改写 |
| `protected_hidden` | protected 块不可 hidden（archive 可恢复，hidden 不列 manifest） |
| `offload_replacement` | offload 必须留下 description + summary + retrieval_hint |
| `compact_policy` | compact 必须声明 preserve / drop |
| `chain_atomicity` | tool-call chain（assistant 头 + 全部 tool results，含已 offload 的）必须整体 patch，否则下一轮 API 会 400 |

所有 patch（agent 与 runtime 兜底）写入 journal，可完整重放。

## 实验假设与指标

- **H1** agent 自选 patch 比阈值压缩更能保留任务相关信息
- **H2** block 级 payload offload 比 append-only raw tool results 的 token 成本与干扰更低
- **H3** stable prefix + patchable tail 更好利用 DeepSeek context caching
- **H4** 收益不只是避免超窗，而是减少 semantic drift / duplicate context / obsolete reasoning

`metrics.json` 字段：prompt/completion tokens、cache 命中（`prompt_cache_hit_tokens`）、
agent patch 应用/被拒数、runtime 兜底次数、各 op 计数、释放 token 数、最终可见 block 状态。
对比基线时关注 `agent_patches_applied` 与 `runtime_fallback_offloads` 的比例——
后者占比高说明 agent 治理不及时，退化成了被动压缩。

实验注意：`--max-context` 故意压小（如 12k）才能频繁触发压力；预算越小 patch 越频繁，
prefix 改写越多，cache 命中率越低——H3 需要在更接近真实的预算下测。token 估算是
启发式（中英文系数），按 API 实际 `prompt_tokens` 在线校准。

## 代码结构

```
src/types.ts               全部协议类型（block / operation / journal / config）
src/util/env.ts            .env 解析（OPENAI_BASE_URL + API_KEY）
src/util/misc.ts           token 估算、id 生成
src/deepseek/client.ts     OpenAI 兼容客户端（strict tools 失败自动降级）
src/runtime/stores.ts      ContentStore（单一拷贝）+ Journal（append-only）
src/runtime/blocks.ts      BlockStore：寻址、排序、chain 识别、ingestion
src/runtime/patch.ts       校验器 + 事务式 applier（CPAT 核心）
src/runtime/view.ts        消息渲染、manifest、budget report 构建
src/runtime/runtime.ts     ContextRuntime 总控：budget 监控、兜底、journal 记账
src/agent/contextTool.ts   context_update / artifact_get 的 tool schema 与归一化
src/agent/taskTools.ts     沙箱化任务工具（list_dir / read_file / grep_search）
src/agent/loop.ts          agent 主循环、系统提示词、指标收集
src/cli.ts                 CLI 入口与 demo 任务
```
