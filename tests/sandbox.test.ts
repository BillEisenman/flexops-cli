import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";

// Mirrors Gateway IssueDemoApiKeyResponse (Shared.Models/DTOs/SandboxDemoKeyDTOs.cs),
// serialized camelCase by ASP.NET Core. The key is `secretKey`, not `apiKey`.
const SYNTHETIC_KEY = "test_synthetic_demo_key";
const GATEWAY_RESPONSE = {
  secretKey: SYNTHETIC_KEY,
  apiKeyId: 42,
  expiresAt: "2026-10-16T18:00:00Z",
  exampleCurl: "curl -X POST http://127.0.0.1/api/v1/shipping/labels",
  docsUrl: "https://docs.flexops.io/concepts/sandbox",
};

describe("sandbox", () => {
  let server: Server;
  let port = 0;
  let responseBody: unknown = GATEWAY_RESPONSE;
  const requests: { method: string | undefined; url: string | undefined }[] = [];

  beforeEach(async () => {
    responseBody = GATEWAY_RESPONSE;
    requests.length = 0;
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No local server");
    port = address.port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, FLEXOPS_GATEWAY_URL: `http://127.0.0.1:${port}`, NO_COLOR: "1" };
    delete env["FLEXOPS_API_KEY"];
    execFile(process.execPath, ["dist/index.js", ...args, "sandbox"], { env },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });

  it("prints the secretKey the Gateway returns", async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: "POST", url: "/api/Sandbox/demo-keys" }]);
    expect(result.stdout).not.toContain("undefined");
    expect(result.stdout).toContain(`export FLEXOPS_API_KEY=${SYNTHETIC_KEY}`);
    // labels create refuses to run without --hazmat (or --order), so the hint must include it.
    expect(result.stdout).toContain(`flexops labels create --key ${SYNTHETIC_KEY} --from 78701 --to 97201 --weight-oz 8 --hazmat none`);
    expect(result.stdout).toContain(GATEWAY_RESPONSE.expiresAt);
  });

  it("passes the Gateway response through unchanged with --json", async () => {
    const result = await run(["--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(GATEWAY_RESPONSE);
  });

  for (const [label, body] of [
    ["has no secretKey", { apiKey: SYNTHETIC_KEY, expiresAt: GATEWAY_RESPONSE.expiresAt }],
    ["has an empty secretKey", { ...GATEWAY_RESPONSE, secretKey: "" }],
    ["has a non-test_ secretKey", { ...GATEWAY_RESPONSE, secretKey: "live_should_never_come_from_demo" }],
    ["is not an object", null],
  ] as const) {
    for (const args of [[], ["--json"]]) {
      it(`fails clearly when the response ${label} (${args.length ? "--json" : "human"})`, async () => {
        responseBody = body;
        const result = await run([...args]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("did not include a sandbox key");
        expect(result.stderr).not.toContain("undefined");
      });
    }
  }
});
