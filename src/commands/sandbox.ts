import { Command } from "commander";
import { resolveConfig } from "../lib/config.js";
import { gatewayFetch, GatewayError } from "../lib/http.js";
import { writeJson, writeStdout, writeSuccess, writeInfo, writeError, dim, bold } from "../lib/output.js";

interface DemoKeyResponse {
  apiKey: string;
  expiresAt: string;
  exampleCurl?: string;
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
        const response = await gatewayFetch<DemoKeyResponse>(cfg.gatewayUrl, "/api/Sandbox/demo-keys", {
          method: "POST",
        });

        if (cfg.json) {
          writeJson(response);
          return;
        }

        writeSuccess(`Sandbox key issued (valid until ${dim(response.expiresAt)}):`);
        writeStdout("");
        writeStdout(`  ${bold(response.apiKey)}`);
        writeStdout("");
        writeInfo("Persist it for this terminal session:");
        writeStdout(`  ${dim("export FLEXOPS_API_KEY=" + response.apiKey)}`);
        writeStdout("");
        writeInfo("Or ship a label immediately:");
        writeStdout(`  ${dim(`flexops labels create --key ${response.apiKey} --from 78701 --to 97201 --weight-oz 8`)}`);
      } catch (err) {
        if (err instanceof GatewayError) {
          writeError(`Gateway rejected demo-key request (HTTP ${err.status}): ${err.message}`);
        } else {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}
