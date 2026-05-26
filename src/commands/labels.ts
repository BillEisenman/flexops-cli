import { Command } from "commander";
import { resolveConfig, requireApiKey } from "../lib/config.js";
import { gatewayFetch, GatewayError } from "../lib/http.js";
import { writeJson, writeStdout, writeSuccess, writeInfo, writeError, dim, bold } from "../lib/output.js";

interface LabelResponse {
  trackingNumber?: string;
  labelUrl?: string;
  labelData?: string;
  carrierCode?: string;
  serviceCode?: string;
  rate?: number;
  currency?: string;
}

function parsePositiveNumber(name: string, raw: string | undefined, fallback?: number): number {
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive number (got "${raw}")`);
  }
  return n;
}

export function registerLabelsCommand(program: Command): void {
  const labels = program.command("labels").description("Create and inspect shipping labels.");

  labels
    .command("create")
    .description(
      "Create a sandbox or production shipping label. Defaults match the homepage demo " +
        "(USPS Priority, 78701 -> 97201) so a no-flag invocation succeeds end-to-end."
    )
    .option("--key <key>", "API key (defaults to FLEXOPS_API_KEY)")
    .option("--carrier <code>", "Carrier code (USPS, UPS, FEDEX, DHL)", "USPS")
    .option("--service <code>", "Service code (PRIORITY, GROUND, etc.)", "PRIORITY")
    .option("--from <postalCode>", "Origin postal code", "78701")
    .option("--from-name <name>", "Origin contact name", "FlexOps Demo")
    .option("--from-address <line1>", "Origin street address", "1 Demo Way")
    .option("--from-city <city>", "Origin city", "Austin")
    .option("--from-state <code>", "Origin state code", "TX")
    .option("--from-country <code>", "Origin country code (ISO-2)", "US")
    .option("--to <postalCode>", "Destination postal code", "97201")
    .option("--to-name <name>", "Destination contact name", "Sandbox Recipient")
    .option("--to-address <line1>", "Destination street address", "1 Sample St")
    .option("--to-city <city>", "Destination city", "Portland")
    .option("--to-state <code>", "Destination state code", "OR")
    .option("--to-country <code>", "Destination country code (ISO-2)", "US")
    .option("--weight-oz <ounces>", "Package weight in ounces", "8")
    .option("--length-in <inches>", "Package length in inches", "10")
    .option("--width-in <inches>", "Package width in inches", "6")
    .option("--height-in <inches>", "Package height in inches", "4")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const cfg = resolveConfig(cmd, opts);
      try {
        const apiKey = requireApiKey(cfg);
        const payload = {
          carrierCode: String(opts["carrier"]),
          serviceCode: String(opts["service"]),
          origin: {
            name: String(opts["fromName"]),
            addressLine1: String(opts["fromAddress"]),
            city: String(opts["fromCity"]),
            stateProvince: String(opts["fromState"]),
            postalCode: String(opts["from"]),
            countryCode: String(opts["fromCountry"]),
          },
          destination: {
            name: String(opts["toName"]),
            addressLine1: String(opts["toAddress"]),
            city: String(opts["toCity"]),
            stateProvince: String(opts["toState"]),
            postalCode: String(opts["to"]),
            countryCode: String(opts["toCountry"]),
          },
          package: {
            weight: parsePositiveNumber("weight-oz", opts["weightOz"] as string),
            weightUnit: "oz",
            length: parsePositiveNumber("length-in", opts["lengthIn"] as string),
            width: parsePositiveNumber("width-in", opts["widthIn"] as string),
            height: parsePositiveNumber("height-in", opts["heightIn"] as string),
          },
        };

        if (!cfg.json) {
          writeInfo(
            `Creating ${payload.carrierCode} ${payload.serviceCode} label ${dim(
              `${payload.origin.postalCode} -> ${payload.destination.postalCode}, ${payload.package.weight}${payload.package.weightUnit}`
            )}`
          );
        }

        const response = await gatewayFetch<LabelResponse>(cfg.gatewayUrl, "/api/v1/shipping/labels", {
          method: "POST",
          apiKey,
          body: payload,
        });

        if (cfg.json) {
          writeJson(response);
          return;
        }

        writeSuccess("Label created.");
        writeStdout("");
        if (response.trackingNumber) writeStdout(`  Tracking number: ${bold(response.trackingNumber)}`);
        if (response.carrierCode || response.serviceCode) {
          writeStdout(`  Carrier / service: ${dim(`${response.carrierCode ?? "?"} ${response.serviceCode ?? ""}`.trim())}`);
        }
        if (typeof response.rate === "number") {
          writeStdout(`  Rate: ${dim(`${response.rate.toFixed(2)} ${response.currency ?? "USD"}`)}`);
        }
        if (response.labelUrl) writeStdout(`  Label URL: ${response.labelUrl}`);
        if (response.labelData) writeStdout(`  Label data: ${dim("(base64 PDF, omit with --json for the raw bytes)")}`);
        if (response.trackingNumber) {
          writeStdout("");
          writeInfo(`Track it: ${dim(`flexops track ${response.trackingNumber}`)}`);
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          writeError(`Gateway rejected label request (HTTP ${err.status}): ${err.message}`);
          if (cfg.json) writeJson({ error: { status: err.status, body: err.body } });
        } else {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}
