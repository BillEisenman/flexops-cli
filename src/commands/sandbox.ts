import { Command } from "commander";
import { resolveConfig } from "../lib/config.js";
import { gatewayFetch, GatewayError, describeStatus } from "../lib/http.js";
import { writeJson, writeStdout, writeSuccess, writeInfo, writeError, dim, bold } from "../lib/output.js";

/**
 * Mirrors the Gateway's `IssueDemoApiKeyResponse` (Shared.Models/DTOs/SandboxDemoKeyDTOs.cs),
 * serialized camelCase. The key arrives as `secretKey`; there is no `apiKey` field.
 */
interface DemoKeyResponse {
  secretKey: string;
  apiKeyId?: number;
  expiresAt?: string;
  exampleCurl?: string;
  docsUrl?: string;
}

/**
 * Narrows the raw Gateway body to a usable demo key, so a contract drift fails
 * loudly instead of printing `undefined`. The error never echoes the value: a
 * malformed field could still be a credential.
 */
export function readDemoKeyResponse(body: unknown): DemoKeyResponse {
  const secretKey =
    typeof body === "object" && body !== null ? (body as { secretKey?: unknown }).secretKey : undefined;
  if (typeof secretKey !== "string" || !secretKey.startsWith("test_")) {
    throw new Error(
      "Gateway response did not include a sandbox key (expected a `secretKey` starting with `test_`). " +
        "Check --gateway-url, or update @flexops/cli if the Gateway contract changed."
    );
  }
  return body as DemoKeyResponse;
}

export function registerSandboxCommand(program: Command): void {
  program
    .command("sandbox")
    .description(
      "Issue a no-signup sandbox API key (test_…) that lasts ~1 hour and routes through mock carriers. " +
        "Use it as `--key <key>` on subsequent commands or export FLEXOPS_API_KEY."
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const cfg = resolveConfig(cmd, opts);
      try {
        const response = readDemoKeyResponse(
          await gatewayFetch<unknown>(cfg.gatewayUrl, "/api/Sandbox/demo-keys", {
            method: "POST",
          })
        );

        if (cfg.json) {
          writeJson(response);
          return;
        }

        const validity = response.expiresAt ? ` (valid until ${dim(response.expiresAt)})` : "";
        writeSuccess(`Sandbox key issued${validity}:`);
        writeStdout("");
        writeStdout(`  ${bold(response.secretKey)}`);
        writeStdout("");
        writeInfo("Persist it for this terminal session:");
        writeStdout(`  ${dim("export FLEXOPS_API_KEY=" + response.secretKey)}`);
        writeStdout("");
        writeInfo("Or preview a label, then approve it with the command it prints:");
        writeStdout(`  ${dim(`flexops labels create --key ${response.secretKey} --from 78701 --to 97201 --weight-oz 8 --hazmat none --maximum-postage 20.00`)}`);
      } catch (err) {
        if (err instanceof GatewayError) {
          writeError(`Gateway rejected demo-key request (${describeStatus(err, cfg.json)}): ${err.message}`);
        } else {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}
