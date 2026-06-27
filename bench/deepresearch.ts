/**
 * Synthetic deep-research corpus generator + multi-question long-horizon runner.
 *
 * WHY synthetic (not LongBench): the earlier experiments showed (a) token-F1 on
 * narrativeqa short answers is too noisy to separate arms, and (b) tasks where
 * one grep finds the answer never force context accumulation. This generator
 * builds a corpus with PRECISELY MATCHABLE planted facts and questions that
 * require reading many documents and REVISITING earlier ones — the conditions
 * under which a bounded window actually bites (CAT paper, arXiv:2512.22087).
 *
 * Each document is a "research dossier" on a fictional project. Planted facts:
 *   - a unique project codename
 *   - a lead researcher name
 *   - a numeric result (e.g. "accuracy 73.4%")
 *   - a dependency on ANOTHER project (creates cross-document chains)
 * Plus a lot of filler prose so each doc is large (forces accumulation).
 *
 * Questions (exact-match scored):
 *   - direct: "What is the lead researcher of project <codename>?"
 *   - cross-doc: "Project <A> depends on project <B>; what is <B>'s numeric result?"
 *   - revisit: a later question returns to a project asked about much earlier,
 *     after many intervening docs — this is where react (window exhausted) and
 *     passive compaction lose the fact, and cpat can restore it.
 *
 * Deterministic (seeded by index, no RNG) so runs are reproducible/resumable.
 *
 * Usage (from project root):
 *   node bench/deepresearch.ts --mode cpat|react|threshold --hard-window 200000
 *        [--docs 30] [--questions 12] [--doc-tokens 12000] [--turns 120]
 *        [--model deepseek-v4-pro]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CpatConfig } from "../src/types.ts";
import { loadDeepSeekEnv } from "../src/util/env.ts";
import { DeepSeekClient } from "../src/deepseek/client.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentMode } from "../src/agent/loop.ts";
import { normalizeAnswer } from "./f1.ts";

interface Args {
  mode: AgentMode;
  hardWindow: number;
  docs: number;
  questions: number;
  docTokens: number;
  turns: number;
  model: string;
  dryRun: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Deep-research long-horizon benchmark for CPAT

Usage:
  node bench/deepresearch.ts --mode cpat|react|threshold [options]

Options:
  --mode <m>           react | threshold | cpat (required).
  --hard-window <n>    Hard context window in tokens (default 200000).
  --docs <k>           Number of dossiers in the corpus (default 30).
  --questions <m>      Questions asked in sequence, incl. revisits (default 12).
  --doc-tokens <n>     Approx tokens per dossier (default 12000).
  --turns <n>          Max total agent turns across all questions (default 120).
  --model <name>       DeepSeek model (default deepseek-v4-pro).`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`unexpected argument "${a}"`);
    const key = a.slice(2);
    if (key === "dry-run") { bools.add(key); continue; } // value-less flag
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) usage(`flag --${key} needs a value`);
    flags.set(key, next);
    i++;
  }
  const mode = flags.get("mode") as AgentMode | undefined;
  const dryRun = bools.has("dry-run");
  if (!dryRun && mode !== "cpat" && mode !== "react" && mode !== "threshold") {
    usage(`--mode must be react | threshold | cpat`);
  }
  return {
    mode: (mode ?? "react") as AgentMode,
    hardWindow: Number(flags.get("hard-window") ?? 200000),
    docs: Number(flags.get("docs") ?? 30),
    questions: Number(flags.get("questions") ?? 12),
    docTokens: Number(flags.get("doc-tokens") ?? 12000),
    turns: Number(flags.get("turns") ?? 120),
    model: flags.get("model") ?? "deepseek-v4-pro",
    dryRun,
  };
}

// -- deterministic synthetic data ------------------------------------------

const CODENAMES = [
  "Aurora", "Basilisk", "Cobalt", "Drifter", "Ember", "Falcon", "Granite",
  "Halcyon", "Ironwood", "Juniper", "Kestrel", "Lantern", "Meridian", "Nimbus",
  "Obsidian", "Petrichor", "Quasar", "Riptide", "Solstice", "Tempest",
  "Umbra", "Vortex", "Wraith", "Xenon", "Yarrow", "Zephyr", "Anvil", "Beacon",
  "Cinder", "Dynamo", "Echo", "Flint", "Glacier", "Harbor",
];

const LEADS = [
  "Dr. Reyes", "Dr. Nakamura", "Dr. Okonkwo", "Dr. Volkov", "Dr. Singh",
  "Dr. Larsson", "Dr. Haddad", "Dr. Costa", "Dr. Park", "Dr. Bauer",
  "Dr. Moreau", "Dr. Ivanova", "Dr. Cohen", "Dr. Adebayo", "Dr. Tanaka",
  "Dr. Fischer", "Dr. Romano", "Dr. Khan", "Dr. Andersson", "Dr. Petrov",
  "Dr. Mendez", "Dr. Walsh", "Dr. Yamamoto", "Dr. Dubois", "Dr. Schmidt",
  "Dr. Novak", "Dr. Oliveira", "Dr. Kim", "Dr. Russo", "Dr. Hassan",
  "Dr. Lindqvist", "Dr. Marchetti", "Dr. Abebe", "Dr. Sato",
];

interface Dossier {
  slot: number; // doc_<slot>.txt (1-based)
  codename: string;
  lead: string;
  metricName: string;
  metricValue: string; // exact-match target, e.g. "73.4%"
  dependsOn: string; // another codename
  incidentCode: string; // a fact BURIED deep in a section, not in the header
}

function buildDossiers(n: number): Dossier[] {
  const out: Dossier[] = [];
  for (let i = 0; i < n; i++) {
    const codename = CODENAMES[i % CODENAMES.length] + (i >= CODENAMES.length ? `-${Math.floor(i / CODENAMES.length)}` : "");
    const lead = LEADS[i % LEADS.length];
    // deterministic metric value
    const val = (50 + ((i * 37) % 500) / 10).toFixed(1); // 50.0 .. 99.9
    // deterministic incident code, e.g. "INC-7Q42"
    const code = `INC-${((i * 911) % 9000 + 1000)}${String.fromCharCode(65 + (i % 26))}`;
    out.push({
      slot: i + 1,
      codename,
      lead,
      metricName: "primary benchmark accuracy",
      metricValue: `${val}%`,
      dependsOn: CODENAMES[(i + 7) % Math.min(n, CODENAMES.length)],
      incidentCode: code,
    });
  }
  return out;
}

const FILLER_PARAS = [
  "The methodology section outlines an iterative experimental protocol with multiple ablation studies conducted across heterogeneous compute clusters. Reviewers noted that the reproducibility appendix was thorough.",
  "Background work surveys a decade of prior literature, situating the contribution among adjacent efforts. The related-work matrix cross-references forty-one publications spanning several subfields.",
  "Operational constraints required careful scheduling of the validation runs. The infrastructure team provisioned a dedicated queue and instrumented the pipeline with fine-grained telemetry for post-hoc analysis.",
  "Stakeholder interviews surfaced competing priorities between latency and throughput. A compromise configuration was adopted after a structured trade-off workshop with the steering committee.",
  "Risk assessment flagged three dependencies as potential bottlenecks. Mitigations included redundant data paths, a fallback evaluation harness, and an escalation runbook maintained by the on-call rotation.",
  "The discussion considers threats to validity, including distribution shift and annotation noise. Sensitivity analyses suggest the headline result is robust within the reported confidence interval.",
];

function renderDossier(d: Dossier, targetTokens: number): string {
  const header =
    `# Project ${d.codename} — Internal Research Dossier\n\n` +
    `Project codename: ${d.codename}\n` +
    `Lead researcher: ${d.lead}\n` +
    `Primary result — ${d.metricName}: ${d.metricValue}\n` +
    `Critical dependency: this project depends on project ${d.dependsOn}.\n\n` +
    `## Summary\n` +
    `Project ${d.codename}, led by ${d.lead}, reports a ${d.metricName} of ${d.metricValue}. ` +
    `Its critical path depends on project ${d.dependsOn}.\n\n`;
  // pad with deterministic filler to reach ~targetTokens (~3.3 chars/token).
  // The incident code is BURIED in a middle section (not the header/summary),
  // so an agent that only noted the headline facts must re-read the whole
  // (large) dossier to recover it — unless it preserved the full text.
  const targetChars = targetTokens * 3.3;
  const buryAt = 4; // section index where the incident code is planted
  let body = header;
  let i = 0;
  while (body.length < targetChars || i <= buryAt) {
    if (i === buryAt) {
      body += `## Section ${i + 1}: Incident Log\nDuring validation an anomaly was recorded under incident code ${d.incidentCode}. ${FILLER_PARAS[i % FILLER_PARAS.length]}\n\n`;
    } else {
      body += `## Section ${i + 1}\n${FILLER_PARAS[i % FILLER_PARAS.length]}\n\n`;
    }
    i++;
  }
  return body;
}

interface Question {
  prompt: string;
  answer: string; // exact-match target
  kind: "direct" | "cross" | "revisit" | "aggregate";
  targetSlot: number;
}

/**
 * Deterministic question schedule. Designed so the corpus CANNOT be shortcut by
 * grep: the agent is given only list_dir + read_file (no grep), and several
 * questions are AGGREGATIONS that require reading every dossier (e.g. "which
 * project has the highest accuracy?"). Direct/cross/revisit questions are
 * interleaved; revisits return to early projects after many intervening reads.
 */
function buildQuestions(dossiers: Dossier[], m: number): Question[] {
  const n = dossiers.length;
  const byCode = new Map(dossiers.map((d) => [d.codename, d]));
  const qs: Question[] = [];

  // Aggregation questions (must read ALL dossiers — no grep available).
  const sorted = [...dossiers].sort((a, b) => parseFloat(b.metricValue) - parseFloat(a.metricValue));
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  const aboveThreshold = dossiers.filter((d) => parseFloat(d.metricValue) >= 80).length;

  qs.push({
    prompt: `Across ALL the dossiers in the corpus, which project has the HIGHEST primary benchmark accuracy? Answer with the exact project codename.`,
    answer: highest.codename,
    kind: "aggregate",
    targetSlot: highest.slot,
  });
  qs.push({
    prompt: `Across ALL dossiers, how many projects have a primary benchmark accuracy of 80.0% or higher? Answer with the exact integer count.`,
    answer: String(aboveThreshold),
    kind: "aggregate",
    targetSlot: 0,
  });
  qs.push({
    prompt: `Across ALL dossiers, which project has the LOWEST primary benchmark accuracy? Answer with the exact project codename.`,
    answer: lowest.codename,
    kind: "aggregate",
    targetSlot: lowest.slot,
  });

  // Direct + cross questions spread across the corpus.
  const step = Math.max(1, Math.floor(n / Math.max(1, m - 5)));
  for (let i = 0; qs.length < m - 2 && i < n; i += step) {
    const d = dossiers[i];
    if (qs.length % 2 === 0) {
      qs.push({
        prompt: `What is the lead researcher of project ${d.codename}? Answer with the exact name as written in the dossier.`,
        answer: d.lead,
        kind: "direct",
        targetSlot: d.slot,
      });
    } else {
      const dep = byCode.get(d.dependsOn);
      qs.push(dep ? {
        prompt: `Project ${d.codename} depends on another project. What is that other project's primary benchmark accuracy? Answer with the exact percentage.`,
        answer: dep.metricValue,
        kind: "cross",
        targetSlot: dep.slot,
      } : {
        prompt: `What is the primary benchmark accuracy of project ${d.codename}? Answer with the exact percentage.`,
        answer: d.metricValue,
        kind: "direct",
        targetSlot: d.slot,
      });
    }
  }

  // REVISIT: return to early projects and ask for the BURIED incident code —
  // a fact NOT in the header, so an agent that only noted headline facts must
  // re-read the whole large dossier (expensive, may re-overflow) unless it
  // preserved the full text. This is where active preservation can beat
  // passive offload.
  const revisitA = dossiers[0];
  const revisitB = dossiers[Math.min(step, n - 1)];
  qs.push({
    prompt: `Earlier you examined project ${revisitA.codename}. Deep in its dossier, an incident code was recorded in its Incident Log section. What is that exact incident code (format INC-####X)?`,
    answer: revisitA.incidentCode,
    kind: "revisit",
    targetSlot: revisitA.slot,
  });
  qs.push({
    prompt: `Return to project ${revisitB.codename}. What is the exact incident code recorded in its Incident Log section (format INC-####X)?`,
    answer: revisitB.incidentCode,
    kind: "revisit",
    targetSlot: revisitB.slot,
  });
  return qs.slice(0, m);
}

function exactMatch(prediction: string, answer: string): number {
  const p = normalizeAnswer(prediction);
  const a = normalizeAnswer(answer);
  if (!a) return 0;
  // The model may wrap the answer in a sentence; count as correct if the
  // normalized gold answer appears as a token-substring of the prediction.
  return p.includes(a) ? 1 : 0;
}

function mainTask(q: Question, docCount: number): string {
  return (
    `You are a research analyst working through a large corpus of project dossiers over many questions.\n` +
    `Your workdir has a corpus/ folder with ${docCount} dossiers (doc_1.txt … doc_${docCount}.txt), ` +
    `each on a different project — together far larger than your context window. ` +
    `Each dossier states a project codename, a lead researcher, a primary benchmark accuracy, and a dependency.\n\n` +
    `You have only list_dir and read_file — there is NO search/grep tool, so to find facts you must ` +
    `actually read the dossiers. Some questions ask you to compare ALL projects (e.g. which has the ` +
    `highest accuracy), which requires reading every dossier. Later questions may RETURN to a project ` +
    `you examined much earlier.\n\n` +
    `First question: ${q.prompt}\n\n` +
    `Read the dossiers you need with read_file, then answer.`
  );
}

function followup(q: Question, idx: number): string {
  return `Question #${idx + 1}: ${q.prompt}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dossiers = buildDossiers(args.docs);
  const questions = buildQuestions(dossiers, args.questions);

  const env = loadDeepSeekEnv();
  const client = new DeepSeekClient(env);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const benchDir = join("runs", `deepresearch-${args.mode}-w${args.hardWindow}-${ts}`);
  const corpusDir = join(benchDir, "corpus");
  mkdirSync(corpusDir, { recursive: true });

  let corpusTokens = 0;
  for (const d of dossiers) {
    const text = renderDossier(d, args.docTokens);
    corpusTokens += Math.round(text.length / 3.3);
    writeFileSync(join(corpusDir, `doc_${d.slot}.txt`), text, "utf8");
  }
  // ground-truth key for audit
  writeFileSync(
    join(benchDir, "answer_key.json"),
    JSON.stringify({ dossiers, questions }, null, 2),
    "utf8",
  );

  if (args.dryRun) {
    console.log(`[dry-run] generated ${args.docs} dossiers ~${corpusTokens} tokens, ${questions.length} questions`);
    console.log(`[dry-run] window=${args.hardWindow} → corpus is ~${(corpusTokens / args.hardWindow).toFixed(1)}× window`);
    const kinds = questions.reduce((m, q) => ((m[q.kind] = (m[q.kind] ?? 0) + 1), m), {} as Record<string, number>);
    console.log(`[dry-run] question kinds: ${JSON.stringify(kinds)}`);
    console.log(`[dry-run] sample answers: ${questions.slice(0, 4).map((q) => `"${q.answer}"`).join(", ")}`);
    console.log(`[dry-run] corpus + answer_key written to ${benchDir}`);
    return;
  }

  // Tie CPAT's pressure ladder to the hard window so they coincide.
  const config: CpatConfig = {
    model: args.model,
    maxContextTokens: args.hardWindow,
    softLimitRatio: 0.7,
    mustActRatio: 0.8,
    criticalRatio: 0.95,
    generational: false,
    allowReplace: false,
    allowRedact: false,
    strictTools: true,
    maxTurns: args.turns,
    runDir: benchDir,
    verbose: false,
  };

  console.log(
    `Deep-research  mode=${args.mode}  hard-window=${args.hardWindow}  model=${args.model}`,
  );
  console.log(
    `corpus: ${args.docs} dossiers ~${corpusTokens} tokens (~${(corpusTokens / args.hardWindow).toFixed(1)}× window)  ` +
      `questions: ${questions.length}  turns<=${args.turns}`,
  );
  console.log(`run dir: ${benchDir}\n`);

  let apiError: string | undefined;
  let run: Awaited<ReturnType<typeof runAgent>> | undefined;
  try {
    run = await runAgent({
      task: mainTask(questions[0], args.docs),
      followups: questions.slice(1).map((q, i) => followup(q, i + 1)),
      config,
      client,
      workdir: resolve(benchDir),
      mode: args.mode,
      hardWindowTokens: args.hardWindow,
      // No grep: force whole-document reads so context actually accumulates.
      taskToolNames: ["list_dir", "read_file"],
      onTurn: (t) => {
        const flags = [
          t.pressure !== "ok" ? `⚠${t.pressure}` : "",
          t.fallbackOffloads > 0 ? `fb${t.fallbackOffloads}` : "",
          t.patchSummary ? `[${t.patchSummary}]` : "",
          t.nudged ? "nudge" : "",
        ].filter(Boolean).join(" ");
        console.log(`  turn ${String(t.turn).padStart(3)}: ${t.promptTokens} in / ${t.completionTokens} out  ${t.toolCalls.join(",") || "→answer"}  ${flags}`);
      },
    });
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err);
  }

  const perQ = questions.map((q, i) => {
    const ans = run?.answers[i] ?? "";
    return {
      index: i,
      kind: q.kind,
      target_slot: q.targetSlot,
      correct: exactMatch(ans, q.answer),
      question: q.prompt,
      gold: q.answer,
      prediction: ans,
    };
  });

  const answered = perQ.filter((r) => r.prediction.trim().length > 0).length;
  const correct = perQ.reduce((s, r) => s + r.correct, 0);
  const revisitCorrect = perQ.filter((r) => r.kind === "revisit").reduce((s, r) => s + r.correct, 0);
  const revisitTotal = perQ.filter((r) => r.kind === "revisit").length;
  const m = run?.metrics;
  const ops = m?.ops_by_type ?? {};

  const summary = {
    mode: args.mode,
    hard_window: args.hardWindow,
    corpus_docs: args.docs,
    corpus_tokens_est: corpusTokens,
    questions: questions.length,
    questions_answered: answered,
    accuracy: Number(((correct / questions.length) * 100).toFixed(1)),
    revisit_accuracy: revisitTotal ? Number(((revisitCorrect / revisitTotal) * 100).toFixed(1)) : null,
    terminated_early: m?.terminated_early ?? null,
    api_error: apiError ?? null,
    peak_view_tokens: m?.peak_view_tokens ?? 0,
    total_prompt_tokens: m?.prompt_tokens ?? 0,
    turns: run?.turns ?? 0,
    offloads: (ops.payload_offload ?? 0) as number,
    restores: (ops.restore ?? 0) as number,
    compacts: ((ops.compact ?? 0) + (ops.fold ?? 0) + (ops.merge ?? 0)) as number,
    agent_patches_applied: m?.agent_patches_applied ?? 0,
    runtime_fallback_offloads: m?.runtime_fallback_offloads ?? 0,
  };

  console.log(`\n=== per-question (mode=${args.mode}, window=${args.hardWindow}) ===`);
  for (const r of perQ) {
    const pred = r.prediction.replace(/\s+/g, " ").trim().slice(0, 50);
    console.log(`  Q${String(r.index).padStart(2)} ${r.kind.padEnd(7)} ${r.correct ? "✓" : "✗"} gold="${r.gold}"  pred: ${pred}`);
  }
  console.log(`\n=== summary (mode=${args.mode}, window=${args.hardWindow}) ===`);
  if (apiError) console.log(`API ERROR: ${apiError.slice(0, 160)}`);
  console.log(`terminated_early   : ${summary.terminated_early}`);
  console.log(`questions answered : ${answered}/${questions.length}`);
  console.log(`accuracy           : ${summary.accuracy}%   (revisit: ${summary.revisit_accuracy}%)`);
  console.log(`peak view tokens   : ${summary.peak_view_tokens}  (window ${args.hardWindow})`);
  console.log(`total prompt tokens: ${summary.total_prompt_tokens}  turns: ${summary.turns}`);
  console.log(`offload/restore/compact: ${summary.offloads}/${summary.restores}/${summary.compacts}  fallbacks: ${summary.runtime_fallback_offloads}`);

  writeFileSync(join(benchDir, "results.json"), JSON.stringify({ summary, perQ }, null, 2), "utf8");
  console.log(`\nresults: ${join(benchDir, "results.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
