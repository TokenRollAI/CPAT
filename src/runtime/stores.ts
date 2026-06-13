import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, JournalEvent } from "../types.ts";
import { nowIso } from "../util/misc.ts";

/**
 * Single-copy content store. Every payload entering the system is written
 * here exactly once, keyed by "<blockId>@v<version>". Blocks and journal
 * events carry keys, never duplicate payloads. payload_offload is a pure
 * view-level flip (inline → ArtifactRef) — zero copy. artifact://<key> is the
 * one and only recovery channel.
 */
export class ContentStore {
  private readonly dir: string;
  private readonly cache = new Map<string, string>();

  constructor(runDir: string) {
    this.dir = join(runDir, "content");
    mkdirSync(this.dir, { recursive: true });
  }

  put(key: string, payload: string): string {
    if (!this.cache.has(key)) {
      this.cache.set(key, payload);
      writeFileSync(join(this.dir, encodeKey(key)), payload);
    }
    return key;
  }

  get(uriOrKey: string): string | undefined {
    const key = uriOrKey.replace(/^artifact:\/\//, "");
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const file = join(this.dir, encodeKey(key));
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, "utf8");
    this.cache.set(key, text);
    return text;
  }

  static uri(key: string): string {
    return `artifact://${key}`;
  }

  static isRef(content: string | ArtifactRef): content is ArtifactRef {
    return typeof content !== "string";
  }
}

function encodeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_@.-]/g, "_") + ".txt";
}

/**
 * Append-only event journal: ingest / patch / llm_call. This is the
 * provenance and audit trail — the agent has no operation that can touch it.
 */
export class Journal {
  private readonly path: string;
  readonly events: JournalEvent[] = [];
  private seq = 0;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.path = join(runDir, "journal.jsonl");
  }

  append<T extends JournalEvent["type"]>(
    type: T,
    fields: Omit<Extract<JournalEvent, { type: T }>, "type" | "seq" | "ts">,
  ): JournalEvent {
    this.seq += 1;
    const event = {
      type,
      seq: this.seq,
      ts: nowIso(),
      ...fields,
    } as unknown as JournalEvent;
    this.events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + "\n");
    return event;
  }
}
