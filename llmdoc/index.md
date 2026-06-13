# llmdoc 索引

CPAT 项目文档全局地图。启动必读顺序见 `llmdoc/startup.md`。

## must/ — 每次任务必读

- `must/core-concepts.md`：CPAT 协议、block/view/单份存储心智模型、context_update、压力阶梯、关键术语。

## overview/ — 项目身份与边界

- `overview/project-overview.md`：命题、实验假设 H1-H4、仓库布局、开发工作流、运行产物、当前状态。

## architecture/ — 流程、边界、不变量

- `architecture/context-runtime.md`：运行时核心深度文档——数据模型、ContentStore+Journal、chainOf、patch 事务引擎全部校验规则、预算监控、视图构建。
- `architecture/agent-protocol.md`：agent 侧契约——SYSTEM_PROMPT、工具 schema 与归一化、任务工具沙箱、DeepSeek 客户端、主循环、指标语义、测试清单。

## guides/ — 可重复工作流

（暂无。）

## reference/ — 稳定查询事实

（暂无。）

## memory/ — 过程记忆

- `memory/decisions/0001-single-copy-content-store.md`：单份存储 + Journal 取代三份拷贝 raw log。
- `memory/decisions/0002-offload-keeps-kind.md`：offload 不改 kind（API-400 回归修复）。
- `memory/decisions/0003-restore-merge-fold-ops.md`：新增 restore/merge/fold 三个 op（不碰 ContextBlock schema）；否决/暂缓 clear、supersede 等。
- `memory/doc-gaps.md`：已知文档/实验缺口与闭合标准。
- `memory/reflections/`：reflector 维护（暂空）。

## 约定

- 项目文档简体中文，技术名词/代码英文。
- 引用格式 `path/to/file.ext` (`SymbolName`)；行号仅在消歧义时使用。
- `.llmdoc-tmp/` 是临时调查缓存，不入索引。
