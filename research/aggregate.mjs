/**
 * Aggregate all deepresearch run results.json into one comparison table.
 * Usage: node research/aggregate.mjs
 * Scans runs/deepresearch-*/results.json and prints a sorted table.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const runsDir = "runs";
const rows = [];
for (const d of readdirSync(runsDir)) {
  if (!d.startsWith("deepresearch-")) continue;
  const f = join(runsDir, d, "results.json");
  if (!existsSync(f)) continue;
  try {
    const { summary: s } = JSON.parse(readFileSync(f, "utf8"));
    rows.push(s);
  } catch { /* skip partial */ }
}

rows.sort((a, b) => a.hard_window - b.hard_window || a.mode.localeCompare(b.mode));

const cols = [
  ["window", (s) => String(s.hard_window)],
  ["mode", (s) => s.mode],
  ["corpus_tok", (s) => String(s.corpus_tokens_est)],
  ["term_early", (s) => String(s.terminated_early)],
  ["answered", (s) => `${s.questions_answered}/${s.questions}`],
  ["accuracy%", (s) => String(s.accuracy)],
  ["revisit%", (s) => String(s.revisit_accuracy)],
  ["peak_tok", (s) => String(s.peak_view_tokens)],
  ["total_prompt", (s) => String(s.total_prompt_tokens)],
  ["off/res/comp", (s) => `${s.offloads}/${s.restores}/${s.compacts}`],
];

const header = cols.map(([h]) => h).join("\t");
console.log(header);
console.log(cols.map(() => "---").join("\t"));
for (const s of rows) console.log(cols.map(([, f]) => f(s)).join("\t"));
console.log(`\n${rows.length} runs aggregated.`);
