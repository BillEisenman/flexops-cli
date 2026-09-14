import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";

// Immutable records are flushed before dispatch. The server owns concurrency and replay;
// local decision/result markers never authorize a different request or a fresh key.
export function record(path: string, value: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}

export function directory(id: string, store: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid operation ID.");
  return join(store, id);
}

