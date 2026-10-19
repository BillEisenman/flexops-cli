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

describe("gatewayFetch writes and empty responses", () => {
  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
  const sentHeaders = (index = 0) => (fetchMock().mock.calls[index]![1] as RequestInit).headers as Record<string, string>;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a fresh UUID Idempotency-Key on every POST, PUT and PATCH without a caller key", async () => {
    for (const method of ["POST", "PUT", "PATCH"] as const) fetchMock().mockResolvedValueOnce(jsonResponse({}));
    await gatewayFetch("https://gw.example", "/x", { method: "POST", body: {} });
    await gatewayFetch("https://gw.example", "/x", { method: "PUT", body: {} });
    await gatewayFetch("https://gw.example", "/x", { method: "PATCH", body: {} });
    const keys = [0, 1, 2].map(i => sentHeaders(i)["Idempotency-Key"]);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps the caller's Idempotency-Key, and sends none on GET or DELETE", async () => {
    fetchMock().mockImplementation(async () => jsonResponse({}));
    await gatewayFetch("https://gw.example", "/x", { method: "POST", body: {}, idempotencyKey: "saved-operation" });
    await gatewayFetch("https://gw.example", "/x");
    await gatewayFetch("https://gw.example", "/x", { method: "DELETE" });
    expect(sentHeaders(0)["Idempotency-Key"]).toBe("saved-operation");
    expect(sentHeaders(1)["Idempotency-Key"]).toBeUndefined();
    expect(sentHeaders(2)["Idempotency-Key"]).toBeUndefined();
  });

  it("sends a write exactly once: no retry after a 500 or a network error", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: "boom" }, { status: 500 }));
    await expect(gatewayFetch("https://gw.example", "/x", { method: "POST", body: {} })).rejects.toThrow("boom");
    fetchMock().mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(gatewayFetch("https://gw.example", "/x", { method: "POST", body: {} })).rejects.toThrow("ECONNRESET");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for a 204 and for an empty 200", async () => {
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock().mockResolvedValueOnce(new Response("", { status: 200, headers: { "content-length": "0" } }));
    expect(await gatewayFetch("https://gw.example", "/x", { method: "DELETE" })).toBeUndefined();
    expect(await gatewayFetch("https://gw.example", "/x", { method: "POST", body: {} })).toBeUndefined();
  });
});
