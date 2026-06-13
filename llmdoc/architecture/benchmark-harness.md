# 有效性验证子系统（benchmark-harness）

CPAT 是否真的优于无治理的标准 agent？这个子系统提供对照实验能力：一个 **ReAct 对照臂** + **连环多问** + 独立的 `bench/` runner。代码分两处：核心改动在 `src/agent/loop.ts`（AgentMode、followups），其余全在 `bench/`（独立模块，只 import `src/`，不改核心运行时）。运行时核心见 `llmdoc/architecture/context-runtime.md`，agent 协议见 `llmdoc/architecture/agent-protocol.md`。

> 价值验证的场景约束（语料须超工作窗口数倍 + 信息不可 grep 跳过 + 有回访模式）见 `llmdoc/memory/decisions/0005-cpat-value-requires-superwindow-scale.md`。五组实验跑完后的最终结论(CPAT 未证明质量优于 ReAct、重定位为成本优化策略)见 `llmdoc/memory/reflections/2026-06-13-cpat-vs-react-inconclusive.md` 与 decision `0006-reposition-cpat-as-cost-optimization.md`。

## 1. ReAct 对照臂（`src/agent/loop.ts` `AgentMode`）

`export type AgentMode = "cpat" | "react"`；`runAgent` 新增可选 `mode`（默认 `"cpat"`）。react 臂是衡量「CPAT 主动治理净增量」的对照组——**完全旁路治理**：

- 只注册 task tools（`taskToolDefs`），**不注册** `context_update` / `artifact_get`。
- 用极简 `REACT_SYSTEM_PROMPT`（仅 block-tag/manifest 纪律 + task policy，**无任何治理指引**）。
- 旁路 budget 监控与 runtime 兜底：`checkBudget()` 不调用、`pressure` 恒为 `"ok"`、must_act 软强制 nudge 不触发、final-flush 也跳过 `checkBudget`。
- context **纯累积**——读过的所有 tool 输出永远留在视图里，直到撑爆模型真实窗口。

同一任务跑 `mode=cpat` 与 `mode=react` 即得对照。注意:react 臂不是「阈值压缩基线」(那个仍缺,见 doc-gaps),而是更强的「零治理」对照。

## 2. 连环多问（`src/agent/loop.ts` `runAgent` followups）

`runAgent` 新增可选 `followups?: string[]`。语义:主 task 得到无 tool_calls 的最终答案后**不返回**,而是 `ingestUser(下一个问题)` 在**同一 runtime** 上继续循环,context 跨问题累积,全部问完才返回。

- `RunResult` 新增 `answers: string[]`(每问一答,顺序 `[主task, ...followups]`);保留 `answer`(= 最后一问答案)向后兼容。
- `maxTurns` 是**跨所有问题共享**的总轮数预算——runner 须设足够大。

**设计动机**:单轮 `runAgent` 无法触发「先 offload、后 restore」的回访模式(读一次就用、无回访,restore 永远为 0)。连环多问让 **offload→restore 可逆链**成为可被测试的路径:早先问题 offload 的文档,被后续问题以 restore/artifact_get 取回。这是 CPAT 区别于 ReAct 的关键能力(ReAct 要么背着全部 context 撑爆、要么永久丢弃)。

## 3. `bench/` runner 与评分

全部为独立可执行模块（顶层 `main().catch(...)`），从项目根运行(读 `.env`),落盘 `runs/<prefix>-<ISO时间戳>/`(含每样本 corpus + `results.json`)。tsconfig `include` 已含 `bench/**/*.ts`;`package.json` 的 `"bench"` script 指向 `longbench.ts`。

### `bench/f1.ts` — 评分（纯函数,零依赖）

LongBench v1 等价 token F1,忠实复刻其 `metrics.py`:

- `normalizeAnswer`:小写 → 去 ASCII 标点 → 去冠词 a/an/the → 折叠空白。
- `qaF1Score(prediction, groundTruths[])`:对每个参考算 token-multiset F1,取最大值,返回 `[0,1]`(报告时 ×100)。
- 由 `bench/f1.test.ts`(6 个离线单测)守护:精确匹配=1、完全不匹配=0、部分重叠严格介于、归一化、多参考取 max、空输入=0。注:`npm test` 只 glob `test/*.test.ts`,该测试经 `node bench/f1.test.ts` 直接跑。

### `bench/longbench.ts` — 单文档 QA runner

LongBench v1 单文档 QA(multifieldqa_en / narrativeqa / qasper)。把单篇长文落 `corpus/document.txt`,agent 用 read_file/grep 读后作答,F1 判分。flags:`--data`(必填 jsonl)、`--n`(默认 5)、`--mode cpat|react`、`--model`(默认 deepseek-v4-pro)、`--max-context`(默认 50000)、`--turns`(默认 30)。summary 报告 avg_f1 / avg_prompt_tokens / avg_cache_hit_ratio / agent_patches vs runtime_fallbacks。

### `bench/multidoc.ts` — 多文档检索 runner

N 篇长文档(1 篇 gold + k 篇干扰)拼成 corpus,答案只在 gold 篇,**gold 位置轮转**(`buildCorpus` 的 `goldSlot = target % (k+1)`,无 RNG、resume-safe)防位置偏置;任务强制跨文件 `list_dir`/`grep_search`/`read_file` 定位。flags 同 longbench,另加 `--distractors`(默认 4),`--max-context` 默认 60000。设计意图:理论上 ReAct 会累积每篇读过的文档(被干扰项稀释),CPAT 可 offload 已排除的文档。

### `bench/longloop.ts` — 长程连环多问 runner（CPAT 的目标场景）

大语料(`loadUniqueBooks` 按开头 300 字去重 narrativeqa,默认 20 本书 ~500k token,远超工作预算)+ 连续 M 问(`scheduleQuestions` 跨语料散布并**保证至少一次回访**:末问重访首篇)。用 `runAgent` 的 `followups` 在**同一 runtime** 上吞吐,逐问 F1。task 文本显式引导:读完暂不用的文档 `payload_offload`(而非 compact,保留全文供回访逐字重读)、后续问题需要时 restore/artifact_get 取回。

显式上报 `ops_by_type.payload_offload` / `restore` 计数(衡量**可逆吞吐**这条 CPAT 独有路径)、token 吞吐、`api_error`(ReAct 在 ~500k 语料上可能撑爆真实窗口→ API 400,被捕获记录而非崩溃)。这是单文档/多文档 runner **无法**制造的场景:信息一次装不进预算、且回访让 offload→restore 成为承重路径。

**已实跑(2026-06-14)**:25 万级配置(实测 ~30.7 万 token 语料、6 连环问)已在 cpat/react 双臂上跑完,是有效性验证的收官实验。结果支撑了 CPAT 重定位结论——即便 5.1 倍语料,restore 仍为 0、ReAct 未撑爆(`api_error`=0),CPAT 只省 token 不提质量。不在此展开数据,详见 reflection `2026-06-13-cpat-vs-react-inconclusive.md` 与 decision `0006-reposition-cpat-as-cost-optimization.md`。

## 4. 子系统边界

- `bench/` 模块**只读** `src/` 的 `runAgent` / `DeepSeekClient` / `loadDeepSeekEnv` / `CpatConfig`,绝不改核心运行时。
- 唯一进入核心的改动是 `src/agent/loop.ts` 的 `AgentMode`(对照臂)与 `followups`(连环多问)——两者都是 `runAgent` 的可选入参,默认行为(`mode="cpat"`、无 followups)与改前一致。
- runner 的所有 `CpatConfig` 硬编码压力比例 0.7/0.8/0.95、`strictTools: true`,与 CLI 默认一致。
