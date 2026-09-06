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

1. `--key <key>` on shipping commands.
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

### Inventory workflow for Codex (v0.2.0)

Install `@flexops/cli@0.2.0` and use `flexops inventory`, or build this checkout with `npm run build` and run `node dist/index.js` as below. Set `FLEXOPS_API_KEY` securely in the process environment to an entitled `live_` key with `inventory:write`, the Inventory module and `inventory.basic-adjustments`; sandbox keys cannot perform these writes. Use synthetic records in a controlled environment for certification.

```powershell
# Inspect the returned operation UUID, quantities, policy and expiry.
node dist/index.js inventory preview --sku CERT-SKU --warehouse 7 --quantity 2 --reason "Synthetic certification"
# After the user explicitly approves that exact displayed preview:
node dist/index.js inventory commit <operation-uuid> --approve
# After a lost response or process restart, retry the same operation:
node dist/index.js inventory commit <operation-uuid>
# If the user declines before approval:
node dist/index.js inventory cancel <operation-uuid>
```

Replace `<operation-uuid>` with the returned UUID. Inventory output is always JSON. Each preview creates a unique operation ID used as its `Idempotency-Key`; its exact signed commit request and approval are persisted before dispatch. A commit without approval only shows the saved preview. Completed operations return the saved result without another write. The original Gateway and API key must be retained for retries.

Codex must show the preview and wait for explicit user approval before supplying `--approve`. This flag records the caller's approval assertion; it does not independently authenticate a human or prove that a model obtained consent. After `OutcomeUnknown` or another classified non-success, stop for operator investigation. Only after checking authoritative action and inventory records, use `inventory commit <operation-uuid> --reconcile` to replay the original request. This does not repair server records. After a definitive precondition rejection, create a new preview and obtain new approval. Never replace an unresolved operation with a new key.

The private operation directory defaults to `~/.flexops/operations` (`FLEXOPS_OPERATION_DIR` overrides it). Records contain signed confirmation tokens and audit reasons, but no API key. Do not edit, delete, commit or share them; keep them across restarts. Unix creation modes are restricted; Windows uses inherited ACLs, so use a private user directory or provision equivalent ACLs for an override. Local records are a trusted boundary, not tamper-proof audit storage. The unresolved-operation scan covers this directory and the original credential identity; the server owns cross-client concurrency and durable reconciliation.

Codex's native MCP HTTP header configuration is connection-level; its header helper is cached per connection ([official configuration reference](https://developers.openai.com/codex/config-reference/)). Use this CLI route for inventory adjustments instead of a static `Idempotency-Key`. If also connecting native MCP for reads, disable `adjust_inventory` there with `disabled_tools = ["adjust_inventory"]`; other fulfillment writes also require a suitable per-operation client. No native connector or global Codex configuration is changed by this CLI.

`npm test` builds the CLI and runs separate-process synthetic HTTP checks for approval, cancellation, unique operation keys, lost-response replay, changed-input rejection, stale previews and reconciliation. This proves the CLI transport lifecycle; native Codex MCP writes and autonomous human-consent handling remain uncertified.

### Private ChatGPT connector (v0.3.0)

`flexops inventory-mcp` exposes four stdio MCP tools: preview, inspect, commit and cancel. It reuses the inventory workflow above; it does not accept arbitrary Gateway requests, credentials, operation-directory paths or reconciliation instructions from tool arguments. Commit requires `approved: true` and advertises destructive, idempotent write annotations. The host must still obtain explicit approval of the displayed preview. Inspection never retries a write.

For a private ChatGPT connection, use OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [official tunnel client](https://github.com/openai/tunnel-client/releases/latest). Create a tunnel associated with the intended ChatGPT workspace. Supply its runtime key through `CONTROL_PLANE_API_KEY`, and the narrowly entitled FlexOps key through `FLEXOPS_API_KEY`; keep both out of command arguments and source files. Configure the tunnel's stdio command to run `node` with the absolute installed CLI entrypoint and `inventory-mcp`.

```powershell
tunnel-client init --sample sample_mcp_stdio_local --profile flexops-inventory --tunnel-id YOUR_TUNNEL_ID --mcp-command 'node "D:/path/to/flexops-cli/dist/index.js" inventory-mcp'
tunnel-client doctor --profile flexops-inventory --explain
tunnel-client run --profile flexops-inventory
```

Keep the host running, then create a private developer-mode MCP connection in ChatGPT, choose **Tunnel**, and select that tunnel. Do not publish this single-identity adapter to a public plugin directory or share tunnel access beyond the operator authorized to use its FlexOps key. Everyone allowed through the tunnel acts as that configured identity; per-user OAuth is not implemented here.

The local transport tests pass; actual ChatGPT discovery, confirmation UI and end-to-end writes must be verified in the target account before claiming ChatGPT certification. Start with synthetic records, decline one preview, approve another, and verify its authoritative inventory/action records. On any uncertain result, stop and reconcile from the terminal using the original operation ID.

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
