import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { requireApiKey, resolveConfig, DEFAULT_GATEWAY_URL } from "../src/lib/config.js";

function makeCommand(): Command {
  const root = new Command();
  root
    .option("--gateway-url <url>")
    .option("--json")
    .option("--key <key>");
  return root;
}

describe("resolveConfig", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env["FLEXOPS_API_KEY"];
    delete process.env["FLEXOPS_GATEWAY_URL"];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("defaults to the production Gateway URL when no flag or env is set", () => {
    const cmd = makeCommand();
    cmd.parse([], { from: "user" });
    const cfg = resolveConfig(cmd, cmd.opts());
    expect(cfg.gatewayUrl).toBe(DEFAULT_GATEWAY_URL);
  });

  it("prefers --gateway-url over the env var", () => {
    process.env["FLEXOPS_GATEWAY_URL"] = "https://env.example";
    const cmd = makeCommand();
    cmd.parse(["--gateway-url", "https://flag.example"], { from: "user" });
    const cfg = resolveConfig(cmd, cmd.opts());
    expect(cfg.gatewayUrl).toBe("https://flag.example");
  });

  it("trims trailing slashes from the resolved Gateway URL", () => {
    const cmd = makeCommand();
    cmd.parse(["--gateway-url", "https://gw.example///"], { from: "user" });
    const cfg = resolveConfig(cmd, cmd.opts());
    expect(cfg.gatewayUrl).toBe("https://gw.example");
  });

  it("falls back to FLEXOPS_API_KEY when --key is absent", () => {
    process.env["FLEXOPS_API_KEY"] = "test_fromenv";
    const cmd = makeCommand();
    cmd.parse([], { from: "user" });
    const cfg = resolveConfig(cmd, cmd.opts());
    expect(cfg.apiKey).toBe("test_fromenv");
  });

  it("emits json=true when --json is set", () => {
    const cmd = makeCommand();
    cmd.parse(["--json"], { from: "user" });
    const cfg = resolveConfig(cmd, cmd.opts());
    expect(cfg.json).toBe(true);
  });
});

describe("requireApiKey", () => {
  it("returns the key when prefixed with test_", () => {
    expect(requireApiKey({ gatewayUrl: "x", apiKey: "test_abc", json: false })).toBe("test_abc");
  });

  it("returns the key when prefixed with live_", () => {
    expect(requireApiKey({ gatewayUrl: "x", apiKey: "live_abc", json: false })).toBe("live_abc");
  });

  it("throws a friendly multi-line error when no key is supplied", () => {
    expect(() => requireApiKey({ gatewayUrl: "x", json: false })).toThrow(/No API key provided/);
  });

  it("rejects keys without the test_/live_ prefix so a Bearer-like string doesn't 401 silently", () => {
    expect(() => requireApiKey({ gatewayUrl: "x", apiKey: "eyJhbGciOi...", json: false })).toThrow(/must start with/);
  });
});
