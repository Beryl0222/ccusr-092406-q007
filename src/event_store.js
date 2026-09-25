// 事件存储：事件以 JSONL 追加落盘，单次 write + fsync 保证同批事件原子提交。
// 重启后重新读取并交给 projection 重放，待裁定议题与暂停通知等状态全部来自事件。

import { appendFileSync, existsSync, readFileSync, closeSync, openSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateEvent } from "./art_motif_review.js";
import { createInitialState, applyEvent } from "./projection.js";

export class StoreError extends Error {}

export class EventStore {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
    this.state = createInitialState();
  }

  // 读取已有事件并重放。文件不存在时视为全新存储。
  load() {
    this.state = createInitialState();
    if (!existsSync(this.path)) return this.state;
    const lines = readFileSync(this.path, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const problems = validateEvent(event);
      if (problems.length) throw new StoreError(`损坏的事件记录：${event.event_id ?? "?"} 缺少 ${problems.join(",")}`);
      this.state = applyEvent(this.state, event);
    }
    return this.state;
  }

  // 追加一个事件；event_id/occurred_at 可显式给出（便于确定性测试与外部去重）。
  append(kind, subjectId, payload, { eventId, occurredAt } = {}) {
    return this.appendMany([{ kind, subjectId, payload, eventId, occurredAt }])[0];
  }

  // 同批事件在同一次写入里落盘，避免“意见已写、裁定未写”的中间态。
  appendMany(records) {
    if (records.length === 0) return [];
    const events = records.map((record) => {
      const event = {
        event_id: record.eventId ?? randomUUID(),
        kind: record.kind,
        occurred_at: record.occurredAt ?? this.now(),
        subject_id: record.subjectId,
        payload: record.payload,
      };
      const problems = validateEvent(event);
      if (problems.length) throw new StoreError(`事件 ${event.event_id} 字段不合法：${problems.join(",")}`);
      if (this.state.events.has(event.event_id)) throw new StoreError(`事件编号重复：${event.event_id}`);
      return event;
    });

    const chunk = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, chunk);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    for (const event of events) this.state = applyEvent(this.state, event);
    return events;
  }
}

export function openStore(path, options = {}) {
  const store = new EventStore(path, options);
  store.load();
  return store;
}
