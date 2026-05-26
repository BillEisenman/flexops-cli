import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayFetch, GatewayError } from "../src/lib/http.js";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("gatewayFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends X-API-Key (NOT Authorization: Bearer) when an apiKey is supplied", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await gatewayFetch("https://gw.example", "/api/Sandbox/demo-keys", {
      method: "POST",
      apiKey: "test_abc",
      body: {},
    });

    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test_abc");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("normalizes the path so callers can pass `path` with or without a leading slash", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({}));
    await gatewayFetch("https://gw.example", "api/track/X");
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe("https://gw.example/api/track/X");
  });

  it("throws GatewayError on non-2xx responses with the parsed body inlined", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ message: "key expired" }, { status: 401 })
    );

    await expect(gatewayFetch("https://gw.example", "/api/v1/shipping/labels")).rejects.toMatchObject({
      name: "GatewayError",
      status: 401,
      message: "key expired",
    });
  });

  it("falls back to a generic message when the error body has no `message` field", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ foo: "bar" }, { status: 500 }));
    await expect(gatewayFetch("https://gw.example", "/x")).rejects.toThrow(/HTTP 500/);
  });

  it("surfaces network failures as a plain Error (not GatewayError) so callers can branch on it", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    try {
      await gatewayFetch("https://gw.example", "/x");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GatewayError);
      expect((err as Error).message).toMatch(/ECONNREFUSED/);
    }
  });
});
