import type {
  ChatMessage,
  ChatResponse,
  ChatUsage,
  ToolDefinition,
} from "../types.ts";
import type { DeepSeekEnv } from "../util/env.ts";

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number;
  maxTokens?: number;
}

/**
 * Minimal OpenAI-compatible client for DeepSeek chat completions.
 * Zero dependencies — uses global fetch.
 */
export class DeepSeekClient {
  private readonly url: string;
  private readonly apiKey: string;
  private strictRejected = false;

  constructor(env: DeepSeekEnv) {
    this.url = `${env.baseUrl}/chat/completions`;
    this.apiKey = env.apiKey;
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    let tools = opts.tools;
    let attempt = 0;
    // One retry path: if the endpoint rejects strict tool schemas, strip
    // `strict` and retry (we validate patches ourselves anyway).
    for (;;) {
      attempt += 1;
      if (this.strictRejected && tools) tools = stripStrict(tools);
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        const strictIssue =
          res.status === 400 && /strict/i.test(body) && !this.strictRejected;
        if (strictIssue && tools) {
          this.strictRejected = true;
          continue;
        }
        if (res.status >= 500 && attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 2000)}`);
      }

      const data = (await res.json()) as {
        choices: Array<{
          message: ChatMessage;
          finish_reason: string;
        }>;
        usage: ChatUsage;
      };
      const choice = data.choices?.[0];
      if (!choice) throw new Error("DeepSeek API returned no choices");
      return {
        message: choice.message,
        finish_reason: choice.finish_reason,
        usage: data.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
    }
  }
}

function stripStrict(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((t) => ({
    ...t,
    function: { ...t.function, strict: undefined },
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
