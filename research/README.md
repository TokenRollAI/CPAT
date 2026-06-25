# CPAT 研究档案（Research History）

> 本目录把 CPAT（Context Patch as Tool）当作一项**对 agent 系统的论文级研究**来记录：
> 问题、假设、实验设计、结果、对失败的诚实分析、以及每一次方向修正的理由。
> 目标不是"证明 CPAT 好"，而是**搞清楚 CPAT 在什么条件下有价值、在什么条件下没有**。

## 阅读顺序

1. [`00-research-log.md`](00-research-log.md) — 按时间顺序的研究叙事（主线，必读）。
2. [`01-problem-and-hypotheses.md`](01-problem-and-hypotheses.md) — 研究问题与可证伪的假设。
3. [`02-related-work.md`](02-related-work.md) — 相关工作，尤其 CAT 论文（arXiv:2512.22087）的对照。
4. [`design/`](design/) — 实验设计文档（每次重做一份）。
5. [`experiments/`](experiments/) — 每组实验的结果记录（含原始数字 + 解读）。
6. [`figures/`](figures/) — 图表数据。

## 一句话现状（持续更新）

> 截至 2026-06-14：前五组实验（V4 Pro 百万窗口）**未能**证明 CPAT 任务质量优于 ReAct，
> 仅证明省 token。根因诊断为**实验范式错误**——未施加受限窗口，ReAct 永不"撑爆"，
> 抹掉了 CPAT 的核心价值场景。正依据 CAT 论文（arXiv:2512.22087）的"bounded context
> budget"范式**重做实验**：硬窗口（32K/200K）+ 自建深度研究长程任务 + 三对照臂
> （ReAct / 阈值压缩 / CPAT）。假设：受限窗口下 ReAct 会因上下文耗尽提前终止/退化，
> CPAT 靠主动可逆治理维持长程推理。

## 与代码的关系

- 核心实现：`src/agent/loop.ts`（`runAgent`、`AgentMode`）、`src/runtime/`。
- 实验框架：`bench/`（`longbench.ts` / `multidoc.ts` / `longloop.ts` / 新增 `deepresearch.ts`）。
- 稳定项目知识沉淀在 `llmdoc/`（decisions/reflections）；本目录是**研究过程**的完整记录，
  比 llmdoc 更细，保留失败路径与中间思考。
