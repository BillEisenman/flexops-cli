import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
let server: Server, store: string, url: string;
let writes: number, stock: number, loseResponse: boolean, unknown: boolean, stale: boolean;
let calls: { key: string; body: string }[];
let completed: Map<string, unknown>;

beforeEach(async () => {
  store = mkdtempSync(join(tmpdir(), "flexops-operation-test-"));
  writes = 0; stock = 10; loseResponse = false; unknown = false; stale = false;
  calls = []; completed = new Map();
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const key = String(request.headers["idempotency-key"]);
    const body = JSON.parse(raw);
    const args = body.params.arguments;
    calls.push({ key, body: raw });
    expect(request.url).toBe("/api/mcp");
    expect(request.headers["x-api-key"]).toBe("live_synthetic_local_only");
    let result: any;
    if (!args.confirmation_token) {
      result = { status: "Preview", data: { confirmationToken: "synthetic-signed-token", currentStock: stock,
        availableStock: stock - 2, resultingStock: stock + args.quantity_change,
        resultingAvailableStock: stock - 2 + args.quantity_change, maxAdjustment: 25,
        allowNegativeInventory: false, expiresAt: new Date(Date.now() + 300000).toISOString() } };
    } else if (stale) {
      result = { status: "StaleConfirmation", error: { code: "StaleConfirmation", httpStatus: 412 } };
    } else if (unknown) {
      result = { status: "OutcomeUnknown", error: { code: "OutcomeUnknown", httpStatus: 409 } };
    } else if (completed.has(key)) {
      result = { ...(completed.get(key) as object), replayed: true };
    } else {
      writes++; stock += args.quantity_change;
      result = { status: "Succeeded", actionId: "synthetic-action", replayed: false, data: { currentStock: stock } };
      completed.set(key, result);
      if (loseResponse) { loseResponse = false; response.destroy(); return; }
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: Boolean(result.error), structuredContent: result } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(store, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const result = await exec(process.execPath, [resolve("dist/index.js"), "--gateway-url", url, "inventory", ...args], {
    env: { ...process.env, FLEXOPS_API_KEY: "live_synthetic_local_only", FLEXOPS_OPERATION_DIR: store },
  });
  return JSON.parse(result.stdout);
}
const preview = () => cli("preview", "--sku", "CERT-SKU", "--warehouse", "7", "--quantity", "2", "--reason", "Synthetic certification");

it("exposes approval-gated MCP tools and preserves retry state across connector restarts", async () => {
  function connect() {
    const child = spawn(process.execPath, [resolve("dist/index.js"), "--gateway-url", url, "inventory-mcp"], {
      env: { ...process.env, FLEXOPS_API_KEY: "live_synthetic_local_only", FLEXOPS_OPERATION_DIR: store }, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    return {
      async request(method: string, params: unknown = {}) {
        const next = once(lines, "line");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
        return JSON.parse((await next)[0]);
      },
      async close() { const closed = once(child, "close"); child.stdin.end(); await closed; lines.close(); },
    };
  }
  let client = connect();
  const invoke = (name: string, args: unknown) => client.request("tools/call", { name, arguments: args });
  try {
    expect((await client.request("tools/list")).error.message).toBe("Initialize first.");
    const init = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-cert", version: "1" } });
    expect(init.result.protocolVersion).toBe("2025-11-25");
    const discovered = (await client.request("tools/list")).result.tools;
    expect(discovered).toHaveLength(4);
    expect(discovered.find((t: any) => t.name === "commit_inventory_adjustment").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const prepared = await invoke("preview_inventory_adjustment", { sku: "CERT-SKU", warehouse_id: 7, quantity_change: 2, reason: "MCP certification" });
    const operation = prepared.result.structuredContent.operation;
    expect(JSON.stringify(prepared)).not.toContain("synthetic-signed-token");
    expect((await invoke("commit_inventory_adjustment", { operation })).result.isError).toBe(true);
    expect((await invoke("commit_inventory_adjustment", { operation, approved: false })).result.isError).toBe(true);
    expect(writes).toBe(0);
    loseResponse = true;
    expect((await invoke("commit_inventory_adjustment", { operation, approved: true })).result.isError).toBe(true);
    expect(writes).toBe(1);
    const count = calls.length;
    expect((await invoke("inspect_inventory_adjustment", { operation })).result.structuredContent.status).toBe("ApprovedUnresolved");
    expect(calls).toHaveLength(count);
    await client.close(); client = connect();
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-cert", version: "1" } });
    const retry = await invoke("commit_inventory_adjustment", { operation, approved: true });
    expect(retry.result.structuredContent.replayed).toBe(true);
    expect(calls[1]).toEqual(calls[2]);
    expect(writes).toBe(1);
    const beforeCached = calls.length;
    const cached = await invoke("commit_inventory_adjustment", { operation, approved: true });
    expect(cached.result.structuredContent).toMatchObject({ replayed: true, cached: true, actionId: retry.result.structuredContent.actionId });
    expect(calls).toHaveLength(beforeCached);
    expect((await invoke("commit_inventory_adjustment", { operation, approved: true, reconcile: true })).result.isError).toBe(true);
    expect((await invoke("reconcile_inventory_adjustment", { operation })).result.isError).toBe(true);
    const next = (await invoke("preview_inventory_adjustment", { sku: "CERT-SKU", warehouse_id: 7, quantity_change: 2, reason: "Cancel me" })).result.structuredContent;
    await invoke("cancel_inventory_adjustment", { operation: next.operation });
    expect((await invoke("commit_inventory_adjustment", { operation: next.operation, approved: true })).result.isError).toBe(true);
    expect(writes).toBe(1);
  } finally { await client.close(); }
});

it("rejects a changed identity or saved approved request without dispatch", async () => {
  const operation = await preview();
  const path = join(store, operation.operation, "operation.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...saved, keyHash: "different-key" }));
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow(/original Gateway and API key/);
  writeFileSync(path, JSON.stringify(saved));
  loseResponse = true;
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow();
  const count = calls.length;
  const request = JSON.parse(saved.body);
  request.params.arguments.quantity_change = 3;
  saved.body = JSON.stringify(request);
  writeFileSync(path, JSON.stringify(saved));
  await expect(cli("commit", operation.operation)).rejects.toThrow(/differs from its preview/);
  saved.preview.quantity_change = 3;
  writeFileSync(path, JSON.stringify(saved));
  await expect(cli("commit", operation.operation)).rejects.toThrow(/approved inputs changed/);
  expect(calls).toHaveLength(count);
  expect(writes).toBe(1);
});

it("persists approval and the exact request through a lost response and process restart", async () => {
  const operation = await preview();
  expect(JSON.stringify(operation)).not.toContain("synthetic-signed-token");
  expect(operation.preview.resultingStock).toBe(12);
  expect((await cli("commit", operation.operation)).status).toBe("AwaitingApproval");
  expect(writes).toBe(0);
  loseResponse = true;
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow();
  expect(writes).toBe(1);
  await expect(preview()).rejects.toThrow(/Resolve operation/);
  const retry = await cli("commit", operation.operation);
  expect(retry.status).toBe("Succeeded");
  expect(retry.replayed).toBe(true);
  expect(calls[1]).toEqual(calls[2]);
  expect(stock).toBe(12);
  const count = calls.length;
  expect(await cli("commit", operation.operation)).toMatchObject({ replayed: true, cached: true, actionId: retry.actionId });
  expect(calls).toHaveLength(count);
  const next = await preview();
  expect(next.operation).not.toBe(operation.operation);
  expect(calls.at(-1)!.key).not.toBe(calls[1]!.key);
});

it("cancellation prevents dispatch even if a later caller supplies approve", async () => {
  const operation = await preview();
  await cli("cancel", operation.operation);
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow(/cancelled/);
  expect(writes).toBe(0);
});

it("stops on unknown outcome and uses the original key only after operator reconciliation", async () => {
  const operation = await preview();
  unknown = true;
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow(/Operation stopped/);
  const count = calls.length;
  await expect(cli("commit", operation.operation)).rejects.toThrow(/reconciliation/);
  await expect(preview()).rejects.toThrow(/Resolve operation/);
  expect(calls).toHaveLength(count);
  // Operator has matched the authoritative record and repaired the server ledger.
  completed.set(operation.operation, { status: "Succeeded", actionId: "reconciled-action" });
  unknown = false;
  const result = await cli("commit", operation.operation, "--reconcile");
  expect(result.actionId).toBe("reconciled-action");
  expect(calls[1]).toEqual(calls[2]);
  expect(writes).toBe(0);
});

it("requires a new preview and approval following a definitive precondition rejection", async () => {
  const operation = await preview();
  stale = true;
  await expect(cli("commit", operation.operation, "--approve")).rejects.toThrow(/new preview/);
  await expect(cli("commit", operation.operation)).rejects.toThrow(/new preview/);
  stale = false;
  const next = await preview();
  expect(next.operation).not.toBe(operation.operation);
  expect((await cli("commit", next.operation)).status).toBe("AwaitingApproval");
  expect(writes).toBe(0);
});
