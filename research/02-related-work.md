# 相关工作

## CAT — "Context as a Tool: Context Management for Long-Horizon SWE-Agents"
arXiv:2512.22087（Liu et al.）。**与 CPAT 几乎同构的工作，是本研究的主要对照与范式来源。**

### 核心思想
把上下文管理做成 agent 可调用的工具（`context` tool），在**有限上下文预算**下，
让 agent 在合适的里程碑**主动**把历史轨迹压缩成可执行的长期记忆。

### 工作区三段结构 `C(t) = (Q, M(t), I^(k)(t))`
- **Q（固定段）**：system prompt + 关键用户意图，不可压缩，逐字保留。
- **M(t)（长期记忆）**：历史轨迹的高保真摘要，由 context 工具更新。
- **I^(k)(t)（短期工作记忆）**：最近 k 次 ReAct 交互，全保真。

> 对照 CPAT：Q ≈ protected system/user 块；M ≈ compact/fold 产出的 summary 块；
> I ≈ 近期未治理的工作块。**CPAT 比 CAT 多了可逆性**（offload→restore），CAT 的压缩是有损单向的。

### 实验设置（本研究直接借鉴）
- **训练窗口 65,536 token**；推理**最多 500 轮**；实际 CAT 把 context 稳在 **~32-35K**。
- **长度控制 = step 数 × 窗口上限**（Table 3），不是语料大小。
- 基座 Qwen2.5-Coder-32B，temperature 0.0，OpenHands 框架。

### 对照臂与失效模式
- **ReAct**：无上下文管理，append-only。"**一旦窗口耗尽，对话提前终止**"——填满后无法纳入新信息。
- **Threshold-Compression**：超预定阈值才压缩，与 CAT 同方案但**被动触发**。

### 关键结果
| Table 2（SWE-Bench Verified, N=500, Pass@1） | |
|---|---|
| ReAct (32B) | 49.8 |
| Threshold-Compression (32B) | 53.8 |
| **CAT / SWE-Compressor (32B)** | **57.6** |

| Table 3（Max Steps → Tokens → Pass%） | Steps | Tokens | Pass |
|---|---|---|---|
| ReAct | 150 | 1.96M | 53.2 |
| ReAct | **500** | 2.54M | **48.8** ↓ |
| Threshold | 500 | 5.18M | 53.8 |
| **CAT** | **500** | 2.75M | **57.8** ↑ |

- **长程退化**：ReAct"60 轮后饱和退化"，CAT 持续上升（Figure 5）。
- 难度分层：medium/hard 上 CAT 增益更大（Figure 6）。
- CaT-Instruct：平均轨迹 87.4 步，平均 **4.22 次** context-mgmt 动作，压缩比 **~30%**（15585→4676 token）。

### 对本研究的指导（直接采纳的范式）
1. **必须卡死窗口**（32K-65K）——否则 ReAct 不会"提前终止"，测不出差异。这是前五组实验的根本缺失。
2. **三对照臂**：ReAct / Threshold-Compression / CPAT。
3. **用 step×窗口 控长度**，关注**长程退化曲线**而非单点。
4. 关注 ReAct 的"**提前终止率**"作为核心因变量——这是 append-only 的死穴。

### CAT 与 CPAT 的差异（本研究的潜在贡献点）
- CAT 的压缩**单向有损**；CPAT 有 **offload→restore 可逆链**。若能设计出"先放下后回访"的任务，
  CPAT 理论上能处理 CAT 也处理不了的信息量。这是 CPAT 相对 CAT 的潜在增量（H-reversible）。
- CAT 靠**训练**（SFT 注入 context 动作）让 agent 学会用工具；CPAT 目前**纯靠 prompt + 软强制**，
  无训练。这意味着 CPAT 的 agent 主动治理率可能更低——前五组实验确实观察到这点（agent 常不主动）。
  **这是一个重要的对照维度：未训练的 prompt-only CPAT 能走多远。**

## 其他相关工作（前期调研，详见早先报告）
- The Complexity Trap (arXiv:2508.21433)：observation-masking 常不输 LLM 摘要——治理复杂度未必值得。
- Manus / Letta(MemGPT) / Mem0 / Generative Agents / RAPTOR：各类记忆与压缩操作分类学。
- Anthropic Context Editing / Memory tool：生产级 clear_tool_uses / compaction / 外部记忆。
