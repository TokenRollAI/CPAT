# 0003：新增 restore / merge / fold 三个原子 op

- **状态**：已采纳（落地并通过测试，npm test 12 通过、tsc 无错）
- **日期**：2026-06
- **缘起**：doc-gap #5（候选新原子 op 调研）的调研结论落地

## 背景

doc-gap #5 记录了一轮「额外 context-reduction 原子操作」调研，需决定是否扩展 `ContextOperation` 联合类型。调研产出后，从候选集中**采纳三个、明确否决/暂缓其余**。

## 决策：采纳 restore / merge / fold

三者均落入 `src/types.ts` (`ContextOperation`) + `src/runtime/patch.ts` 引擎，**刻意不碰 ContextBlock schema**，与单份存储/链原子性自洽。

- **`restore`**：`payload_offload` 必备的逆操作。把已 offload 块从 ContentStore 把全文回填为 inline string。零拷贝（payload 仍在 `<id>@v<version>` 键下，offload 从不改 version），version 不变，只翻 content，永不破链。
- **`merge`**：依据 Mem0 式语义去重——把 ≥2 个语义重叠/重复块归并为一个 canonical 块，源块 archived 可恢复；`resolution` 区分 `update`（合并）与 `contradiction`（新信息推翻旧的）。
- **`fold`**：依据 Context-Folding 思路——把一段连续的、已完成子任务轨迹折叠成带 scope 的 summary，区间整体 archived（unfold 入口 = `set_visibility=model`）。与 compact 的区别仅在「ids 连续」+ scope_label。

## 关键设计张力

三者要么走「**归档源块 + 建 summary**」（merge/fold，与 compact 共用 `collapseIntoBlock` helper），要么走「**零拷贝视图翻转**」（restore，offload 的镜像）。**刻意不引入任何新 ContextBlock 字段、不改数据模型**——把新能力压在既有的 visibility/version/content 三态上，保持链原子性与单份存储不变量不破。compact 同步重构为复用 `collapseIntoBlock`，行为不变。

默认启用集合从 3 → 6（`compact`/`payload_offload`/`set_visibility`/`restore`/`merge`/`fold`）；`replace`/`redact` 仍默认 gated。op 总数 5 → 8。

## 否决 / 暂缓的候选

- **`clear`**：与 `set_visibility=archived` 功能重叠约 70%，否决。
- **`supersede` / `set_retention`**：需扩展 ContextBlock 数据模型（新字段），与「不碰 schema」原则冲突，**暂缓**，留待下轮设计讨论。
- **`prune` / `compress_lossy` / fork-join 类**：暂缓。

## 后果与守护

- 新拒绝规则：`not_offloaded` / `artifact_missing`（restore）、`merge_output` / `merge_arity` / `merge_resolution`（merge）、`fold_output` / `fold_scope` / `fold_range`（fold）。
- schema 新字段 `resolution`（merge）、`scope_label`（fold）；tool description 加入按可逆性升序的操作选择指南。
- SYSTEM_PROMPT 操作清单补入三者，固化优先级行「archive < offload < compact/fold/merge」。
- 由 test 10（restore 往返）、test 11（merge 归并 + arity）、test 12（fold 连续区间 + 拒非连续）守护。
- 详细规则与引擎机制见 `llmdoc/architecture/context-runtime.md` §1、§4；schema 归一化见 `llmdoc/architecture/agent-protocol.md` §2。
