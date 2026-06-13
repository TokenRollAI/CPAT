import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DeepSeekEnv {
  baseUrl: string;
  apiKey: string;
}

/** Minimal .env parser — no dependency needed. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads DeepSeek credentials. The project .env provides:
 *   OPENAI_BASE_URL  — OpenAI-compatible endpoint (what CPAT uses)
 *   API_KEY          — the DeepSeek API key
 * Falls back to common alternative names and process.env.
 */
export function loadDeepSeekEnv(cwd: string = process.cwd()): DeepSeekEnv {
  const envPath = resolve(cwd, ".env");
  const fileVars = existsSync(envPath)
    ? parseDotEnv(readFileSync(envPath, "utf8"))
    : {};
  const vars: Record<string, string | undefined> = {
    ...fileVars,
    ...process.env,
  };

  const baseUrl =
    vars.OPENAI_BASE_URL ??
    vars.DEEPSEEK_BASE_URL ??
    vars.BASE_URL ??
    vars.BaseURL ??
    "https://api.deepseek.com";
  const apiKey =
    vars.API_KEY ?? vars.DEEPSEEK_API_KEY ?? vars.APIKey ?? vars.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      `Missing API key. Expected API_KEY (or DEEPSEEK_API_KEY) in ${envPath} or environment.`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
