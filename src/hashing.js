// 规范化哈希：签署与内容校验都基于“排序键 + 紧凑 JSON”，
// 保证同一语义内容在任何进程里得到同一哈希。

import { createHash } from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
