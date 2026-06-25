# 有效性验证子系统（benchmark-harness）

CPAT 是否真的优于无治理的标准 agent？这个子系统提供对照实验能力：一个 **ReAct 对照臂** + **连环多问** + 独立的 `bench/` runner。代码分两处：核心改动在 `src/agent/loop.ts`（AgentMode、followups），其余全在 `bench/`（独立模块，只 import `src/`，不改核心运行时）。运行时核心见 `llmdoc/architecture/context-runtime.md`，agent 协议见 `llmdoc/architecture/agent-protocol.md`。

> **当前 `bench/` 组成**：经代码整理后，`bench/` 只含 `deepresearch.ts`（当前唯一活跃 runner）+ `f1.ts`（评分纯函数）+ `f1.test.ts`（评分单测）。早期的 `longbench.ts` / `multidoc.ts` / `longloop.ts` 三个 runner 对应被范式修正推翻的前五组百万窗口实验，已删除；其设计与结果保留于 `research/` 档案与 `llmdoc/memory/` 历史记录。

> 价值验证的场景约束（语料须超工作窗口数倍 + 信息不可 grep 跳过 + 有回访模式）见 `llmdoc/memory/decisions/0005-cpat-value-requires-superwindow-scale.md`。前五组（百万窗口）的最终结论见 `0006-reposition-cpat-as-cost-optimization.md`；**受限窗口范式重做后的决定性突破**（治理>不治理两窗口成立、200K 下主动 CPAT 省 83% token）见 `0007-bounded-window-cpat-value.md` 与 `research/00-research-log.md`（阶段 2-6）。

## 1. 三对照臂（`src/agent/loop.ts` `AgentMode`）

`AgentMode = "cpat" | "react" | "threshold"`；`runAgent` 的可选 `mode`（默认 `"cpat"`）。三臂隔离「主动治理 vs 被动治理 vs 零治理」（契约速查见 `llmdoc/architecture/agent-protocol.md` §0）：

- **`react`（零治理）**：只注册 task tools、用极简 `REACT_SYSTEM_PROMPT`、**全旁路** budget 监控（`pressure` 恒 `"ok"`、不调 `checkBudget`），context 纯累积直到撑爆。
- **`threshold`（被动治理基线）**：同样不给 `context_update` / `artifact_get`、用 `REACT_SYSTEM_PROMPT`，但**保留 runtime 安全网**——`checkBudget()` 在 critical 时被动 force-offload 最大块。这是 H1 缺失已久的「阈值压缩基线」，把「主动 vs 被动治理」与「治理 vs 不治理」两个变量分开。
- **`cpat`（主动治理）**：注册 `context_update` + `artifact_get`、用含治理指引的 `SYSTEM_PROMPT`、`checkBudget()` 全程。

**硬窗口机制（`hardWindowTokens`）**：渲染 view 超过该 token 数时 react 臂被强制终止（复现 CAT 论文 arXiv:2512.22087「dialogue terminates early」），指标 `terminated_early` / `peak_view_tokens` 上报；threshold/cpat 靠安全网把 context 压回窗口内、不终止。**`taskToolNames` 过滤**：可只给 `list_dir`+`read_file`（去 grep），强制整篇读、无法选择性跳过——制造真正累积压力。

同一任务跑三臂即得完整对照。

## 2. 连环多问（`src/agent/loop.ts` `runAgent` followups）

`runAgent` 新增可选 `followups?: string[]`。语义:主 task 得到无 tool_calls 的最终答案后**不返回**,而是 `ingestUser(下一个问题)` 在**同一 runtime** 上继续循环,context 跨问题累积,全部问完才返回。

- `RunResult` 新增 `answers: string[]`(每问一答,顺序 `[主task, ...followups]`);保留 `answer`(= 最后一问答案)向后兼容。
- `maxTurns` 是**跨所有问题共享**的总轮数预算——runner 须设足够大。

**设计动机**:单轮 `runAgent` 无法触发「先 offload、后 restore」的回访模式(读一次就用、无回访,restore 永远为 0)。连环多问让 **offload→restore 可逆链**成为可被测试的路径:早先问题 offload 的文档,被后续问题以 restore/artifact_get 取回。这是 CPAT 区别于 ReAct 的关键能力(ReAct 要么背着全部 context 撑爆、要么永久丢弃)。

## 3. `bench/` runner 与评分

全部为独立可执行模块（顶层 `main().catch(...)`），从项目根运行(读 `.env`),落盘 `runs/<prefix>-<ISO时间戳>/`(含每样本 corpus + `results.json`)。tsconfig `include` 已含 `bench/**/*.ts`;`package.json` 的 `"bench"` script 指向 `deepresearch.ts`（`node bench/deepresearch.ts`）。当前 `bench/` 只含 `deepresearch.ts` + `f1.ts` + `f1.test.ts`。

### `bench/f1.ts` — 评分（纯函数,零依赖）

LongBench v1 等价 token F1,忠实复刻其 `metrics.py`:

- `normalizeAnswer`:小写 → 去 ASCII 标点 → 去冠词 a/an/the → 折叠空白。
- `qaF1Score(prediction, groundTruths[])`:对每个参考算 token-multiset F1,取最大值,返回 `[0,1]`(报告时 ×100)。
- 由 `bench/f1.test.ts`(6 个离线单测)守护:精确匹配=1、完全不匹配=0、部分重叠严格介于、归一化、多参考取 max、空输入=0。注:`npm test` 的 glob 已含 `bench/*.test.ts`(`node --test test/*.test.ts bench/*.test.ts`),该测试随 `npm test` 一起跑。

### 历史 runner（已删除）— longbench / multidoc / longloop

早期曾有三个 runner，对应被范式修正推翻的前五组百万窗口实验，**已从 `bench/` 删除**：

- `bench/longbench.ts` — 单文档 QA runner（LongBench v1）。
- `bench/multidoc.ts` — 多文档检索 runner（1 gold + k 干扰、gold 位置轮转防偏置）。
- `bench/longloop.ts` — 长程连环多问 runner（大语料 + `followups` 连续多问，曾实跑 25 万级语料收官）。

诊断出「百万窗口让 ReAct 永不溢出」是范式错误后，这三个 runner 被 `deepresearch.ts` 取代。其设计动机、flags 与实验结果保留于 `research/` 档案、decision `0005`/`0006` 及 `llmdoc/memory/reflections/` —— 这些是研究史，不在本文档复述。

### `bench/deepresearch.ts` — 受限窗口深度研究 runner（自建数据集，当前唯一活跃 runner）

诊断出前五组是范式错误（百万窗口让 ReAct 永不溢出）后新建。合成 dossier 语料（每篇含 codename / lead researcher / 精确 accuracy / dependency / Incident Log），`runAgent` 的 `followups` 连环问 12 个，全部**精确匹配判分**（`exactMatch` 复用 `f1.ts` 的 `normalizeAnswer`，gold 答案作为 prediction 的 token-substring 命中）。问题四类交织：`aggregate`（跨全部 dossier 求最高/最低/计数，强制读全部）、`cross`（跨文档依赖链）、`direct`、`revisit`（回访早期 dossier 深处的 incident code）。flags：`--mode react|threshold|cpat`（必填）、`--hard-window`（默认 200000）、`--docs`（默认 30）、`--questions`（默认 12）、`--doc-tokens`、`--turns`、`--model`（默认 deepseek-v4-pro）。落盘 `runs/deepresearch-<mode>-w<window>-<ts>/`（含 corpus + `results.json`），上报 `accuracy` / `terminated_early` / `peak_view_tokens` / `off/res/comp` 计数 / `fallbacks`。

这是单文档/多文档/longloop runner **无法**制造的场景：硬窗口让 ReAct 真正溢出提前终止、无 grep 强制累积、回访让信息散布全语料。

**决定性结果（全量双扫，2026-06-25）**：32K + 200K 两窗口 × 三臂 × 自建任务（12 问），数据来自真实 run 的 `results.json`：

| 窗口 | 臂 | terminated_early | accuracy | total prompt tokens | peak view tokens |
|---|---|---|---|---|---|
| 32K | react | true | **0%** | 31,740 | 75,089 |
| 32K | threshold | false | 100% | 305,434 | 27,077 |
| 32K | cpat | false | 100% | 464,041 | 19,233 |
| 200K | react | true | **8.3%** | 714,175 | 202,624 |
| 200K | threshold | false | 100% | **2,819,420** | 172,106 |
| 200K | **cpat** | false | **100%** | **488,333** | 25,542 |

- **治理 > 不治理（两窗口）**：react 提前终止 0%/8.3%，任何治理 → 100%。
- **200K 下主动 CPAT 效率碾压被动 threshold**：同 100%，cpat 488K vs threshold 2,819K token（省 83%）；机制是 threshold 被动等满才压、cpat 主动读完即 offload。
- **诚实标注**：32K 下 cpat 反比 threshold 贵（往返开销小窗口不回本）；restore 全程仍为 0。完整对照 `research/experiments/04-full-double-sweep.md`，修正 decision `0007-bounded-window-cpat-value.md`。

## 4. 子系统边界

- `bench/` 模块**只读** `src/` 的 `runAgent` / `DeepSeekClient` / `loadDeepSeekEnv` / `CpatConfig`,绝不改核心运行时。
- 唯一进入核心的改动是 `src/agent/loop.ts`：`AgentMode`（三对照臂）、`followups`（连环多问）、`hardWindowTokens`（硬窗口 + `terminated_early`/`peak_view_tokens` 指标）、`taskToolNames`（task 工具过滤）——全是 `runAgent` 的可选入参，默认行为（`mode="cpat"`、无 followups、无硬窗口、全 task tools）与改前一致。配套的语义漂移护栏在 `src/runtime/patch.ts`（见 context-runtime.md §4）。
- runner 的所有 `CpatConfig` 硬编码压力比例 0.7/0.8/0.95、`strictTools: true`,与 CLI 默认一致。
