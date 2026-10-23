# Changelog

## [Unreleased]

### Fixed

- Without `--json`, a Gateway refusal now names its error code after the HTTP status, for example `Gateway rejected label request (HTTP 400 HazmatDeclarationRequired): <message>`. Every command gets it: `labels create`, `labels approve`, `track`, `sandbox`, and the inventory commands. `--json` output is unchanged.
- `labels create` with a USPS `--hazmat` class that ships on Ground Advantage only (`limited-quantity`, `lithium-battery-standalone`, `other-restricted`, `lithium-battery-used-device`) and no `--service` sends `GROUND_ADVANTAGE` instead of the `PRIORITY` default, which the Gateway refuses for those classes (400 `VALIDATION_FAILED`). It prints a line saying so. An explicit `--service` is always sent as given.

## 0.5.0 (2026-10-19)

Aligns the CLI with the documented public Gateway API ahead of the Gateway's order-less HAZMAT Enforce rule.

### Breaking

- `labels create` requires `--hazmat <none|class>` when there is no `--order`, and sends it as the Gateway `hazmatClassification` number (`none` = 0). The Gateway refuses order-less labels without a declaration (`HazmatDeclarationRequired`). (#34)

No commands were removed: every command already calls a documented Gateway operation, and none writes through `/api/ApiProxy`.

### Fixed

- `sandbox` reads the issued key from `secretKey`, the field the Gateway returns. (#36)
- An empty success response (204, or Content-Length 0) returns no result instead of `null`. `labels create` and `labels approve` treat it as no preview or an unresolved purchase, and `track` as no status, instead of failing with a TypeError.

### Changed

- Every POST, PUT and PATCH sends an `Idempotency-Key`: the caller's saved operation ID (label purchases, inventory adjustments), otherwise a fresh UUID per request. The CLI still never retries a request on its own.

### Added

- Gateway contract test: every command runs against a recording local Gateway, and each call must match an operation in the Developer Docs OpenAPI snapshot (`tests/fixtures/gateway-operations.json`), with no POST, PUT, PATCH or DELETE through `/api/ApiProxy`. A command added without a contract scenario fails the test.
