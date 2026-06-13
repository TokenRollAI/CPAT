import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "../types.ts";

/**
 * Simple task tools for the experiment. grep_search and read_file can produce
 * large raw payloads — exactly the blocks the agent should learn to
 * payload_offload under budget pressure. write_file and bash add mutation:
 * both are confined to the workdir sandbox (paths resolved under root, bash
 * cwd pinned to root).
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "runs", ".llmdoc-tmp", "dist", "build"]);
const MAX_OUTPUT_CHARS = 120_000;

export const taskToolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files under a directory (recursive, depth-limited). Paths are relative to the workdir root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, '.' for the root." },
          depth: { type: "number", description: "Max depth (default 3)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Optionally a line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Regex search across all text files under a directory. Returns file:line: matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex (no flags; case-insensitive)." },
          path: { type: "string", description: "Directory to search, default '.'." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file (overwrites if it exists, creates parent dirs). Path is relative to the workdir root and cannot escape it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workdir root." },
          content: { type: "string", description: "Full file contents to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command. The working directory is pinned to the workdir root; the command itself is unrestricted, so prefer scoped, non-destructive commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          timeout_ms: { type: "number", description: "Max run time in ms (default 30000)." },
        },
        required: ["command"],
      },
    },
  },
];

export class TaskTools {
  private readonly root: string;

  constructor(workdir: string) {
    this.root = resolve(workdir);
  }

  private safePath(p: string): string {
    const abs = resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`path escapes the workdir: ${p}`);
    }
    return abs;
  }

  dispatch(name: string, argsJson: string): string {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    try {
      switch (name) {
        case "list_dir":
          return this.listDir(String(args.path ?? "."), Number(args.depth ?? 3));
        case "read_file":
          return this.readFile(
            String(args.path),
            args.start_line === undefined ? undefined : Number(args.start_line),
            args.end_line === undefined ? undefined : Number(args.end_line),
          );
        case "grep_search":
          return this.grep(String(args.pattern), String(args.path ?? "."));
        case "write_file":
          return this.writeFile(String(args.path), String(args.content ?? ""));
        case "bash":
          return this.bash(String(args.command), args.timeout_ms === undefined ? 30_000 : Number(args.timeout_ms));
        default:
          return `error: unknown tool "${name}"`;
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private listDir(path: string, depth: number): string {
    const lines: string[] = [];
    const walk = (dir: string, level: number): void => {
      if (level > depth) return;
      for (const name of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        const full = join(dir, name);
        const st = statSync(full);
        const rel = relative(this.root, full);
        if (st.isDirectory()) {
          lines.push(`${rel}/`);
          walk(full, level + 1);
        } else {
          lines.push(`${rel} (${st.size} bytes)`);
        }
      }
    };
    walk(this.safePath(path), 1);
    return truncate(lines.join("\n") || "(empty)");
  }

  private readFile(path: string, start?: number, end?: number): string {
    const text = readFileSync(this.safePath(path), "utf8");
    if (start === undefined && end === undefined) return truncate(text);
    const lines = text.split("\n");
    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? lines.length);
    return truncate(
      lines
        .slice(s - 1, e)
        .map((l, i) => `${s + i}\t${l}`)
        .join("\n"),
    );
  }

  private grep(pattern: string, path: string): string {
    const re = new RegExp(pattern, "i");
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.size < 2_000_000) {
          let text: string;
          try {
            text = readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (text.includes("\u0000")) continue;
          const rel = relative(this.root, full);
          text.split("\n").forEach((line, idx) => {
            if (re.test(line)) out.push(`${rel}:${idx + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(this.safePath(path));
    return truncate(out.join("\n") || "(no matches)");
  }

  private writeFile(path: string, content: string): string {
    const abs = this.safePath(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `wrote ${relative(this.root, abs)} (${Buffer.byteLength(content, "utf8")} bytes)`;
  }

  private bash(command: string, timeoutMs: number): string {
    try {
      const out = execSync(command, {
        cwd: this.root,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 10_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return truncate(out.trim() || "(no output)");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      const parts = [
        e.stdout?.trim() ? `stdout:\n${e.stdout.trim()}` : "",
        e.stderr?.trim() ? `stderr:\n${e.stderr.trim()}` : "",
        `exit: ${e.status ?? "n/a"}${e.message ? ` (${e.message})` : ""}`,
      ].filter(Boolean);
      return truncate(parts.join("\n"));
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}
