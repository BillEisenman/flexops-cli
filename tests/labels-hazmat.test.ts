import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { parseHazmatClassification, resolveServiceCode } from "../src/commands/labels.js";

describe("parseHazmatClassification", () => {
  it("maps names and numbers to the Gateway HazmatClassification number", () => {
    expect(parseHazmatClassification("none")).toBe(0);
    expect(parseHazmatClassification("NONE")).toBe(0);
    expect(parseHazmatClassification("limited-quantity")).toBe(1);
    expect(parseHazmatClassification("lithium-battery-contained-in-equipment")).toBe(2);
    expect(parseHazmatClassification("lithium-battery-packed-with-equipment")).toBe(3);
    expect(parseHazmatClassification("lithium-battery-standalone")).toBe(4);
    expect(parseHazmatClassification("other-restricted")).toBe(5);
    expect(parseHazmatClassification("lithium-battery-used-device")).toBe(6);
    expect(parseHazmatClassification("4")).toBe(4);
  });

  it("refuses anything else", () => {
    for (const raw of ["", "bogus", "7", "-1", "1.5", "constructor", "__proto__"]) expect(() => parseHazmatClassification(raw)).toThrow("--hazmat");
  });
});

describe("resolveServiceCode", () => {
  it("gives ground-only USPS classes (1, 4, 5, 6) GROUND_ADVANTAGE only when --service was not given", () => {
    for (const cls of [1, 4, 5, 6]) {
      expect(resolveServiceCode("PRIORITY", false, "USPS", cls)).toBe("GROUND_ADVANTAGE");
      expect(resolveServiceCode("PRIORITY", false, " usps ", cls)).toBe("GROUND_ADVANTAGE");
      expect(resolveServiceCode("PRIORITY", true, "USPS", cls)).toBe("PRIORITY");
      expect(resolveServiceCode("PRIORITY", false, "UPS", cls)).toBe("PRIORITY");
    }
    for (const cls of [0, 2, 3, undefined]) expect(resolveServiceCode("PRIORITY", false, "USPS", cls)).toBe("PRIORITY");
  });
});

describe("labels create --hazmat / --order", () => {
  let store: string;
  let server: Server;
  let port = 0;
  const bodies: Record<string, unknown>[] = [];

  beforeEach(async () => {
    store = mkdtempSync(join(tmpdir(), "label-hazmat-test-"));
    bodies.length = 0;
    server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(raw));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "Preview", quotedPostageAmount: 8.5, maximumPostageAmount: 10, currency: "USD",
        expiresAt: new Date(Date.now() + 300000).toISOString(), confirmationToken: "signed-preview" }));
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
    execFile(process.execPath, ["dist/index.js", "--json", "labels", "create", "--maximum-postage", "10.00", ...args], {
      env: { ...process.env, FLEXOPS_API_KEY: "live_synthetic", FLEXOPS_GATEWAY_URL: `http://127.0.0.1:${port}`, FLEXOPS_LABEL_OPERATION_DIR: store },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });

  it("sends --hazmat none as 0", async () => {
    const result = await run(["--hazmat", "none"]);
    expect(result.code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!["hazmatClassification"]).toBe(0);
    expect("orderId" in bodies[0]!).toBe(false);
  });

  it("sends a named class as its number", async () => {
    expect((await run(["--hazmat", "lithium-battery-contained-in-equipment"])).code).toBe(0);
    expect(bodies[0]!["hazmatClassification"]).toBe(2);
  });

  it("does not require --hazmat with --order, and does not invent one", async () => {
    expect((await run(["--order", "42"])).code).toBe(0);
    expect(bodies[0]!["orderId"]).toBe(42);
    expect("hazmatClassification" in bodies[0]!).toBe(false);
  });

  it("refuses a label without --order or --hazmat before calling the Gateway", async () => {
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--hazmat");
    expect(bodies).toHaveLength(0);
  });

  it("sends GROUND_ADVANTAGE for a ground-only class when --service is not given", async () => {
    for (const hazmat of ["limited-quantity", "lithium-battery-standalone", "other-restricted", "lithium-battery-used-device", "4"]) {
      bodies.length = 0;
      rmSync(store, { recursive: true, force: true });
      expect((await run(["--hazmat", hazmat])).code).toBe(0);
      expect(bodies[0]!["serviceCode"]).toBe("GROUND_ADVANTAGE");
      expect(bodies[0]!["carrierCode"]).toBe("USPS");
    }
  });

  it("keeps PRIORITY for none and for air-eligible classes, an explicit --service, and other carriers", async () => {
    const cases: [string[], string][] = [
      [["--hazmat", "none"], "PRIORITY"],
      [["--hazmat", "lithium-battery-contained-in-equipment"], "PRIORITY"],
      [["--hazmat", "lithium-battery-packed-with-equipment"], "PRIORITY"],
      [["--hazmat", "lithium-battery-standalone", "--service", "PRIORITY"], "PRIORITY"],
      [["--hazmat", "limited-quantity", "--carrier", "UPS"], "PRIORITY"],
      [["--order", "42"], "PRIORITY"],
    ];
    for (const [args, expected] of cases) {
      bodies.length = 0;
      rmSync(store, { recursive: true, force: true });
      expect((await run(args)).code).toBe(0);
      expect(bodies[0]!["serviceCode"]).toBe(expected);
    }
  });

  it("says why the service changed in human mode", async () => {
    const result = await new Promise<{ stdout: string }>(resolve => {
      execFile(process.execPath, ["dist/index.js", "labels", "create", "--maximum-postage", "10.00", "--hazmat", "other-restricted"], {
        env: { ...process.env, NO_COLOR: "1", FLEXOPS_API_KEY: "live_synthetic", FLEXOPS_GATEWAY_URL: `http://127.0.0.1:${port}`, FLEXOPS_LABEL_OPERATION_DIR: store },
      }, (_error, stdout) => resolve({ stdout }));
    });
    expect(result.stdout).toContain("--hazmat other-restricted ships on USPS Ground Advantage only: using GROUND_ADVANTAGE, not the PRIORITY default. Pass --service to choose.");
    expect(result.stdout).toContain("Preparing USPS GROUND_ADVANTAGE label");
  });

  it("refuses an unknown class and an invalid order before calling the Gateway", async () => {
    expect((await run(["--hazmat", "bogus"])).code).toBe(1);
    expect((await run(["--order", "0"])).code).toBe(1);
    expect(bodies).toHaveLength(0);
  });
});
