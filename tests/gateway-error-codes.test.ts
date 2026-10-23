import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";

// Gateway ApiResponse<object>.ErrorResponse (Shared.Models/DTOs/ApiResponse.cs), serialized camelCase.
// The code and message are the Gateway's order-less label refusal (LabelContentDeclarationService).
const REFUSAL = {
  success: false,
  message: "A label without an order must declare hazmatClassification: 0 (None) when the parcel holds no dangerous goods, or its class.",
  errors: null,
  errorCode: "HazmatDeclarationRequired",
};

describe("Gateway error codes in command output", () => {
  let store: string;
  let server: Server;
  let port = 0;
  let status = 400;
  let responseBody: unknown = REFUSAL;

  beforeEach(async () => {
    store = mkdtempSync(join(tmpdir(), "gateway-error-codes-"));
    status = 400;
    responseBody = REFUSAL;
    server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No local server");
    port = address.port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(store, { recursive: true, force: true });
  });

  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["dist/index.js", ...args], {
      env: { ...process.env, NO_COLOR: "1", FLEXOPS_API_KEY: "live_synthetic", FLEXOPS_GATEWAY_URL: `http://127.0.0.1:${port}`,
        FLEXOPS_LABEL_OPERATION_DIR: join(store, "labels"), FLEXOPS_OPERATION_DIR: join(store, "inventory") },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });
  const createLabel = ["labels", "create", "--maximum-postage", "10.00", "--hazmat", "none"];

  it("labels create prints the error code in human mode", async () => {
    const result = await run(createLabel);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`✗ Gateway rejected label request (HTTP 400 HazmatDeclarationRequired): ${REFUSAL.message}\n`);
  });

  it("labels create --json output is unchanged", async () => {
    const result = await run(["--json", ...createLabel]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`${JSON.stringify({ error: { status: 400, body: REFUSAL } }, null, 2)}\n`);
    expect(result.stderr).toBe(`✗ Gateway rejected label request (HTTP 400): ${REFUSAL.message}\n`);
  });

  it("keeps the old line when the Gateway sends no code, or one that isn't an identifier", async () => {
    responseBody = { success: false, message: "Origin, Destination, and Package are required." };
    expect((await run(createLabel)).stderr).toBe("✗ Gateway rejected label request (HTTP 400): Origin, Destination, and Package are required.\n");
    responseBody = { success: false, message: "Bad.", errorCode: "two words\nand a newline" };
    expect((await run(createLabel)).stderr).toBe("✗ Gateway rejected label request (HTTP 400): Bad.\n");
  });

  it("track prints the error code in human mode only", async () => {
    status = 404;
    responseBody = { success: false, message: "Tracking information not found.", errorCode: "NOT_FOUND" };
    expect((await run(["track", "9400TEST"])).stderr).toBe("✗ Gateway rejected tracking lookup (HTTP 404 NOT_FOUND): Tracking information not found.\n");
    expect((await run(["--json", "track", "9400TEST"])).stderr).toBe("✗ Gateway rejected tracking lookup (HTTP 404): Tracking information not found.\n");
  });

  it("sandbox prints the error code in human mode", async () => {
    status = 429;
    responseBody = { success: false, message: "Too many demo keys.", errorCode: "RATE_LIMITED" };
    expect((await run(["sandbox"])).stderr).toBe("✗ Gateway rejected demo-key request (HTTP 429 RATE_LIMITED): Too many demo keys.\n");
  });

  it("errors that reach the top level (inventory) carry the code in human mode only", async () => {
    status = 403;
    responseBody = { success: false, message: "Missing scope.", errorCode: "INSUFFICIENT_SCOPE" };
    const inventory = ["inventory", "preview", "--sku", "SKU-1", "--warehouse", "1", "--quantity", "2", "--reason", "count"];
    expect((await run(inventory)).stderr).toBe("flexops: HTTP 403 INSUFFICIENT_SCOPE: Missing scope.\n");
    expect((await run(["--json", ...inventory])).stderr).toBe("flexops: Missing scope.\n");
  });
});
