import { Command } from "commander";
import { resolveConfig, requireApiKey } from "../lib/config.js";
import { gatewayFetch, GatewayError } from "../lib/http.js";
import { writeJson, writeStdout, writeSuccess, writeInfo, writeError, dim, bold } from "../lib/output.js";

interface TrackingResponse {
  status?: string;
  statusCode?: string;
  carrierCode?: string;
  location?: string;
  estimatedDeliveryDate?: string;
  events?: Array<{
    timestamp?: string;
    status?: string;
    description?: string;
    location?: string;
  }>;
}

export function registerTrackCommand(program: Command): void {
  program
    .command("track <trackingNumber>")
    .description("Look up the latest tracking event for a shipment.")
    .option("--key <key>", "API key (defaults to FLEXOPS_API_KEY)")
    .action(async (trackingNumber: string, opts: Record<string, unknown>, cmd: Command) => {
      const cfg = resolveConfig(cmd, opts);
      try {
        const apiKey = requireApiKey(cfg);
        const response = await gatewayFetch<TrackingResponse>(
          cfg.gatewayUrl,
          `/api/v1/shipping/track/${encodeURIComponent(trackingNumber)}`,
          { apiKey }
        );

        if (cfg.json) {
          writeJson(response);
          return;
        }

        const label = response.status ? bold(response.status) : "(no status reported)";
        writeSuccess(`${label}${response.statusCode ? dim(` [${response.statusCode}]`) : ""}`);

        if (response.location) writeStdout(`  Location: ${response.location}`);
        if (response.carrierCode) writeStdout(`  Carrier: ${dim(response.carrierCode)}`);
        if (response.estimatedDeliveryDate) writeStdout(`  ETA: ${response.estimatedDeliveryDate}`);

        if (Array.isArray(response.events) && response.events.length > 0) {
          writeStdout("");
          writeInfo("Recent events:");
          for (const ev of response.events.slice(0, 5)) {
            const when = ev.timestamp ? dim(ev.timestamp) : dim("(no timestamp)");
            const what = ev.description ?? ev.status ?? "(no description)";
            const where = ev.location ? dim(` — ${ev.location}`) : "";
            writeStdout(`  ${when}  ${what}${where}`);
          }
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          writeError(`Gateway rejected tracking lookup (HTTP ${err.status}): ${err.message}`);
        } else {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}
