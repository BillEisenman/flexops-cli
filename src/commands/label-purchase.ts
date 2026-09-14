import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayFetch } from "../lib/http.js";
import { requireApiKey, type ResolvedConfig } from "../lib/config.js";
import { record, directory } from "../lib/operation-store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = () => process.env["FLEXOPS_LABEL_OPERATION_DIR"] || join(homedir(), ".flexops", "label-purchases");
type Preview = { status: "Preview"; quotedPostageAmount: number; maximumPostageAmount: number; currency: string; expiresAt: string; confirmationToken: string };
type Operation = { gateway: string; keyHash: string; body: string; preview: Omit<Preview, "confirmationToken">; requestHash: string };
function credentials(config: ResolvedConfig) {
  const key = requireApiKey(config), url = new URL(config.gatewayUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Use an HTTPS Gateway origin (HTTP is permitted only on loopback).");
  return { key, gateway: url.origin };
}
export async function prepareLabel(config: ResolvedConfig, payload: Record<string, unknown>, maximum?: number, store = root()) {
  const { key, gateway } = credentials(config);
  if (!key.startsWith("test_") && (!maximum || maximum <= 0 || !Number.isFinite(maximum) || maximum > 1000000 || Math.abs(maximum * 100 - Math.round(maximum * 100)) > 1e-7))
    throw new Error("Supply --maximum-postage in USD with at most two decimal places.");
  const requestHash = hash(JSON.stringify(payload));
  if (existsSync(store)) for (const id of readdirSync(store)) {
    const dir = directory(id, store);
    const saved: Operation = JSON.parse(readFileSync(join(dir, "operation.json"), "utf8"));
    if (saved.gateway === gateway && saved.keyHash === hash(key) && saved.requestHash === requestHash && !existsSync(join(dir, "cancelled.json")))
      throw new Error(`Use saved purchase ${id}; do not create another key for the same shipment.`);
  }
  const id = randomUUID();
  const body = { ...payload, maximumPostageAmount: maximum };
  const response = await gatewayFetch<Preview & { isSandbox?: boolean; trackingNumber?: string }>(gateway, "/api/v1/shipping/labels", {
    method: "POST", apiKey: key, idempotencyKey: id, body,
  });
  if (response.isSandbox === true && response.trackingNumber) return response;
  if (response.status !== "Preview" || !response.confirmationToken || response.currency !== "USD" ||
      !Number.isFinite(response.quotedPostageAmount) || response.quotedPostageAmount <= 0 || response.quotedPostageAmount > maximum! ||
      response.maximumPostageAmount !== maximum || !Number.isFinite(Date.parse(response.expiresAt)))
    throw new Error("Gateway did not return a valid bounded preview. Nothing was approved.");
  const { confirmationToken, ...preview } = response;
  mkdirSync(store, { recursive: true, mode: 0o700 }); const dir = directory(id, store); mkdirSync(dir, { mode: 0o700 });
  record(join(dir, "operation.json"), { gateway, keyHash: hash(key), requestHash,
    body: JSON.stringify({ ...body, confirmationToken }), preview });
  return { operation: id, status: "AwaitingApproval", preview };
}
export async function approveLabel(config: ResolvedConfig, id: string, approve = false, store = root()) {
  const { key, gateway } = credentials(config), dir = directory(id, store);
  const op: Operation = JSON.parse(readFileSync(join(dir, "operation.json"), "utf8"));
  if (op.gateway !== gateway || op.keyHash !== hash(key)) throw new Error("Use the original Gateway and API key.");
  if (existsSync(join(dir, "cancelled.json"))) throw new Error("Purchase was cancelled before approval.");
  const body = JSON.parse(op.body);
  const { maximumPostageAmount, confirmationToken, ...shipment } = body;
  if (hash(JSON.stringify(shipment)) !== op.requestHash || maximumPostageAmount !== op.preview.maximumPostageAmount || !confirmationToken)
    throw new Error("Saved purchase differs from its preview.");
  const decision = join(dir, "decision.json");
  if (!existsSync(decision)) {
    if (!approve) return { operation: id, status: "AwaitingApproval", preview: op.preview };
    if (Date.parse(op.preview.expiresAt) <= Date.now()) throw new Error("Approval expired. Cancel this unapproved operation and preview again.");
    try { record(decision, { hash: hash(op.body) }); } catch (error) { if (!existsSync(decision)) throw error; }
  }
  if (JSON.parse(readFileSync(decision, "utf8")).hash !== hash(op.body)) throw new Error("Approved purchase changed.");
  // Once dispatch is possible, even after a crash, only the saved key and body may be retried.
  const result = await gatewayFetch<Record<string, unknown>>(gateway, "/api/v1/shipping/labels", { method: "POST", apiKey: key, idempotencyKey: id, body });
  if (!result.trackingNumber) throw new Error(`Unresolved purchase ${id}. Retain this operation and reconcile; do not create another label.`);
  return { operation: id, ...result };
}
export function cancelLabelPreview(id: string, store = root()) {
  const dir = directory(id, store);
  // The same exclusive decision file arbitrates cancellation versus first approval.
  record(join(dir, "decision.json"), { cancelled: true });
  record(join(dir, "cancelled.json"), { cancelled: true });
  return { operation: id, status: "Cancelled" };
}
