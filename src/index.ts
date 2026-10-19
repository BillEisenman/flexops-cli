#!/usr/bin/env node
/**
 * @flexops/cli — command-line companion for the FlexOps Gateway API.
 *
 * Shipping commands support sandbox keys; inventory writes require a live key
 * and a persisted preview/approval workflow.
 */
import { buildProgram } from "./program.js";

const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`flexops: ${message}\n`);
  process.exit(1);
});
