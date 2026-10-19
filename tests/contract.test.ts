// Contract test: every CLI command's Gateway calls must be documented public operations.
// Fixture tests/fixtures/gateway-operations.json is the "METHOD /path" list from the Developer Docs
// OpenAPI snapshot (Docs/FlexOpsDeveloperDocs/static/openapi/gateway.json); refresh it from that
// file when the Gateway's documented surface changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { execFile, spawn } from "node:child_process";
import type { Command } from "commander";
import { buildProgram } from "../src/program.js";

const operations: string[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gateway-operations.json"), "utf8")
).operations;

/** Strips the query, maps a leading /api/v1 to /api and lower-cases, as ASP.NET routing does. */
function normalize(path: string): string {
  return path.split("?")[0]!.replace(/^\/api\/v1(?=\/|$)/i, "/api").replace(/\/+$/, "").toLowerCase();
}

const documented = operations.map(op => {
  const [method, path] = op.split(" ") as [string, string];
  return { method: method.toUpperCase(), segments: normalize(path).split("/") };
});

function isDocumented(method: string, path: string): boolean {
  const segments = normalize(path).split("/");
  return documented.some(op => op.method === method && op.segments.length === segments.length &&
    op.segments.every((s, i) => (s.startsWith("{") && s.endsWith("}") && segments[i]!.length > 0) || s === segments[i]));
}

/** Leaf commands of the real command tree, e.g. "labels create". */
function leafCommands(command: Command, prefix = ""): string[] {
  return command.commands.flatMap(child => {
    const name = `${prefix}${child.name()}`;
    return child.commands.length > 0 ? leafCommands(child, `${name} `) : [name];
  });
}

describe("Gateway contract", () => {
  const calls: { command: string; method: string; path: string }[] = [];
  let current = "";
  let server: Server;
  let gatewayUrl = "";
  let store: string;

  beforeAll(async () => {
    store = mkdtempSync(join(tmpdir(), "cli-contract-"));
    server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const path = req.url ?? "";
      calls.push({ command: current, method: req.method ?? "", path });
      const body = raw ? JSON.parse(raw) : {};
      const live = String(req.headers["x-api-key"] ?? "").startsWith("live_");
      let reply: unknown = {};
      if (/\/sandbox\/demo-keys$/i.test(path)) reply = { secretKey: "test_contract" };
      else if (/\/shipping\/track\//i.test(path)) reply = { status: "Delivered" };
      else if (/\/shipping\/labels$/i.test(path)) {
        reply = body.confirmationToken ? { trackingNumber: "CONTRACT-LIVE" }
          : !live ? { isSandbox: true, trackingNumber: "CONTRACT-SANDBOX" }
          : { status: "Preview", quotedPostageAmount: 8.5, maximumPostageAmount: body.maximumPostageAmount, currency: "USD",
            expiresAt: new Date(Date.now() + 300000).toISOString(), confirmationToken: "signed-preview" };
      } else if (/\/mcp$/i.test(path)) {
        const committing = typeof body.params?.arguments?.confirmation_token === "string";
        reply = { jsonrpc: "2.0", id: body.id, result: { isError: false, structuredContent: committing
          ? { status: "Succeeded", actionId: "contract-action", replayed: false }
          : { status: "Preview", data: { confirmationToken: "signed-preview", currentStock: 5, availableStock: 5,
            resultingStock: 7, resultingAvailableStock: 7 } } } };
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No local server");
    gatewayUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(store, { recursive: true, force: true });
  });

  const env = (key: string) => ({ ...process.env, FLEXOPS_API_KEY: key, FLEXOPS_GATEWAY_URL: gatewayUrl,
    FLEXOPS_LABEL_OPERATION_DIR: join(store, "labels"), FLEXOPS_OPERATION_DIR: join(store, "inventory") });
  const run = (args: string[], key = "live_contract") => new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["dist/index.js", "--json", ...args], { env: env(key) },
      (error, stdout, stderr) => error ? reject(new Error(`${args.join(" ")}: ${stderr || error.message}`)) : resolve(stdout));
  });
  const operationOf = (stdout: string) => JSON.parse(stdout).operation as string;
  const livePreview = () => run(["labels", "create", "--maximum-postage", "10.00", "--hazmat", "none"]);
  const inventoryPreview = () => run(["inventory", "preview", "--sku", "CONTRACT-SKU", "--warehouse", "7", "--quantity", "2", "--reason", "Contract"]);

  /** One run per leaf command, against the recording Gateway above. */
  const scenarios: Record<string, () => Promise<unknown>> = {
    "sandbox": () => run(["sandbox"], ""),
    "track": () => run(["track", "9400100000000000000000"], "test_contract"),
    "labels create": () => run(["labels", "create", "--hazmat", "none"], "test_contract"),
    "labels approve": async () => run(["labels", "approve", operationOf(await livePreview()), "--approve"]),
    "labels cancel-preview": async () => run(["labels", "cancel-preview", operationOf(await run(["labels", "create",
      "--maximum-postage", "10.00", "--hazmat", "none", "--to", "10001"]))]),
    "inventory preview": () => inventoryPreview(),
    "inventory commit": async () => run(["inventory", "commit", operationOf(await inventoryPreview()), "--approve"]),
    "inventory cancel": async () => run(["inventory", "cancel", operationOf(await run(["inventory", "preview",
      "--sku", "CONTRACT-SKU-2", "--warehouse", "7", "--quantity", "1", "--reason", "Contract"]))]),
    "inventory-mcp": () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/index.js", "inventory-mcp"], { env: env("live_contract") });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`inventory-mcp exited ${code}`)));
      child.stdin.end([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "preview_inventory_adjustment",
          arguments: { sku: "CONTRACT-MCP", warehouse_id: 7, quantity_change: 3, reason: "Contract" } } },
      ].map(message => JSON.stringify(message)).join("\n") + "\n");
    }),
  };

  it("exercises every command", () => {
    expect(Object.keys(scenarios).sort()).toEqual(leafCommands(buildProgram()).sort());
  });

  it("sends every Gateway call to a documented operation, and no write through ApiProxy", async () => {
    for (const [command, scenario] of Object.entries(scenarios)) { current = command; await scenario(); }
    expect(calls.length).toBeGreaterThan(0);
    const proxyWrites = calls.filter(c => c.method !== "GET" && /^\/api\/apiproxy(\/|$)/.test(normalize(c.path)));
    expect(proxyWrites).toEqual([]);
    expect(calls.filter(c => !isDocumented(c.method, c.path))).toEqual([]);
    const silent = ["labels cancel-preview", "inventory cancel"];
    for (const command of Object.keys(scenarios).filter(c => !silent.includes(c)))
      expect(calls.some(c => c.command === command), `${command} made no Gateway call`).toBe(true);
  }, 60_000);
});
