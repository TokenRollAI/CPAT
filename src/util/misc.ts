/**
 * Token estimation without a tokenizer dependency.
 *
 * DeepSeek's published rule of thumb: 1 English char ≈ 0.3 token,
 * 1 CJK char ≈ 0.6 token. This is only used for block-level accounting and
 * budget thresholds; per-call ground truth comes from API usage.prompt_tokens
 * and is reconciled by the budget monitor.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x2e80) ascii += 1;
    else wide += 1;
  }
  return Math.max(1, Math.ceil(ascii * 0.3 + wide * 0.6));
}

let counter = 0;

/** Monotonic, human-readable ids: tool_017, assistant_023, summary_004 ... */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter).padStart(3, "0")}`;
}

export function resetIdCounter(): void {
  counter = 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
