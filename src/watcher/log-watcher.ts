import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseLogContent } from "../parser/log-parser.js";
import type { LogGameState } from "../parser/types.js";

/** Poll the log without keeping a snapshot from a truncated or replaced file. */
export class LogWatcher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private currentState: LogGameState | null = null;
  private snapshotAt: number | null = null;
  private stateFingerprint = "";
  private lastSize = 0;
  private lastMtime = 0;
  private fileIdentity: string | null = null;
  private prefix = Buffer.alloc(0);
  private frame = "";
  private partialLine = "";
  private decoder = new StringDecoder("utf8");

  constructor(private logPath: string, private pollInterval = 2000) {}

  get latestState(): LogGameState | null {
    return this.currentState;
  }

  /** File modification time when the latest complete snapshot changed. */
  get lastSnapshotAt(): number | null {
    return this.snapshotAt;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.refresh();
      this.scheduleNextCheck();
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Refresh immediately; concurrent requests share the same read. */
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.checkForUpdates();
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      this.refreshPromise = null;
    }
  }

  private scheduleNextCheck(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh()
        .catch((error: unknown) => console.error("Unable to refresh Stellaris game log:", error))
        .finally(() => this.scheduleNextCheck());
    }, this.pollInterval);
    this.timer.unref();
  }

  private reset(): void {
    this.currentState = null;
    this.snapshotAt = null;
    this.stateFingerprint = "";
    this.lastSize = 0;
    this.lastMtime = 0;
    this.fileIdentity = null;
    this.prefix = Buffer.alloc(0);
    this.frame = "";
    this.partialLine = "";
    this.decoder = new StringDecoder("utf8");
  }

  private async checkForUpdates(): Promise<void> {
    let file;
    try {
      file = await open(this.logPath, "r");
    } catch (error) {
      this.reset();
      if (isMissingFile(error)) return;
      throw new Error(`Cannot read game log ${this.logPath}`, { cause: error });
    }

    try {
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (identity === this.fileIdentity && info.size === this.lastSize && info.mtimeMs === this.lastMtime) return;

      // A restart can rewrite and grow the same file between polls.
      const prefix = Buffer.alloc(Math.min(256, info.size));
      const prefixRead = await file.read(prefix, 0, prefix.length, 0);
      const actualPrefix = prefix.subarray(0, prefixRead.bytesRead);
      const commonLength = Math.min(this.prefix.length, actualPrefix.length);
      const rewritten = identity !== this.fileIdentity || info.size < this.lastSize ||
        (info.size === this.lastSize && info.mtimeMs !== this.lastMtime) ||
        !this.prefix.subarray(0, commonLength).equals(actualPrefix.subarray(0, commonLength));
      if (rewritten) this.reset();

      while (this.lastSize < info.size) {
        const bytes = Buffer.alloc(Math.min(64 * 1024, info.size - this.lastSize));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, this.lastSize);
        if (bytesRead === 0) break;
        this.lastSize += bytesRead;
        this.ingest(this.decoder.write(bytes.subarray(0, bytesRead)), info.mtimeMs);
      }
      this.lastMtime = info.mtimeMs;
      this.fileIdentity = identity;
      this.prefix = actualPrefix;

    } finally {
      await file.close();
    }
  }

  private ingest(content: string, modifiedAt: number): void {
    this.partialLine += content;
    const lastNewline = this.partialLine.lastIndexOf("\n");
    if (lastNewline === -1) return;
    const complete = this.partialLine.slice(0, lastNewline + 1);
    this.partialLine = this.partialLine.slice(lastNewline + 1);

    // Keep only the active telemetry frame, rather than the entire game.log.
    // Completed state remains available while the next frame is being written.
    for (const line of complete.split("\n")) {
      if (line.includes("AI_INIT|")) {
        this.currentState = null;
        this.snapshotAt = null;
        this.stateFingerprint = "";
        this.frame = "";
      } else if (line.includes("AI_SUMMARY|")) {
        this.frame = `${line}\n`;
      } else if (this.frame && line.includes("AI_")) {
        this.frame += `${line}\n`;
        if (line.includes("AI_STATE_END|")) {
          const state = parseLogContent(this.frame);
          this.frame = "";
          if (!state) continue;
          const fingerprint = JSON.stringify(state);
          if (fingerprint !== this.stateFingerprint) {
            this.currentState = state;
            this.snapshotAt = modifiedAt;
            this.stateFingerprint = fingerprint;
          }
        }
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
