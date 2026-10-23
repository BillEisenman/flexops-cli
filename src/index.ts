#!/usr/bin/env node
/**
 * @flexops/cli — command-line companion for the FlexOps Gateway API.
 *
 * Shipping commands support sandbox keys; inventory writes require a live key
 * and a persisted preview/approval workflow.
 */
import { buildProgram } from "./program.js";
import { describeError } from "./lib/http.js";

const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  // Commands that don't catch their own errors (inventory) land here; --json keeps the bare message.
  process.stderr.write(`flexops: ${describeError(err, Boolean(program.opts()["json"]))}\n`);
  process.exit(1);
});
