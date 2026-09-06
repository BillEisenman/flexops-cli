import { Command } from "commander";
import { once } from "node:events";
import { resolveConfig, type ResolvedConfig } from "../lib/config.js";
import { CLI_VERSION } from "../version.js";
import { previewInventory, commitInventory, cancelInventory, inspectInventory } from "./inventory.js";

const operation = { type: "string", format: "uuid", description: "The saved operation UUID returned by preview. Reuse it after any lost response." };
const tools = [
  { name: "preview_inventory_adjustment", description: "Prepare a stock adjustment without committing. Show the complete returned quantities and policy to the user and ask for explicit approval before commit. Never replace an unresolved operation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["sku", "warehouse_id", "quantity_change", "reason"], properties: {
      sku: { type: "string", minLength: 1, maxLength: 100 }, warehouse_id: { type: "integer", minimum: 1 },
      quantity_change: { type: "integer", minimum: -2147483647, maximum: 2147483647 }, reason: { type: "string", minLength: 1, maxLength: 256 },
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "inspect_inventory_adjustment", description: "Read the saved preview, approval and outcome of one inventory operation. Does not retry or commit.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: { operation } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "commit_inventory_adjustment", description: "Change stock using a saved preview. Only call after the user explicitly approves its exact quantities and policy. Set approved to true only for that approval. Retries MUST use the original operation UUID. Stop on uncertain outcome; operator reconciliation is terminal-only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation", "approved"], properties: { operation, approved: { type: "boolean", const: true } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "cancel_inventory_adjustment", description: "Cancel a saved adjustment before it is approved. Cannot cancel an approved or uncertain operation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: { operation } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];

async function invoke(config: ResolvedConfig, name: string, args: Record<string, unknown>) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error("Unknown inventory tool.");
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) ||
      tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) throw new Error("Invalid tool arguments.");
  if (name === "preview_inventory_adjustment") {
    return previewInventory(config, { sku: args.sku as string, warehouse_id: args.warehouse_id as number,
      quantity_change: args.quantity_change as number, reason: args.reason as string });
  }
  if (typeof args.operation !== "string") throw new Error("Operation UUID is required.");
  if (name === "inspect_inventory_adjustment") return inspectInventory(config, args.operation);
  if (name === "cancel_inventory_adjustment") {
    inspectInventory(config, args.operation);
    return cancelInventory(args.operation);
  }
  if (args.approved !== true) throw new Error("Explicit approval of the displayed preview is required.");
  return commitInventory(config, args.operation, true);
}

// ponytail: one request at a time and a 64 KiB frame limit; use an MCP SDK if we add
// streaming, resources or concurrent tools. Stdio is private to the launching host.
export async function serveInventory(config: ResolvedConfig) {
  let pending = "", initialized = false;
  process.stdin.setEncoding("utf8");
  const send = async (message: unknown) => {
    if (!process.stdout.write(JSON.stringify(message) + "\n")) await once(process.stdout, "drain");
  };
  for await (const chunk of process.stdin) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 65536) throw new Error("MCP frame exceeds 64 KiB.");
      let request: any;
      try { request = JSON.parse(line); } catch { await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); continue; }
      if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
          (request.id !== undefined && typeof request.id !== "string" && !(typeof request.id === "number" && Number.isSafeInteger(request.id)))) {
        await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } }); continue;
      }
      if (request.id === undefined) continue; // Notifications never dispatch writes or receive replies.
      let result: unknown;
      if (request.method === "initialize") {
        if (typeof request.params?.protocolVersion !== "string" || !request.params?.capabilities ||
            typeof request.params.capabilities !== "object" || Array.isArray(request.params.capabilities) ||
            typeof request.params?.clientInfo?.name !== "string" || typeof request.params?.clientInfo?.version !== "string") {
          await send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid initialization parameters." } }); continue;
        }
        initialized = true;
        const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
        result = { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : versions[0],
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: "flexops-inventory", version: CLI_VERSION },
          instructions: "Private single-identity inventory connector. Preview, show quantities and policy, then wait for explicit human approval. Keep the operation UUID for all retries. Never bypass reconciliation or create a replacement for an uncertain outcome." };
      } else if (request.method === "ping") result = {};
      else if (!initialized) { await send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Initialize first." } }); continue; }
      else if (request.method === "tools/list") result = { tools };
      else if (request.method === "tools/call") {
        try {
          const args = request.params?.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object.");
          const data = await invoke(config, request.params?.name, args);
          result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : "Inventory operation failed." }], isError: true };
        }
      } else { await send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found." } }); continue; }
      await send({ jsonrpc: "2.0", id: request.id, result });
    }
    if (Buffer.byteLength(pending) > 65536) throw new Error("MCP frame exceeds 64 KiB.");
  }
}

export function registerInventoryMcpCommand(program: Command) {
  program.command("inventory-mcp").description("Private stdio MCP adapter for the persisted inventory workflow.")
    .action(async (opts, cmd) => serveInventory(resolveConfig(cmd, opts)));
}
