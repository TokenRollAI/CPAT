/**
 * LongBench-equivalent token-level F1 scoring for QA, ported to pure TS.
 *
 * Mirrors LongBench v1's `qa_f1_score` (metrics.py):
 *   normalize_answer -> lowercase, strip English punctuation, drop the
 *   articles a/an/the, collapse whitespace; tokenize on whitespace; compute
 *   token-multiset F1; take the max over all ground-truth answers.
 *
 * Zero dependencies — only the standard JS runtime.
 */

// SQuAD/LongBench `normalize_answer`, faithfully reproduced:
//   1. lowercase
//   2. remove punctuation (Unicode-agnostic ASCII punctuation set used by the
//      original `string.punctuation`)
//   3. remove the articles a / an / the (as standalone words)
//   4. collapse runs of whitespace to a single space, trim ends
export function normalizeAnswer(s: string): string {
  const lower = s.toLowerCase();
  // string.punctuation in Python: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
  const noPunct = lower.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, " ");
  const noArticles = noPunct.replace(/\b(a|an|the)\b/g, " ");
  const collapsed = noArticles.replace(/\s+/g, " ").trim();
  return collapsed;
}

function tokenize(s: string): string[] {
  const norm = normalizeAnswer(s);
  return norm.length === 0 ? [] : norm.split(" ");
}

/** Token-multiset intersection count (Python Counter & Counter -> sum). */
function commonTokenCount(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      common += 1;
      counts.set(t, left - 1);
    }
  }
  return common;
}

/** Single prediction-vs-single-reference token F1 (LongBench `f1_score`). */
function f1Single(prediction: string, groundTruth: string): number {
  const predTokens = tokenize(prediction);
  const gtTokens = tokenize(groundTruth);
  const numSame = commonTokenCount(predTokens, gtTokens);
  if (numSame === 0) return 0;
  const precision = numSame / predTokens.length;
  const recall = numSame / gtTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * LongBench `qa_f1_score`: max token F1 of `prediction` against each reference
 * in `groundTruths`. Returns a value in [0, 1] (multiply by 100 for the
 * reported metric).
 */
export function qaF1Score(prediction: string, groundTruths: string[]): number {
  if (groundTruths.length === 0) return 0;
  let best = 0;
  for (const gt of groundTruths) {
    const score = f1Single(prediction, gt);
    if (score > best) best = score;
  }
  return best;
}
