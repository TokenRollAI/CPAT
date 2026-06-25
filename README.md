# CPAT — Context Patch as Tool

让 agent 通过一个受校验的 `context_update` 工具，对自己的可见 context blocks 提交原子 patch。
**核心命题**：上下文管理从被动阈值压缩，变成 agent 的**主动、可逆决策**——runtime 只发预算压力信号，
选择压缩/卸载/恢复哪些 block 的是 agent 自己。原型基于 DeepSeek，零运行时依赖（TUI 除外）。

## 这一次研究证明了什么

CPAT 是为**受限窗口下的超长程 agent**设计的。在一个固定上下文窗口里、面对远超窗口的语料、跨数十轮的
深度研究任务上，三对照臂（自建数据集，详见 [`research/`](https://github.com/TokenRollAI/CPAT/tree/main/research)）：

| 窗口 | 臂 | 提前终止 | 准确率 | 总 prompt tokens |
|---|---|:---:|:---:|---:|
| 32K | ReAct（无治理） | ✗ 是 | **0%** | 31,740 |
| 32K | threshold（被动压缩） | 否 | 100% | 305,434 |
| 32K | CPAT（主动治理） | 否 | 100% | 464,041 |
| 200K | ReAct（无治理） | ✗ 是 | **8.3%** | 714,175 |
| 200K | threshold（被动压缩） | 否 | 100% | **2,819,420** |
| **200K** | **CPAT（主动治理）** | 否 | **100%** | **488,333** |

两个结论：

1. **治理 ≫ 不治理**：受限窗口下 ReAct 因上下文耗尽**提前终止**而彻底失败（0% / 8.3%）；任何治理都能 100% 完成。
2. **大窗口下主动 CPAT 碾压被动压缩**：200K 时同样 100% 准确率，CPAT 只花 **49 万** token，threshold 花 **282 万**——**省 83%**。
   机制：threshold 被动等 context 涨满才压（每轮都背着近满窗口）；CPAT 主动读完即 offload（context 始终压在 25K）。
   **窗口越大，CPAT 优势越明显。**

诚实边界：32K 小窗口下 CPAT 反而比 threshold 贵（主动治理的 LLM 往返开销只有大窗口才回本）；
`restore` 的独立价值尚未验证（静态文件可重读时 re-read 永远够用）。完整研究档案见 [`research/`](https://github.com/TokenRollAI/CPAT/tree/main/research)。

> 之所以前期实验（用百万真实窗口）测不出价值：ReAct 永不溢出。唯一变量是"窗口是否受限"。
> 这与 CAT 论文（[arXiv:2512.22087](https://arxiv.org/abs/2512.22087)）的范式一致。

## 快速开始

```bash
cp .env.example .env   # 填 OPENAI_BASE_URL 与 API_KEY（DeepSeek 的 OpenAI 兼容端点）

npm install            # blessed（TUI）为唯一运行时依赖，其余仅 dev
npm test               # 26 个离线测试（patch 引擎 + agent 循环 + F1，全程不调 API）
npm run typecheck      # tsc --noEmit

# 跑一个自定义任务（受限窗口下治理你自己的上下文）
node src/cli.ts run "你的任务" --workdir <目录> --max-context 32000 --model deepseek-v4-pro

# 跑有效性对照实验（自建深度研究数据集，三臂之一）
npm run bench -- --mode cpat --hard-window 200000 --docs 40 --questions 12
```

要求 Node ≥ 23.6（原生运行 TypeScript）。每次运行产物落在 `runs/<时间戳>/`：
`journal.jsonl`（append-only 事件日志）、`content/`（单份内容存储）、`metrics.json`、`answer.md`。

## 心智模型

```
ContextBlock   可寻址、可 patch 的工作态单元（id / kind / visibility / content）
ContextView    按可见性过滤、按 block 顺序渲染的下一轮消息列表
ContentStore   每个 payload 只存一次，键 <blockId>@v<version>；artifact://<key> 是唯一恢复通道
Journal        append-only 事件日志（ingest / patch / llm_call），只记元数据与内容键
```

**`payload_offload` 是零拷贝视图翻转**（block 的 content 从 inline string 翻成 ArtifactRef，payload 仍在原键下），
**`restore` 是其逆操作**（把全文从 ContentStore 回填为 inline）。详细设计见 [`ARCHITECTURE.md`](https://github.com/TokenRollAI/CPAT/blob/main/ARCHITECTURE.md)。

## context_update 的 8 个原子操作

默认启用 6 个，gated 2 个（`--allow-replace` / `--allow-redact` 开启）。完整语义、字段、校验规则见
[`ARCHITECTURE.md`](https://github.com/TokenRollAI/CPAT/blob/main/ARCHITECTURE.md)。

| op | 作用 | 可逆性 |
|---|---|---|
| `set_visibility` | archive（留 manifest 可恢复）/ hidden（彻底移出）/ model（恢复） | 高 |
| `payload_offload` | 大 tool_result → 短摘要 + artifact 引用，零拷贝 | 高（restore） |
| `restore` | 把已 offload 的 payload 全文回填（offload 的逆操作） | — |
| `compact` | 一组完成的探索 → 一个 dense summary（源块归档） | 中 |
| `fold` | 一段**连续**子任务轨迹 → 一个 scoped summary | 中 |
| `merge` | 2+ 重叠/重复块 → 一个 canonical 块（update / contradiction） | 中 |
| `replace`(gated) | 改写非 protected 块内容 | 低 |
| `redact`(gated) | 删除 inline JSON tool_result 的字段 | 低 |

事务式：任一 op 被拒则整体不生效，rejection 返回给 agent 重试。关键护栏：tool-call chain 必须整体 patch
（`chain_atomicity`）；**当前问题与 task_state 不可被 compact/fold/merge 吞掉**（`protected_current_question` /
`protected_state`，防语义漂移）。

## 三对照臂与受限窗口

`runAgent` 的 `mode`（`src/agent/loop.ts`）：

- **`react`**：只有任务工具，无治理工具、无 runtime 安全网；context 纯累积。超过 `hardWindowTokens` 即**提前终止**（复现论文"窗口耗尽→对话终止"）。
- **`threshold`**：有 runtime 安全网（超阈值自动 offload 最大 tool_result）但**不给 agent context_update 工具**——被动压缩。
- **`cpat`**：完整主动治理——context_update 工具 + 压力阶梯 + 边界维护 pass + 软强制。

预算压力阶梯（70% soft / 80% must_act / 95% critical runtime 兜底）。`hardWindowTokens` 模拟固定窗口，
是测出 CPAT 价值的关键——窗口必须受限，ReAct 才会"崩"。

## 代码结构

```
src/types.ts               全部协议类型（block / operation / journal / config）
src/runtime/stores.ts      ContentStore（单份）+ Journal（append-only）
src/runtime/blocks.ts      BlockStore：寻址、排序、chainOf 链识别、ingestion
src/runtime/patch.ts       校验器 + 事务式 applier（CPAT 核心，8 op + 护栏）
src/runtime/view.ts        消息渲染、manifest、budget report 构建
src/runtime/runtime.ts     ContextRuntime 总控：budget 监控、critical 兜底、journal 记账
src/agent/contextTool.ts   context_update / artifact_get 的 tool schema 与归一化
src/agent/taskTools.ts     沙箱化任务工具（list_dir / read_file / grep_search / write_file / bash）
src/agent/loop.ts          agent 主循环、三臂、硬窗口、三层提示、指标收集
src/deepseek/client.ts     OpenAI 兼容客户端（strict tools 失败自动降级）
src/cli.ts                 CLI 入口 + TUI 分发
bench/deepresearch.ts      自建深度研究数据集 + 三臂双扫 runner
bench/f1.ts                LongBench 等价 token F1 / exact-match 判分
research/                  论文级研究档案（问题、假设、CAT 对照、每次实验设计与结果）
llmdoc/                    项目知识库（架构文档、decisions、reflections）
ARCHITECTURE.md            context_update 工具的设计与实现详解
```

## 文档导航

- [`blog/cpat-from-idea-to-result.md`](https://github.com/TokenRollAI/CPAT/blob/main/blog/cpat-from-idea-to-result.md) — **从想法到结果的全过程复盘**：受 CAT 论文启发、block/工具设计、五组失败实验、方向修正、最终验证。
- [`ARCHITECTURE.md`](https://github.com/TokenRollAI/CPAT/blob/main/ARCHITECTURE.md) — **context_update 怎么设计的**：8 个 op、数据模型、事务引擎、护栏、扩展指南。
- [`research/`](https://github.com/TokenRollAI/CPAT/tree/main/research) — 研究全过程（[研究日志](https://github.com/TokenRollAI/CPAT/blob/main/research/00-research-log.md)、[双扫结果](https://github.com/TokenRollAI/CPAT/blob/main/research/experiments/04-full-double-sweep.md)）。
- [`llmdoc/`](https://github.com/TokenRollAI/CPAT/tree/main/llmdoc) — 稳定项目知识（[核心概念](https://github.com/TokenRollAI/CPAT/blob/main/llmdoc/must/core-concepts.md)、[运行时](https://github.com/TokenRollAI/CPAT/blob/main/llmdoc/architecture/context-runtime.md)、decisions）。
