# 项目总览：CPAT

基于 DeepSeek 的最小原型，验证「Context Patch as Tool」协议：agent 用受控的 `context_update` 工具主动治理自己的上下文，而非由 runtime 做被动阈值压缩。核心概念见 `llmdoc/must/core-concepts.md`。

## 实验假设

- **H1**：agent 自选 patch 比阈值压缩更能保留任务相关信息。
- **H2**：block 级 payload offload 比 append-only raw tool results 的 token 成本与干扰更低。
- **H3**：stable prefix + patchable tail 更好利用 DeepSeek context caching。
- **H4**：收益不只是避免超窗，而是减少 semantic drift / duplicate context / obsolete reasoning。

对比基线时关注 `agent_patches_applied` 与 `runtime_fallback_offloads` 的比例——兜底占比高说明 agent 治理不及时，退化成被动压缩。

## 仓库布局

```
src/types.ts               全部协议类型（block / operation / journal / config）
src/util/env.ts            零依赖 .env 解析（OPENAI_BASE_URL + API_KEY）
src/util/misc.ts           token 估算（ASCII 0.3 / CJK 0.6）、id 生成
src/deepseek/client.ts     OpenAI 兼容客户端（strict 降级、5xx 重试）
src/runtime/               stores / blocks / patch / view / runtime（CPAT 核心）
src/agent/                 contextTool / taskTools / loop（协议面 + 主循环）
src/cli.ts                 CLI 入口与 demo 任务
test/patch.test.ts         12 个离线不变量测试
```

## 开发工作流

- `npm test`：离线测试 patch 引擎（Node 内置 test runner 直接跑 `.ts`，不调 API）。
- `npm run demo`：内置仓库分析任务，小预算强制触发 budget 压力。
- 自定义任务：`node src/cli.ts run "<task>" [flags]`。
- CLI flags 与默认值：`--model deepseek-v4-flash`、`--max-context 16000`（故意压小以触发压力）、`--turns 40`、`--workdir cwd`、`--allow-replace` / `--allow-redact`（默认关）、`--verbose`、`--demo`。压力比例 0.7/0.8/0.95 与 `strictTools: true` 硬编码，无 flag 覆盖。
- `.env`：CPAT 只消费 `OPENAI_BASE_URL`（多重回退，默认 `https://api.deepseek.com`）与 `API_KEY`（回退 `DEEPSEEK_API_KEY` 等），见 `src/util/env.ts` (`loadDeepSeekEnv`)。`.env.example` 中的 `ANTHROPIC_BASE_URL` **不被 CPAT 代码消费**，仅供其他工具使用。
- 环境要求：Node ≥ 23.6（原生 type-stripping 跑 TS），零运行时依赖（仅 dev 依赖 typescript / @types/node）。

## 运行产物

每次 run 落盘 `runs/<ISO时间戳>/`（已 gitignore）：

- `journal.jsonl`：append-only 事件日志（ingest / patch / llm_call），runtime 写入。
- `content/`：单份内容存储，文件名 `<blockId>@v<version>.txt`，runtime 写入。
- `metrics.json` + `answer.md`：cli 在 run 结束时写入。

## 当前状态

- 原型已端到端验证：真实 DeepSeek API demo run 跑通（含一次 API-400 回归的发现与修复，见 `llmdoc/memory/decisions/0002-offload-keeps-kind.md`）；12 个离线测试全部通过。
- 仓库 git 初始态：`main` 零 commit，全部文件 untracked。
- 语言约定：项目文档简体中文，技术名词/代码英文。
