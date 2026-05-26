/**
 * Resolves the Gateway base URL and API key from CLI flags / environment.
 *
 * Precedence (highest first):
 *   1. CLI flag (e.g. --key, --gateway-url) — set on the local or parent Command.
 *   2. Environment variable (FLEXOPS_API_KEY, FLEXOPS_GATEWAY_URL).
 *   3. Hard-coded default (production Gateway).
 *
 * Keys are validated for the `test_` or `live_` prefix the Gateway requires;
 * anything else is rejected loudly so a typo doesn't silently 401.
 */
import { Command } from "commander";

export const DEFAULT_GATEWAY_URL = "https://gateway.flexops.io";

export interface ResolvedConfig {
  gatewayUrl: string;
  apiKey?: string;
  json: boolean;
}

function rootOpts(cmd: Command): Record<string, unknown> {
  // Commander only merges options up the chain when you call .optsWithGlobals().
  return cmd.optsWithGlobals();
}

export function resolveConfig(cmd: Command, opts: Record<string, unknown>): ResolvedConfig {
  const globals = rootOpts(cmd);
  const gatewayUrl =
    (typeof opts["gatewayUrl"] === "string" && opts["gatewayUrl"]) ||
    (typeof globals["gatewayUrl"] === "string" && globals["gatewayUrl"]) ||
    process.env["FLEXOPS_GATEWAY_URL"] ||
    DEFAULT_GATEWAY_URL;

  const apiKey =
    (typeof opts["key"] === "string" && opts["key"]) ||
    (typeof globals["key"] === "string" && globals["key"]) ||
    process.env["FLEXOPS_API_KEY"] ||
    undefined;

  const json = Boolean(opts["json"] ?? globals["json"]);

  return { gatewayUrl: gatewayUrl.replace(/\/+$/, ""), ...(apiKey ? { apiKey } : {}), json };
}

export function requireApiKey(cfg: ResolvedConfig): string {
  if (!cfg.apiKey) {
    throw new Error(
      "No API key provided.\n" +
        "  - Issue a free sandbox key with `flexops sandbox`, then re-run with --key <key>\n" +
        "  - Or export FLEXOPS_API_KEY=test_…\n" +
        "  - Or pass --key live_… for production"
    );
  }
  if (!/^(test_|live_)/.test(cfg.apiKey)) {
    throw new Error(
      `API key must start with \`test_\` or \`live_\` (got "${cfg.apiKey.slice(0, 6)}…"). ` +
        "These prefixes route requests to sandbox vs production. Bare strings are rejected by the Gateway."
    );
  }
  return cfg.apiKey;
}
