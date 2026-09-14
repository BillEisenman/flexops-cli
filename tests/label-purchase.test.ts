import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLabel, approveLabel, cancelLabelPreview } from "../src/commands/label-purchase.js";
import { gatewayFetch } from "../src/lib/http.js";
vi.mock("../src/lib/http.js", () => ({ gatewayFetch: vi.fn() }));
const call = vi.mocked(gatewayFetch);
const config = { gatewayUrl: "https://example.test", apiKey: "live_synthetic", json: true };
const payload = { carrierCode: "USPS", serviceCode: "PRIORITY", origin: { postalCode: "75201" }, destination: { postalCode: "90210" }, package: { weight: 8 } };
let store: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "label-approval-test-")); call.mockReset();
  call.mockResolvedValueOnce({ status: "Preview", quotedPostageAmount: 8.5, maximumPostageAmount: 10,
    currency: "USD", expiresAt: new Date(Date.now() + 300000).toISOString(), confirmationToken: "signed-preview" });
});
afterEach(() => rmSync(store, { recursive: true, force: true }));
it("persists a preview and cancellation never purchases", async () => {
  const prepared = await prepareLabel(config, payload, 10, store);
  if (!("operation" in prepared)) throw new Error("Expected preview");
  expect(await approveLabel(config, prepared.operation, false, store)).toMatchObject({ status: "AwaitingApproval" });
  expect(call).toHaveBeenCalledTimes(1);
  cancelLabelPreview(prepared.operation, store);
  await expect(approveLabel(config, prepared.operation, true, store)).rejects.toThrow("cancelled");
  expect(call).toHaveBeenCalledTimes(1);
});
it("reuses exact persisted body and key after response loss and token expiry", async () => {
  const prepared = await prepareLabel(config, payload, 10, store);
  if (!("operation" in prepared)) throw new Error("Expected preview");
  call.mockRejectedValueOnce(new Error("Lost response"));
  await expect(approveLabel(config, prepared.operation, true, store)).rejects.toThrow("Lost response");
  const path = join(store, prepared.operation, "operation.json");
  const saved = JSON.parse(readFileSync(path, "utf8")); saved.preview.expiresAt = "2000-01-01T00:00:00Z";
  writeFileSync(path, JSON.stringify(saved));
  call.mockResolvedValueOnce({ trackingNumber: "same-label" });
  expect(await approveLabel(config, prepared.operation, false, store)).toMatchObject({ trackingNumber: "same-label" });
  expect(call.mock.calls[1]![2]).toEqual(call.mock.calls[2]![2]);
  expect(call.mock.calls[0]![2]?.idempotencyKey).toBe(call.mock.calls[2]![2]?.idempotencyKey);
  await expect(prepareLabel(config, payload, 20, store)).rejects.toThrow("saved purchase");
});
it("refuses changed shipment or another API key before dispatch", async () => {
  const prepared = await prepareLabel(config, payload, 10, store);
  if (!("operation" in prepared)) throw new Error("Expected preview");
  await expect(approveLabel({ ...config, apiKey: "live_other" }, prepared.operation, true, store)).rejects.toThrow("original");
  const path = join(store, prepared.operation, "operation.json"), saved = JSON.parse(readFileSync(path, "utf8"));
  const body = JSON.parse(saved.body); body.carrierCode = "UPS"; saved.body = JSON.stringify(body); writeFileSync(path, JSON.stringify(saved));
  await expect(approveLabel(config, prepared.operation, true, store)).rejects.toThrow("differs");
  expect(call).toHaveBeenCalledTimes(1);
});

it("runs create and explicit approve in separate CLI processes", async () => {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const requests: { key: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ key: String(req.headers['idempotency-key']), body });
    expect(req.url).toBe('/api/v1/shipping/labels');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body.confirmationToken ? { trackingNumber: 'synthetic-cli-label' } : {
      status: 'Preview', quotedPostageAmount: 8.5, maximumPostageAmount: 10, currency: 'USD',
      expiresAt: new Date(Date.now() + 300000).toISOString(), confirmationToken: 'signed-preview' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local server');
    const run = (args: string[]) => promisify(execFile)(process.execPath, ['dist/index.js', '--json', ...args], {
      env: { ...process.env, FLEXOPS_API_KEY: 'live_synthetic', FLEXOPS_GATEWAY_URL: `http://127.0.0.1:${address.port}`, FLEXOPS_LABEL_OPERATION_DIR: store },
    });
    const preview = JSON.parse((await run(['labels', 'create', '--maximum-postage', '10.00'])).stdout);
    expect(requests).toHaveLength(1);
    await run(['labels', 'approve', preview.operation]);
    expect(requests).toHaveLength(1);
    const purchased = JSON.parse((await run(['labels', 'approve', preview.operation, '--approve'])).stdout);
    expect(purchased.trackingNumber).toBe('synthetic-cli-label');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBe(requests[1]!.key);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
