# 实验设计 04：让主动 CPAT 胜出被动 threshold 的任务

> 目标：构造一个"被动压缩会丢关键信息、主动治理能保住"的任务，检验 H-reversible 与
> "主动 > 被动"（论文 53.8 → 57.6 的对应）。这是 CPAT 区别于 threshold 的核心卖点。

## 为什么 smoke-v2 里 cpat 没赢 threshold

1. **threshold 的盲点没被利用**：threshold 机械地 offload 最大/最旧的 tool_result，
   不懂哪些后面还要用。但 smoke-v2 的任务里，被 offload 的文档**始终能重新 read_file**，
   所以丢了也无所谓——re-read 即可。
2. **restore 无用武之地**：信息源是静态文件，re-read 比 restore 更自然。

## 让 CPAT 赢的三个必要条件

### 条件 A：关键信息只存在于 context，文件中不可直接重得
让信息**经由一个过程产生**，而非静态躺在文件里。手段：
- 任务工具产出**派生信息**（如计算结果、跨文件比对的中间结论），原始文件没有这个结论。
- 或：一次性"观测"——读取后文件内容会变/不可重复读。

实现选择：**让关键事实是 agent 自己算出来的中间结论**。例如：
- 阶段一：agent 逐篇读 dossier，**自己记录**每篇的 (codename, accuracy)。
- 关键：dossier 文件很大且只在被读时把数字暴露在 tool_result 里；后面要用时，
  若那个 tool_result 被 offload 且没 restore，agent 就得重读整篇大文件（昂贵/可能超窗口）。
- threshold 被动 offload 了早期 tool_result → 后面 revisit 时信息不在 context →
  被迫重读大文件 → 可能再次溢出 → 失败或更贵。
- cpat 可以：(a) 主动把读过的 dossier compact 成"codename→accuracy"小摘要保住关键数字，
  (b) 或 offload 后在 revisit 时精准 restore。

### 条件 B：revisit 的信息密度高到"重读全文"不划算
让 revisit 需要的是某篇**大文档里的一个小事实**。重读全文 = 重新吞 N 千 token。
- threshold：丢了就得重读全文 → 昂贵 + 可能溢出。
- cpat：compact 时保住那个小事实 → 几乎零成本答对。
**这把"主动选择保什么"的价值直接货币化为 token 差异甚至准确率差异。**

### 条件 C：窗口紧到"全留着"不可行
窗口必须小于"所有关键 tool_result 全保留"的总量，逼迫必须压缩。
- 但又不能小到 threshold 被动压缩就够——要让**压缩的选择质量**有区分度。

## 具体任务设计 v2（deepresearch 的变体或新 runner）

**核心改动**：把"答案直接写在 dossier 里"改成"**答案需要 agent 跨文档综合 + 记住中间结论**"。

方案：**两阶段"研究综述"任务**
1. **阶段一（建立笔记）**：要求 agent 逐篇读 20 篇 dossier，每篇产出一句话发现。
   读每篇会产生一个大 tool_result（整篇 4-6K token）。
2. **阶段二（综合问答）**：问一系列**需要回到具体某几篇细节**的问题，其中：
   - 关键事实埋在大文档的**非显眼位置**（不是头部摘要，而是某个 Section 里）。
   - 重读全文代价高（大文档）。
   - threshold 若已 offload 该文档的 tool_result，必须重读全文。
   - cpat 可在阶段一就把每篇 compact 成保留关键事实的小摘要。

**判分**：仍用 exact-match（埋在 Section 里的精确数值/实体）。
**指标**：accuracy + total prompt tokens（重读全文会让 threshold 的 token 飙升）+ restore 数。

## 风险

- prompt-only CPAT 的 agent 可能不会"聪明地选择保什么"——它没被训练。
  若 agent 主动 compact 时把关键事实也丢了，cpat 也会输。**这是真实风险，结果可能仍是 cpat 不赢。**
  但即便如此，"为什么 prompt-only 不够、需要训练"本身是有价值的研究结论（呼应论文用 SFT）。
- 对策：在 CPAT 的 boundary-maintenance prompt 里强化"保留每篇的关键数字/实体"。

## 成功判据

- **强**：cpat accuracy > threshold accuracy（主动选择保住了被动会丢的信息）。
- **中**：cpat accuracy ≈ threshold 但 cpat total tokens 明显更低（主动避免了重读全文）。
- **弱/诚实负面**：cpat ≈ threshold，无显著差异 → 记录"prompt-only 主动治理不优于被动"，
  指向"需要训练"（论文结论）。
