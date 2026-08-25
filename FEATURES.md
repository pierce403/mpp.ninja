# Features

This file is the living product specification and acceptance tracker for `mpp.ninja`.

## Observatory foundation

**Stability:** stable

### Properties

- Discovers public MPP services from `mpp.dev`, the anonymous MPPScan/Merit page, advertised OpenAPI/RFC 9727 metadata, runtime `402` challenges, and manual submissions.
- Normalizes services, endpoints, provenance, payment offers, implementation evidence, named security properties, observations, and historical changes in D1.
- Runs on one Cloudflare Worker with D1, R2, Queues, a dead-letter Queue, Cron, observability, version metadata, and the existing apex Custom Domain.
- Keeps security-sensitive configuration and credentials out of source control.
- Makes observed data provenance, collection boundaries, and security assumptions inspectable.
- Serves the dashboard, service index/detail views, endpoint/payment data, implementation concentration, methodology, changes, submissions, and the required read-only JSON API.
- Makes only bounded unauthenticated `GET`/`HEAD` observations. It has no signer, wallet, payment, credential, replay, fuzzing, exploitation, or state-changing scan path.
- Publishes normalized source revisions and their crawl authority atomically, confines every network target to its normalized service hostname, and applies bounded 30-day observation/manual retention plus 14-day coordination cleanup.

### Dependencies

- D1 `mpp-observatory`
- R2 `mpp-observations`
- Queue `mpp-crawl` and dead-letter Queue `mpp-crawl-dlq`
- Six-hour Cron discovery/recrawl trigger
- Cloudflare Worker `mpp-ninja` and `mpp.ninja` Custom Domain

### Test criteria

- [x] The supported observation workflows and non-goals are documented.
- [x] The threat model and data-handling boundaries are documented.
- [x] Automated tests cover discovery, parsing, normalization, history, API behavior, queue ordering/failure, redaction, SSRF boundaries, limits, and migrations.
- [x] A deployment is tied to a known commit and verified through live behavior.
- [x] No credentials or environment-specific secrets are committed.
- [x] Production D1 migration, R2 write, Queue consumption, first harmless crawl, indexed UI/API, Custom Domain, and exact Worker version are verified independently.

### Evidence

- Repository setup started on 2026-08-25.
- On 2026-08-25, `npm run check` passed under Node 24 with current generated bindings, TypeScript, 236 deterministic tests across 26 files, and a Wrangler dry-run (274.86 KiB upload / 59.85 KiB gzip).
- The live mpp.dev catalog shape was verified at 141 services and 1,449 raw endpoints. Query-free canonical dedupe produces 1,444 endpoint-ingest messages (15 bounded Queue batches, 1,798,238 expanded bytes); its 178 explicit `payment: null` endpoint values are treated as absent advertised offers.
- Anonymous MPPScan/Merit page preflight extracted 433 unique public origins from the exact embedded `originUrls` hydration array without cookies, credentials, or its signed payment API.
- On 2026-08-25, `npm audit --omit=dev` reported 0 production vulnerabilities.
- D1 `mpp-observatory`, R2 `mpp-observations`, and both Queues are provisioned. Migration `0001_observatory.sql` was applied successfully to remote D1 from commit `d4c0392c47b4b6462853650feb63a374797fa3e4`; the empty schema was then seeded through the lease-protected bootstrap workflow. The enabled `observations-30d` lifecycle expires `observations/` objects after 30 days.
- Observatory commit `d5569bf90f66ceed1324fae8b0249efe9c3fd55a` was deployed as Worker version `f2ac74be-2aa7-4411-b538-64a40b4a25d2`. The Custom Domain and `workers.dev` fallback returned the same exact version; Queue consumption produced normalized services/endpoints/offers and D1 observations; an R2-linked observation was read back explicitly; and the populated API, desktop UI, and true 390 CSS-pixel mobile UI were verified live. The initial asynchronous source barriers were still advancing when this release evidence was first recorded.
- Hardening commit `e947ace18165f8378008f234beda1d28ebc74c7f` was deployed as Worker version `2cfb8a5b-21d6-4e38-ba94-4e72ea216e0f`. Migration `0002_redact_provider_identifiers.sql` removed the legacy D1 values, both affected private R2 objects were rewritten and read back, and live JSON/HTML checks found no remaining provider identifier while endpoint collection rows exposed their active provenance.
- At `2026-08-25T19:26:17Z`, the moving production index contained 419 published services, 2,264 active endpoints, 3,898 active offers, 1,202 D1 observations with 1,202 R2 object links, 12,470 changes, and 17 runtime-observed MPP services. The Queue had completed 1,202 targets; mpp.dev and MPPScan source barriers were safely processing at 57/141 and 400/433 services, with zero failed discovery runs, snapshots, or targets. Counts continue changing as bounded jittered work drains and the six-hour schedule runs.
- Conservative fingerprints at that snapshot were 392 unknown, 19 custom at 0.35 confidence, and 8 mppx at 0.85 confidence. Security-property state was 7,304 not-tested, 1,681 unknown, 3,980 tested-pass, 445 tested-fail, and 1 observed; each pass/fail applies only to its named harmless check and does not establish general security or vulnerability.

## Initial Hello World deployment (superseded)

**Stability:** stable

This historical baseline was replaced by the observatory deployment above.

### Properties

- Served an HTML status page from a TypeScript Cloudflare Worker.
- Stated clearly that MPP functionality was not enabled in that initial release.
- Established `GET`/`HEAD`, error, method, security-header, and observability baselines retained by the current application.

### Dependencies

- Cloudflare Workers
- Wrangler

### Test criteria

- [x] TypeScript and Worker-runtime tests pass.
- [x] Wrangler configuration and generated types are current.
- [x] A dry-run deployment succeeds.
- [x] The deployed Worker returns the expected page, status codes, and security headers.
- [x] The deployed version is tied to a known Git commit.

### Evidence

- Initial Worker scaffold added on 2026-08-25.
- `npm run check` passed on 2026-08-25, including generated-type verification, TypeScript, three Worker-runtime tests, and a Wrangler dry run.
- Git commit `eba6fedf072aaa1bcb25b220224a1bb0efd13883` was pushed to GitHub and deployed as Cloudflare Worker version `4885040a-9061-4bba-ae75-1d0080546439`.
- Live verification at `https://mpp-ninja.bcrt43.workers.dev/` returned the expected page and security headers; `HEAD /` returned `200`, `GET /mpp` returned `404`, and `POST /` returned `405` with `Allow: GET, HEAD`.

## Apex custom domain

**Stability:** stable

### Properties

- Serves the production Worker at `https://mpp.ninja`.
- Uses a Cloudflare Workers Custom Domain managed through `wrangler.jsonc`.
- Keeps the generated Cloudflare DNS record and certificate under Cloudflare management.

### Dependencies

- Active `mpp.ninja` zone in the deployment account
- Cloudflare Workers Custom Domains
- Valid HTTPS certificate for `mpp.ninja`

### Test criteria

- [x] `mpp.ninja` resolves through Cloudflare DNS.
- [x] HTTPS certificate validation succeeds for `mpp.ninja`.
- [x] `GET https://mpp.ninja/` returns the indexed observatory dashboard and security headers.
- [x] Custom-domain UI/API, error, and method behavior matches the verified `workers.dev` deployment.
- [x] The deployed custom-domain configuration is tied to a known Git commit.

### Evidence

- Before configuration on 2026-08-25, `mpp.ninja` returned NXDOMAIN.
- Cloudflare created the apex DNS records and issued a Google Trust Services certificate covering `mpp.ninja` and `*.mpp.ninja`.
- Git commit `97cad32c21d1f8d9b058eba36b6751a4740ff589` deployed as Worker version `d4e09698-0b36-45ad-a3dc-9ade4e2993a1` with the apex custom domain and `workers.dev` fallback enabled; preview URLs are explicitly disabled.
- Live verification on 2026-08-25 returned `200` with the expected page and security headers at `https://mpp.ninja/`; `HEAD /` returned `200`, `GET /mpp` returned `404`, and `POST /` returned `405` with `Allow: GET, HEAD`.
- The fallback `https://mpp-ninja.bcrt43.workers.dev/` continued to return `200` after custom-domain deployment.
