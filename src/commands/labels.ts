import { prepareLabel, approveLabel, cancelLabelPreview } from "./label-purchase.js";
import { Command } from "commander";
import { resolveConfig } from "../lib/config.js";
import { GatewayError, describeError, describeStatus } from "../lib/http.js";
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

/** Gateway HazmatClassification numbers, by --hazmat name. */
const HAZMAT_CLASSES: Record<string, number> = {
  "none": 0,
  "limited-quantity": 1,
  "lithium-battery-contained-in-equipment": 2,
  "lithium-battery-packed-with-equipment": 3,
  "lithium-battery-standalone": 4,
  "other-restricted": 5,
  "lithium-battery-used-device": 6,
};

/**
 * HAZMAT classes USPS carries on Ground Advantage only: limited-quantity, lithium-battery-standalone,
 * other-restricted and lithium-battery-used-device. Mirrors the Gateway's
 * HazmatEligibility.GetEligibleMailClasses, which refuses any other service for them (400 VALIDATION_FAILED).
 */
const USPS_GROUND_ONLY_HAZMAT = new Set([1, 4, 5, 6]);

/**
 * The service to send. PRIORITY is only the demo default, and a ground-only USPS class can't ship on
 * it, so when --service wasn't given such a class gets the one service it allows. An explicit
 * --service is always sent as given.
 */
export function resolveServiceCode(service: string, serviceGiven: boolean, carrier: string, hazmatClassification?: number): string {
  if (serviceGiven || carrier.trim().toUpperCase() !== "USPS" || hazmatClassification === undefined) return service;
  return USPS_GROUND_ONLY_HAZMAT.has(hazmatClassification) ? "GROUND_ADVANTAGE" : service;
}

/** Maps a --hazmat value (a class name or its number) to the Gateway HazmatClassification number. */
export function parseHazmatClassification(raw: string): number {
  const name = raw.trim().toLowerCase();
  const value = /^\d$/.test(name) ? Number(name)
    : Object.prototype.hasOwnProperty.call(HAZMAT_CLASSES, name) ? HAZMAT_CLASSES[name] : undefined;
  if (value === undefined || value > 6)
    throw new Error(`--hazmat must be none or one of ${Object.keys(HAZMAT_CLASSES).slice(1).join(", ")} (got "${raw}")`);
  return value;
}

function parseOrderId(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--order must be a positive whole number (got "${raw}")`);
  return n;
}

export function registerLabelsCommand(program: Command): void {
  const labels = program.command("labels").description("Create and inspect shipping labels.");

  labels
    .command("create")
    .description(
      "Preview live postage or create a sandbox label. Defaults match the homepage demo " +
        "(USPS Priority, 78701 -> 97201); live previews require --maximum-postage."
    )
    .option("--key <key>", "API key (defaults to FLEXOPS_API_KEY)")
    .option("--carrier <code>", "Carrier code (USPS, UPS, FEDEX, DHL)", "USPS")
    .option("--service <code>", "Service code (PRIORITY, GROUND_ADVANTAGE, etc.); a USPS --hazmat class that ships " +
      "ground only (limited-quantity, lithium-battery-standalone, other-restricted, lithium-battery-used-device) " +
      "defaults to GROUND_ADVANTAGE", "PRIORITY")
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
    .option("--maximum-postage <usd>", "Maximum authorized postage in USD; required for live preview")
    .option("--weight-oz <ounces>", "Package weight in ounces", "8")
    .option("--length-in <inches>", "Package length in inches", "10")
    .option("--width-in <inches>", "Package width in inches", "6")
    .option("--height-in <inches>", "Package height in inches", "4")
    .option("--order <id>", "Order the label is bought against")
    .option("--hazmat <none|class>", "What the parcel holds: none, or its HAZMAT class (" +
      Object.keys(HAZMAT_CLASSES).slice(1).join(", ") + "); required without --order")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const cfg = resolveConfig(cmd, opts);
      try {
        // A label without an order must say what it holds; the CLI never assumes "none".
        const orderId = opts["order"] === undefined ? undefined : parseOrderId(String(opts["order"]));
        const hazmatClassification = opts["hazmat"] === undefined ? undefined : parseHazmatClassification(String(opts["hazmat"]));
        if (orderId === undefined && hazmatClassification === undefined)
          throw new Error("--hazmat is required without --order: use --hazmat none for a parcel with no dangerous goods, or its class.");
        const serviceGiven = cmd.getOptionValueSource("service") !== "default";
        const serviceCode = resolveServiceCode(String(opts["service"]), serviceGiven, String(opts["carrier"]), hazmatClassification);
        if (serviceCode !== String(opts["service"]) && !cfg.json)
          writeInfo(`--hazmat ${String(opts["hazmat"])} ships on USPS Ground Advantage only: using GROUND_ADVANTAGE, not the PRIORITY default. Pass --service to choose.`);
        const payload = {
          ...(orderId === undefined ? {} : { orderId }),
          ...(hazmatClassification === undefined ? {} : { hazmatClassification }),
          carrierCode: String(opts["carrier"]),
          serviceCode,
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
            `Preparing ${payload.carrierCode} ${payload.serviceCode} label ${dim(
              `${payload.origin.postalCode} -> ${payload.destination.postalCode}, ${payload.package.weight}${payload.package.weightUnit}`
            )}`
          );
        }

        const response = await prepareLabel(cfg, payload, opts["maximumPostage"] === undefined ? undefined : parsePositiveNumber("maximum-postage", opts["maximumPostage"] as string));
        if ("operation" in response) {
          writeJson(response);
          if (!cfg.json) writeInfo(`Review the quote, then run: flexops labels approve ${response.operation} --approve. Carrier adjustments and separate fees are outside the maximum.`);
          return;
        }
        const label = response as LabelResponse;

        if (cfg.json) {
          writeJson(response);
          return;
        }

        writeSuccess("Label created.");
        writeStdout("");
        if (label.trackingNumber) writeStdout(`  Tracking number: ${bold(label.trackingNumber)}`);
        if (label.carrierCode || label.serviceCode) {
          writeStdout(`  Carrier / service: ${dim(`${label.carrierCode ?? "?"} ${label.serviceCode ?? ""}`.trim())}`);
        }
        if (typeof label.rate === "number") {
          writeStdout(`  Rate: ${dim(`${label.rate.toFixed(2)} ${label.currency ?? "USD"}`)}`);
        }
        if (label.labelUrl) writeStdout(`  Label URL: ${label.labelUrl}`);
        if (label.labelData) writeStdout(`  Label data: ${dim("(base64 PDF, omit with --json for the raw bytes)")}`);
        if (label.trackingNumber) {
          writeStdout("");
          writeInfo(`Track it: ${dim(`flexops track ${label.trackingNumber}`)}`);
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          writeError(`Gateway rejected label request (${describeStatus(err, cfg.json)}): ${err.message}`);
          if (cfg.json) writeJson({ error: { status: err.status, body: err.body } });
        } else {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
  labels.command("approve <operation>").description("Review or explicitly approve a saved label purchase; retries reuse its exact request and key.")
    .option("--key <key>", "Original API key")
    .option("--approve", "Approve the displayed saved quote and maximum")
    .action(async (id: string, opts: Record<string, unknown>, cmd: Command) => {
      const cfg = resolveConfig(cmd, opts);
      try { writeJson(await approveLabel(cfg, id, Boolean(opts["approve"]))); }
      catch (err) { writeError(`${describeError(err, cfg.json)} Retain operation ${id}; retry only this operation or reconcile with an operator.`); process.exitCode = 1; }
    });
  labels.command("cancel-preview <operation>").description("Cancel a preview that has never been approved.")
    .action((id: string) => {
      try { writeJson(cancelLabelPreview(id)); }
      catch (err) { writeError(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
    });

}
