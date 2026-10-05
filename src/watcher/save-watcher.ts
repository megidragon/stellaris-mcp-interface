import { watch } from "chokidar";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FSWatcher } from "chokidar";

export type SaveCallback = (savePath: string) => void;

export class SaveWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: SaveCallback[] = [];
  private lastSavePath: string | null = null;
  private candidates = new Map<string, number>();
  private updates = new Set<Promise<void>>();
  private ready: Promise<void> | null = null;

  constructor(
    private saveDir: string,
    private profile?: string
  ) {}

  get latestSave(): string | null {
    return this.lastSavePath;
  }

  onNewSave(callback: SaveCallback): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    const watchDir = this.profile
      ? join(this.saveDir, this.profile)
      : this.saveDir;

    // Chokidar 4+ does not expand globs. Watch the directory and filter files.
    this.candidates.clear();
    this.lastSavePath = null;
    const watcher = watch(watchDir, {
      ignoreInitial: false,
      depth: this.profile ? 0 : 1,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
    });
    this.watcher = watcher;
    watcher.on("add", (path) => this.enqueueUpdate(path));
    watcher.on("change", (path) => this.enqueueUpdate(path));
    watcher.on("unlink", (path) => {
      this.candidates.delete(path);
      this.selectLatest();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      watcher.once("ready", () => {
        void Promise.all([...this.updates]).then(() => resolve(), reject);
      });
      watcher.on("error", (error: unknown) => {
        console.error("Unable to watch Stellaris saves:", error);
        reject(error);
      });
    });
    return this.ready;
  }

  private enqueueUpdate(path: string): void {
    if (extname(path).toLowerCase() !== ".sav") return;
    const update = this.handleNewSave(path).catch((error: unknown) => {
      console.error(`Unable to inspect Stellaris save ${path}:`, error);
    });
    this.updates.add(update);
    void update.finally(() => this.updates.delete(update));
  }

  private async handleNewSave(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (!info.isFile()) return;
      this.candidates.set(path, info.mtimeMs);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    this.selectLatest();
    for (const cb of this.callbacks) {
      cb(path);
    }
  }

  private selectLatest(): void {
    let latest: string | null = null;
    let latestTime = -Infinity;
    for (const [path, modifiedAt] of this.candidates) {
      if (modifiedAt > latestTime || (modifiedAt === latestTime && (latest === null || path > latest))) {
        latest = path;
        latestTime = modifiedAt;
      }
    }
    this.lastSavePath = latest;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await Promise.all([...this.updates]);
    this.ready = null;
    this.candidates.clear();
    this.lastSavePath = null;
  }
}
