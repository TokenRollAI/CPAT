# 0001：单份内容存储 + 事件日志（取代三份拷贝的 raw log）

- **状态**：已采纳（用户决策，选项 B）
- **日期**：2026-06（原型阶段，零 commit）

## 背景

设计文稿采用 append-only raw log 全文记录：同一 payload 会存三份——raw log 全文、ContextBlock 内容、offload 后的 artifact store 拷贝（3x 冗余）。

## 决策

选项 B：**单一 ContentStore + append-only Journal**。

- 每个 payload 在 ingestion 时只写一次，键 `<blockId>@v<version>`（`src/runtime/stores.ts` `ContentStore`）。
- `payload_offload` 因此退化为**零拷贝视图翻转**：payload 已在当前 version 键下，只把 block 的 `content` 从 inline string 换成指向该键的 `ArtifactRef`，瞬时完成。
- append-only 的溯源/审计语义由 `Journal`（`journal.jsonl`）承担：只记元数据 + content key，从不复制全文；agent 没有任何 op 能触碰它；所有 patch（agent 与 runtime）可完整重放。

## 后果

- 存储与 offload 成本从 O(payload) 降为 O(1)；`artifact://<key>` 成为唯一恢复通道（`artifact_get` 工具）。
- redact/replace 使 `version += 1` 并写新 content key，历史版本保留在 ContentStore。
- 由 test 1（zero-copy and recoverable）守护。
