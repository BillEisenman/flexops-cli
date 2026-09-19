# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@flexops/cli` is the terminal companion for the FlexOps Gateway API. It lets developers issue sandbox API keys, create shipping labels, and track shipments without leaving the terminal. Published to npm as `@flexops/cli`; use `package.json` for the current source version and `README.md` for release compatibility.

**Scope:** sandbox keys, guarded label preview/approval and tracking, persisted inventory operations, and the private inventory MCP adapter. Preserve saved operation IDs, approval and idempotency keys on retries; see `README.md`.

## Build & Run Commands

Use the scripts in `package.json`: `npm run typecheck`, `npm test` (builds first), and `npm run build`. Run the CLI locally after build: `node dist/index.js <command>`. Once published: `flexops <command>` or `npx @flexops/cli <command>`.

## Architecture

```text
@flexops/cli (this repo)  →  Gateway BFF (gateway.flexops.io)
                              ↓
                              VisionSuiteCoreServices (carrier execution)
                              FlexOps.Integrations.Api (store connectors)
```

The CLI is a thin command surface over the Gateway HTTP API. It does **not** talk to VSCS or Integrations directly — Gateway is the single ingress (see the FlexOpsPlatform CLAUDE.md for the perimeter model).

## Conventions

- **kleur** for terminal color (no chalk — kleur has zero deps)

## Publish

`prepublishOnly` is the gate: typecheck → test → build must pass before `npm publish`. `.github/workflows/ci.yml` builds, typechecks and tests pull requests on Node 24. `.github/workflows/publish.yml` publishes through npm trusted publishing on version tags or manual dispatch. A maintenance merge does not authorize a release.

## Related Repositories

| Repository | Purpose |
|---|---|
| **This repo** | `@flexops/cli` on npm — `BillEisenman/flexops-cli` |
| FlexOps Gateway | The HTTP API the CLI calls — `BillEisenman/FlexOpsGateway` |
| FlexOps Developer Docs | Hosts the CLI page at `docs.flexops.io/sdks/cli` — `BillEisenman/FlexOpsDeveloperDocs` |
| FlexOps Website | Homepage `InstantDemo` flow that this CLI mirrors — `BillEisenman/FlexOpsWebSite` |
