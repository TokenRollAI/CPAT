# llmdoc 索引

CPAT 项目文档全局地图。启动必读顺序见 `llmdoc/startup.md`。

## must/ — 每次任务必读

- `must/core-concepts.md`：CPAT 协议、block/view/单份存储心智模型、context_update、压力阶梯、关键术语。

## overview/ — 项目身份与边界

- `overview/project-overview.md`：命题、实验假设 H1-H4、仓库布局、开发工作流、运行产物、当前状态。

## architecture/ — 流程、边界、不变量

- `architecture/context-runtime.md`：运行时核心深度文档——数据模型、ContentStore+Journal、chainOf、patch 事务引擎全部校验规则、预算监控、视图构建。
- `architecture/agent-protocol.md`：agent 侧契约——SYSTEM_PROMPT、工具 schema 与归一化、任务工具沙箱、DeepSeek 客户端、主循环、指标语义、测试清单。
- `architecture/benchmark-harness.md`：有效性验证子系统——ReAct 对照臂（`AgentMode`）、连环多问（`followups`）、`bench/` 三个 runner（longbench/multidoc/longloop）+ f1 评分。

## guides/ — 可重复工作流

（暂无。）

## reference/ — 稳定查询事实

（暂无。）

## memory/ — 过程记忆

- `memory/decisions/0001-single-copy-content-store.md`：单份存储 + Journal 取代三份拷贝 raw log。
- `memory/decisions/0002-offload-keeps-kind.md`：offload 不改 kind（API-400 回归修复）。
- `memory/decisions/0003-restore-merge-fold-ops.md`：新增 restore/merge/fold 三个 op（不碰 ContextBlock schema）；否决/暂缓 clear、supersede 等。
- `memory/decisions/0004-budget-below-steady-state.md`：实验方法论——治理对照实验的 `--max-context` 必须低于任务稳态 token，否则压不出治理。
- `memory/decisions/0005-cpat-value-requires-superwindow-scale.md`：CPAT 价值验证须在「超工作窗口规模 + 信息不可 grep 跳过 + 有回访模式」场景下进行；核心可测能力是 offload→restore 可逆吞吐。longloop 25 万实验坐实 V4 Pro 百万窗口下无法构造该场景。
- `memory/decisions/0006-reposition-cpat-as-cost-optimization.md`：五组实验后把 CPAT 重新定位为上下文成本优化策略(省 token 35-57%)而非任务质量提升策略;restore 价值仍是开放问题。
- `memory/doc-gaps.md`：已知文档/实验缺口与闭合标准。
- `memory/reflections/`：reflector 维护。
  - `2026-06-13-agent-passive-under-pressure.md`：H1 失效模式实证——agent 在 must_act 压力下不主动 patch，全靠 runtime 兜底。
  - `2026-06-13-cpat-vs-react-inconclusive.md`：五组实验后的最终结论——CPAT 未证明任务质量优于 ReAct(稳定省 token 35-57%,F1 无一致优势);longloop 25 万收官数据 + ReAct append-only 在纯累积长任务上 cache 反更优(修正旧说法)+ restore 价值仍是开放问题。

## 约定

- 项目文档简体中文，技术名词/代码英文。
- 引用格式 `path/to/file.ext` (`SymbolName`)；行号仅在消歧义时使用。
- `.llmdoc-tmp/` 是临时调查缓存，不入索引。
