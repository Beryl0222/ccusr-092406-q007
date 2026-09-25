// 状态快照持久化：单文件 JSON，临时文件 + rename 原子替换，保证重启后状态一致。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function emptyState() {
  return {
    schema: 1,
    counters: {},
    motifs: {},
    drafts: {},
    opinions: {},
    adjudications: {},
    packages: {},
    idempotency: {},
    events: [],
  };
}

export class StateStore {
  #path;

  constructor(path) {
    this.#path = path;
  }

  async load() {
    if (!this.#path) return emptyState();
    try {
      const raw = await readFile(this.#path, "utf8");
      return { ...emptyState(), ...JSON.parse(raw) };
    } catch (error) {
      if (error && error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state) {
    if (!this.#path) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = join(dirname(this.#path), `.state-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.#path);
  }
}
