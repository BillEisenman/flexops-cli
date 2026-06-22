// Single source of truth for the CLI version: package.json's `version`,
// inlined by tsup/esbuild at build time. `npm version <x>` updates
// package.json, so this stays in sync automatically — no manual bump.
import { version } from "../package.json";

export const CLI_VERSION: string = version;
