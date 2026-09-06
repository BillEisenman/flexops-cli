#!/usr/bin/env node
/**
 * @flexops/cli — command-line companion for the FlexOps Gateway API.
 *
 * Shipping commands support sandbox keys; inventory writes require a live key
 * and a persisted preview/approval workflow.
 */
import { Command } from "commander";
import { registerSandboxCommand } from "./commands/sandbox.js";
import { registerLabelsCommand } from "./commands/labels.js";
import { registerTrackCommand } from "./commands/track.js";
import { CLI_VERSION } from "./version.js";
import { registerInventoryCommand } from "./commands/inventory.js";
import { registerInventoryMcpCommand } from "./commands/inventory-mcp.js";

const program = new Command();

program
  .name("flexops")
  .description(
    "Command-line companion for the FlexOps Gateway API.\n\n" +
      "Sandbox-first: `flexops sandbox` issues a 1-hour `test_` key without " +
      "signup, and `flexops labels create` ships a real sandbox label using " +
      "that key. Swap in a `live_` key via --key or FLEXOPS_API_KEY when ready."
  )
  .version(CLI_VERSION, "-v, --version", "Show the CLI version")
  .option(
    "--gateway-url <url>",
    "Gateway base URL (defaults to https://gateway.flexops.io or $FLEXOPS_GATEWAY_URL)"
  )
  .option("--json", "Output machine-readable JSON instead of human-formatted text")
  .showHelpAfterError("(run `flexops <command> --help` for command-specific options)");

registerSandboxCommand(program);
registerLabelsCommand(program);
registerTrackCommand(program);
registerInventoryCommand(program);
registerInventoryMcpCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`flexops: ${message}\n`);
  process.exit(1);
});
