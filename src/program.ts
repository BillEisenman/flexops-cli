/**
 * Builds the `flexops` command tree. Kept apart from the entry point so tests can
 * enumerate every command without parsing argv or exiting the process.
 */
import { Command } from "commander";
import { registerSandboxCommand } from "./commands/sandbox.js";
import { registerLabelsCommand } from "./commands/labels.js";
import { registerTrackCommand } from "./commands/track.js";
import { CLI_VERSION } from "./version.js";
import { registerInventoryCommand } from "./commands/inventory.js";
import { registerInventoryMcpCommand } from "./commands/inventory-mcp.js";

export function buildProgram(): Command {
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

  return program;
}
