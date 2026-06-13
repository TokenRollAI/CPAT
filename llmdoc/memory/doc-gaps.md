# 文档缺口（doc-gaps）

记录可执行的已知缺口。每条带闭合标准；解决后移除或标记关闭。

## 开放缺口

1. **H1 对比基线缺失**
   仓库尚无阈值压缩基线实现，H1（agent 自选 patch vs 阈值压缩）无法对照实验。
   闭合标准：实现 threshold-compression 基线 runner，并补一篇 guides/对比实验流程文档。

2. **token 估算启发式未对真实 tokenizer 验证**
   `src/util/misc.ts` (`estimateTokens`) 的 0.3/0.6 系数仅靠 `prompt_tokens` 在线校准（钳制 [0.5, 2]），未与 DeepSeek 真实 tokenizer 离线比对。
   闭合标准：对一组样本测量估算误差分布，必要时调系数；结论落入 reference 文档。

3. **redact / replace 路径无真实运行证据**
   两者默认关闭，行为仅由 patch.ts 代码与 test 4/5 覆盖；redact 的 `version+=1` 写新 content key 路径无正向测试。
   闭合标准：开 `--allow-redact`/`--allow-replace` 跑一次真实任务并补正向测试。

4. **H3 cache 命中需要更大预算的 run**
   现有 run 的 `cache_hit_ratio` 仅 0.235–0.264（小预算 → patch 频繁 → prefix 改写多 → 命中低，符合预期 caveat）。
   闭合标准：用接近真实的 `--max-context` 跑对照 run，记录命中率随预算的变化。

## 已关闭

- **候选新原子 op 调研**（原 #5，2026-06 关闭）：调研已产出，采纳 restore/merge/fold、否决/暂缓其余，记入 `memory/decisions/0003-restore-merge-fold-ops.md`，并更新 `architecture/context-runtime.md` §1/§4 与 `architecture/agent-protocol.md` §2/§7。
