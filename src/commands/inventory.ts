import { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig, requireApiKey, type ResolvedConfig } from "../lib/config.js";
import { gatewayFetch } from "../lib/http.js";

type Inputs = { sku: string; warehouse_id: number; quantity_change: number; reason: string };
type Operation = { gateway: string; keyHash: string; body: string; preview: Record<string, unknown> };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = () => process.env["FLEXOPS_OPERATION_DIR"] || join(homedir(), ".flexops", "operations");

function credentials(config: ResolvedConfig) {
  const key = requireApiKey(config);
  if (!key.startsWith("live_")) throw new Error("Fulfillment writes require a non-sandbox key.");
  const url = new URL(config.gatewayUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS Gateway origin (HTTP is permitted only on loopback).");
  }
  return { key, gateway: url.origin };
}

// Immutable records are flushed before dispatch. The server owns concurrency and replay;
// local decision/result markers never authorize a different request or a fresh key.
function record(path: string, value: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}

function directory(id: string, store: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid operation ID.");
  return join(store, id);
}

async function call(gateway: string, key: string, id: string, body: string) {
  const response = await gatewayFetch<any>(gateway, "/api/mcp", {
    method: "POST", apiKey: key, idempotencyKey: id, body: JSON.parse(body),
  });
  const result = response?.result;
  const data = result?.structuredContent;
  if (response?.error || !data || typeof data.status !== "string") throw new Error("Unclassified response. Keep this operation and retry its original request; never create a replacement key.");
  return { ...data, isError: result.isError === true };
}

export async function previewInventory(config: ResolvedConfig, input: Inputs, store = root()) {
  const { key, gateway } = credentials(config);
  if (typeof input.sku !== "string" || !input.sku.trim() || input.sku.length > 100 ||
      typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 256 ||
      !Number.isSafeInteger(input.warehouse_id) || input.warehouse_id <= 0 ||
      !Number.isSafeInteger(input.quantity_change) || input.quantity_change === 0 || Math.abs(input.quantity_change) > 2147483647) {
    throw new Error("Provide a SKU (1–100 chars), reason (1–256 chars), positive warehouse ID and nonzero integer quantity.");
  }
  // ponytail: scan the local operation directory; index/archive it if history becomes large.
  for (const existing of existsSync(store) ? readdirSync(store) : []) {
    const dir = directory(existing, store);
    if (!existsSync(join(dir, "decision.json")) || existsSync(join(dir, "result.json")) || existsSync(join(dir, "rejected.json"))) continue;
    const decision = JSON.parse(readFileSync(join(dir, "decision.json"), "utf8"));
    if (decision.cancelled) continue;
    const operation: Operation = JSON.parse(readFileSync(join(dir, "operation.json"), "utf8"));
    if (operation.gateway === gateway && operation.keyHash === hash(key) && operation.preview.sku === input.sku.trim() && operation.preview.warehouse_id === input.warehouse_id) {
      throw new Error(`Resolve operation ${existing} before preparing another adjustment for this inventory.`);
    }
  }
  const id = randomUUID();
  const args = { ...input, sku: input.sku.trim(), reason: input.reason.trim() };
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "adjust_inventory", arguments: args } };
  const response = await call(gateway, key, id, JSON.stringify(body));
  const preview = response.data;
  if (response.isError || response.status !== "Preview" || typeof preview?.confirmationToken !== "string" || !preview.confirmationToken ||
      !["currentStock", "availableStock", "resultingStock", "resultingAvailableStock"].every(field => Number.isSafeInteger(preview[field]))) {
    throw new Error("Gateway did not return a valid inventory preview. Nothing was committed.");
  }
  const commit = { ...body, params: { ...body.params, arguments: { ...args, confirmation_token: preview.confirmationToken } } };
  const safePreview = { ...args, currentStock: preview.currentStock, availableStock: preview.availableStock,
    resultingStock: preview.resultingStock, resultingAvailableStock: preview.resultingAvailableStock,
    maxAdjustment: preview.maxAdjustment, allowNegativeInventory: preview.allowNegativeInventory, expiresAt: preview.expiresAt };
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const dir = directory(id, store);
  mkdirSync(dir, { mode: 0o700 });
  record(join(dir, "operation.json"), { gateway, keyHash: hash(key), body: JSON.stringify(commit), preview: safePreview });
  return { operation: id, status: "AwaitingApproval", preview: safePreview };
}

export async function commitInventory(config: ResolvedConfig, id: string, approve = false, reconcile = false, store = root()) {
  const { key, gateway } = credentials(config);
  const dir = directory(id, store);
  const operation: Operation = JSON.parse(readFileSync(join(dir, "operation.json"), "utf8"));
  if (operation.gateway !== gateway || operation.keyHash !== hash(key)) throw new Error("Use the original Gateway and API key for this operation.");
  const request = JSON.parse(operation.body);
  if (request.method !== "tools/call" || request.params?.name !== "adjust_inventory" ||
      typeof request.params?.arguments?.confirmation_token !== "string") throw new Error("Invalid saved adjustment.");
  if (!["sku", "warehouse_id", "quantity_change", "reason"].every(field => request.params.arguments[field] === operation.preview[field])) {
    throw new Error("Saved request differs from its preview. No commit is permitted.");
  }
  const decision = join(dir, "decision.json");
  if (!existsSync(decision)) {
    if (!approve) return { operation: id, status: "AwaitingApproval", preview: operation.preview };
    try { record(decision, { approvedHash: hash(operation.body) }); } catch (error) { if (!existsSync(decision)) throw error; }
  }
  if (JSON.parse(readFileSync(decision, "utf8")).approvedHash !== hash(operation.body)) throw new Error("Operation cancelled or approved inputs changed. No commit is permitted.");
  if (existsSync(join(dir, "result.json"))) return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  if (existsSync(join(dir, "rejected.json"))) throw new Error("Definitive precondition rejection. Prepare a new preview and obtain new approval.");
  if (existsSync(join(dir, "blocked.json")) && !reconcile) throw new Error("Outcome requires operator reconciliation. Do not create a new operation. Use --reconcile only after checking authoritative server records.");
  // Persisted body and ID are the only source for every attempt, including after restart.
  const result = await call(gateway, key, id, operation.body);
  const safeResult = { operation: id, status: result.status, actionId: result.actionId, replayed: result.replayed, code: result.error?.code };
  const file = result.status === "Succeeded" && !result.isError ? "result.json"
    : result.isError && result.error?.httpStatus === 412 ? "rejected.json" : "blocked.json";
  try { record(join(dir, file), safeResult); } catch (error) { if (!existsSync(join(dir, file))) throw error; }
  if (file === "rejected.json") throw new Error("Definitive precondition rejection. Prepare a new preview and obtain new approval.");
  if (file === "blocked.json") throw new Error("Operation stopped. Reconcile using the original operation; do not generate a replacement key.");
  return safeResult;
}

export function cancelInventory(id: string, store = root()) {
  const dir = directory(id, store);
  if (!existsSync(join(dir, "operation.json"))) throw new Error("Unknown operation.");
  record(join(dir, "decision.json"), { cancelled: true });
  return { operation: id, status: "Cancelled" };
}

export function inspectInventory(config: ResolvedConfig, id: string, store = root()) {
  const { key, gateway } = credentials(config);
  const dir = directory(id, store);
  const saved: Operation = JSON.parse(readFileSync(join(dir, "operation.json"), "utf8"));
  if (saved.gateway !== gateway || saved.keyHash !== hash(key)) throw new Error("Use the original Gateway and API key for this operation.");
  const decision = existsSync(join(dir, "decision.json")) ? JSON.parse(readFileSync(join(dir, "decision.json"), "utf8")) : null;
  const outcome = ["result.json", "rejected.json", "blocked.json"].find(file => existsSync(join(dir, file)));
  return { operation: id, preview: saved.preview, status: outcome ? JSON.parse(readFileSync(join(dir, outcome), "utf8")).status
    : decision?.cancelled ? "Cancelled" : decision ? "ApprovedUnresolved" : "AwaitingApproval" };
}

export function registerInventoryCommand(program: Command) {
  const inventory = program.command("inventory").description("Persisted, approval-gated inventory adjustments over MCP HTTP.");
  inventory.command("preview").requiredOption("--sku <sku>").requiredOption("--warehouse <id>")
    .requiredOption("--quantity <delta>").requiredOption("--reason <reason>")
    .action(async (opts, cmd) => console.log(JSON.stringify(await previewInventory(resolveConfig(cmd, opts), {
      sku: opts.sku, warehouse_id: Number(opts.warehouse), quantity_change: Number(opts.quantity), reason: opts.reason,
    }))));
  inventory.command("commit <operation>").option("--approve", "Only after the operator explicitly approves the displayed preview")
    .option("--reconcile", "Replay the original request after operator investigation; never repairs server state")
    .action(async (id, opts, cmd) => console.log(JSON.stringify(await commitInventory(resolveConfig(cmd, opts), id, opts.approve, opts.reconcile))));
  inventory.command("cancel <operation>").action(id => console.log(JSON.stringify(cancelInventory(id))));
}
