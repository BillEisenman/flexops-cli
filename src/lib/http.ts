/**
 * Tiny fetch wrapper that talks to the Gateway with the auth contract the
 * server actually enforces (`X-API-Key`, not `Authorization: Bearer`), surfaces
 * non-2xx responses as exceptions with the parsed body inlined, and times out
 * so the CLI can't hang forever waiting on a network blackhole.
 *
 * The Bearer-vs-X-API-Key trap bit us repeatedly during the 2026-05-26 wedge
 * shipping work; encoding the right header here keeps every command honest.
 *
 * Every POST, PUT and PATCH carries an `Idempotency-Key`: the caller's (a saved
 * operation ID, reused on every retry of that operation) or a fresh UUID. The
 * CLI never retries a request itself; a retry is always a deliberate re-run.
 */

import { randomUUID } from "node:crypto";
import { CLI_VERSION } from "../version.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface GatewayRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  apiKey?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export async function gatewayFetch<T = unknown>(
  baseUrl: string,
  path: string,
  options: GatewayRequestOptions = {}
): Promise<T | undefined> {
  const { method = "GET", apiKey, body, timeoutMs = 15_000, signal } = options;

  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const externalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", externalAbort, { once: true });
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `flexops-cli/${CLI_VERSION}`,
  };
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  else if (WRITE_METHODS.has(method)) headers["Idempotency-Key"] = randomUUID();
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gateway request failed: ${message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", externalAbort);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const summary =
      typeof parsed === "object" && parsed !== null && "message" in parsed && typeof (parsed as { message: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `Gateway returned HTTP ${response.status}`;
    throw new GatewayError(summary, response.status, parsed);
  }

  // A 2xx with no body (204, or Content-Length 0) has nothing to return.
  if (text.length === 0) return undefined;
  return parsed as T;
}
