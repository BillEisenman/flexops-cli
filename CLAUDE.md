# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@flexops/cli` is the terminal companion for the FlexOps Gateway API. It lets developers issue sandbox API keys, create shipping labels, and track shipments without leaving the terminal. Published to npm as `@flexops/cli`; current version `0.1.0` (MVP, scaffolded 2026-05-26).

**Scope today (MVP):** sandbox key issuance, label create, label tracking. Mirrors the homepage `InstantDemo` flow so `npx @flexops/cli` works as a zero-install try-it-out.

## Build & Run Commands

```powershell
npm install                     # Install dependencies
npm run dev                     # Watch-rebuild via tsup
npm run build                   # One-shot bundle to dist/ (ESM, target node18)
npm run typecheck               # tsc --noEmit
npm run test                    # vitest run
npm run test:watch              # vitest watch
npm run prepublishOnly          # typecheck + test + build (gates the npm publish)
```

Run the CLI locally after build: `node dist/index.js <command>`. Once published: `flexops <command>` or `npx @flexops/cli <command>`.

## Architecture

```text
@flexops/cli (this repo)  →  Gateway BFF (gateway.flexops.io)
                              ↓
                              VisionSuiteCoreServices (carrier execution)
                              FlexOps.Integrations.Api (store connectors)
```

The CLI is a thin command surface over the Gateway HTTP API. It does **not** talk to VSCS or Integrations directly — Gateway is the single ingress (see the FlexOpsPlatform CLAUDE.md for the perimeter model).

## Key Directories

| Path | Purpose |
|---|---|
| `src/index.ts` | CLI entrypoint (registers commands via `commander`) |
| `src/commands/` | One file per command — sandbox, labels create, labels track |
| `src/lib/` | Shared helpers (HTTP client, output formatting via `kleur`) |
| `src/version.ts` | Single source of truth for the printed `--version` |
| `tests/` | Vitest unit specs |

## Stack

- **Node ≥ 18** (`"engines": { "node": ">=18" }`)
- **TypeScript** with strict config; ESM-only output
- **commander 12** for command parsing
- **kleur** for terminal color (no chalk — kleur has zero deps)
- **tsup** for bundling
- **vitest** for tests

## Publish

`prepublishOnly` is the gate: typecheck → test → build must pass before `npm publish`. The repo is small; there's no separate CI publish workflow today — bump version, run `prepublishOnly`, then `npm publish` (or use `npm publish --dry-run` first).

## Related Repositories

| Repository | Purpose |
|---|---|
| **This repo** | `@flexops/cli` on npm — `BillEisenman/flexops-cli` |
| FlexOps Gateway | The HTTP API the CLI calls — `BillEisenman/FlexOpsGateway` |
| FlexOps Developer Docs | Hosts the CLI page at `docs.flexops.io/sdks/cli` — `BillEisenman/FlexOpsDeveloperDocs` |
| FlexOps Website | Homepage `InstantDemo` flow that this CLI mirrors — `BillEisenman/FlexOpsWebSite` |
