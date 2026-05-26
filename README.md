# @flexops/cli

Command-line companion for the [FlexOps Gateway API](https://gateway.flexops.io). Issue a sandbox key, create a label, and track it — without leaving the terminal.

```bash
# 1. Get a free sandbox key (no signup, ~1 hour TTL, mock carriers)
npx @flexops/cli sandbox

# 2. Use the key to ship a sandbox label
npx @flexops/cli labels create --key test_… --from 78701 --to 97201 --weight-oz 8

# 3. Track it
npx @flexops/cli track 9400000000000000000000 --key test_…
```

The default flag values match the homepage demo (USPS Priority, Austin TX → Portland OR, 8 oz) so a no-flag invocation succeeds end-to-end against a fresh sandbox key.

## Install

```bash
npm i -g @flexops/cli
# or invoke ad-hoc:
npx @flexops/cli <command>
```

Requires Node 18 or newer.

## Authentication

The CLI talks to the Gateway with `X-API-Key` (not `Authorization: Bearer` — the Gateway rejects bearer-wrapped API keys with 401).

Three ways to supply a key, evaluated in this order:

1. `--key <key>` on the command line.
2. `FLEXOPS_API_KEY` environment variable.
3. (`sandbox` command only) no key required — it issues one.

```bash
# session-scoped:
export FLEXOPS_API_KEY=test_yourkey
flexops labels create --from 78701 --to 97201 --weight-oz 8
```

Keys must start with `test_` (sandbox, mock carriers) or `live_` (production, real money). Other prefixes are rejected loudly before the request goes out, which catches the classic "pasted a JWT instead of an API key" mistake.

## Commands

### `flexops sandbox`

POSTs to `/api/Sandbox/demo-keys` (no auth) and prints a freshly minted `test_` key plus its expiry. The endpoint is anonymous-IP-rate-limited; bursts get 429.

### `flexops labels create`

Creates a shipment label via `POST /api/v1/shipping/labels`. Flags map to the `LabelRequest` DTO the Gateway expects:

| Flag | Maps to | Default |
|---|---|---|
| `--carrier` | `carrierCode` | `USPS` |
| `--service` | `serviceCode` | `PRIORITY` |
| `--from`, `--from-name`, `--from-address`, `--from-city`, `--from-state`, `--from-country` | `origin.*` | Austin TX 78701 |
| `--to`, `--to-name`, `--to-address`, `--to-city`, `--to-state`, `--to-country` | `destination.*` | Portland OR 97201 |
| `--weight-oz`, `--length-in`, `--width-in`, `--height-in` | `package.*` (units: oz / in) | 8 oz, 10×6×4 in |

### `flexops track <trackingNumber>`

GETs `/api/v1/shipping/track/{trackingNumber}` and prints the latest status, location, carrier, ETA, plus the five most recent events.

## Global flags

- `--gateway-url <url>` — point the CLI at a non-production Gateway (e.g. local dev). Also reads `FLEXOPS_GATEWAY_URL`.
- `--json` — emit the raw Gateway response as JSON for piping into `jq`, CI scripts, or another tool. All commands respect this flag.
- `-v, --version` / `--help` — standard.

## Examples

**Ship-it-now smoke test from a fresh terminal:**

```bash
KEY=$(npx @flexops/cli sandbox --json | jq -r .apiKey)
npx @flexops/cli labels create --key $KEY --json | jq -r .trackingNumber
```

**Use against a local Aspire dev gateway:**

```bash
FLEXOPS_GATEWAY_URL=https://localhost:7012 \
FLEXOPS_API_KEY=test_yourkey \
flexops labels create
```

**Production cutover** — same commands, swap the key prefix:

```bash
export FLEXOPS_API_KEY=live_…
flexops labels create --carrier USPS --service PRIORITY \
  --from 78701 --to 97201 --weight-oz 12
```

## License

MIT © FlexOps, LLC
