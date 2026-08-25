# mpp.ninja

`mpp.ninja` is a global, security-aware observatory for public Machine Payments Protocol (MPP) services. It indexes advertised payment surfaces, makes narrowly bounded unauthenticated observations, preserves history, and reports what the evidence does—and does not—establish.

Live app: <https://mpp.ninja>

Workers.dev fallback: <https://mpp-ninja.bcrt43.workers.dev>

The observatory does not make payments, create or sign credentials, replay authorizations, fuzz endpoints, exploit suspected bugs, or intentionally change remote state. See [the methodology](docs/METHODOLOGY.md) for the complete boundary.

## Architecture

One TypeScript Cloudflare Worker serves the HTML UI and read-only JSON API, accepts safe service submissions, runs scheduled discovery, and consumes crawl jobs. It uses:

- D1 (`mpp-observatory`) for normalized services, endpoints, payment offers, source provenance, authoritative source snapshots, observations, security properties, changes, submissions, crawl state, and discovery runs.
- R2 (`mpp-observations`) for bounded, redacted observation documents; the production bucket is provisioned and its enabled `observations-30d` lifecycle expires `observations/` objects after 30 days. D1 retains the object key, SHA-256 body digest, and queryable summary, then clears expired object pointers.
- Queues (`mpp-crawl`, with `mpp-crawl-dlq`) for deduplicated, delayed, retryable crawl work.
- Cron (`17 */6 * * *`) for catalog refreshes and recrawling due targets.
- A Worker Custom Domain for `mpp.ninja`; the existing `workers.dev` fallback remains enabled and preview URLs remain disabled.

Durable Objects are not used: D1 transactions and conditional writes are sufficient for the current index, dedupe, and per-origin leases. See [the architecture](docs/ARCHITECTURE.md) for data flow and trust boundaries.

## Discovery sources

- `https://mpp.dev/api/services`: the public MPP catalog. The catalog's `serviceUrl` path is the canonical advertised service base (with any query removed); its general `url`/homepage field is not substituted for it.
- `https://mppscan.com/`: an anonymous HTML fallback for the MPPScan/Merit view. There is no documented feed dependency; the importer accepts only the exact bounded `originUrls` array embedded in public page hydration data.
- Advertised OpenAPI 3.x documents and RFC 9727 API catalogs: operation-level `x-payment-info` metadata is normalized while remaining labeled as advertised configuration.
- Manual submissions: public HTTP(S) URLs are cheaply validated, normalized, deduplicated, public-address checked, and admitted through privacy-preserving rate and retained-candidate budgets. An unconfirmed candidate gets only a fixed first pass; a valid runtime `402` or currently active trusted target provenance is required before descendants or recurring work are scheduled.
- Runtime observations: legitimate public `402 Payment Required` challenges are parsed as time-specific evidence, not treated as a catalog declaration or proof of backend behavior.

Discovery-document support is intentionally draft-tolerant and evidence-scoped. Complete source snapshots publish current service, endpoint, offer, and target membership atomically; incomplete, terminally failed, stale, or implausibly shrunken runs retain last-known authority. MPPScan membership is reconciled only after every normalized origin from a valid non-empty page has been scheduled. Current trust comes from active crawl-target provenance, not a historical source row. A source listing does not prove that a service is currently reachable, correctly configured, safe, or vulnerable.

## Product surface

The Worker provides a dashboard, searchable services index, service detail records, endpoint and payment configuration, implementation concentration, methodology, recent changes, and a safe submission form. The read-only API includes:

- `GET /api/services`
- `GET /api/services/:id`
- `GET /api/endpoints`
- `GET /api/implementations`
- `GET /api/changes`
- `GET /api/stats`

List endpoints use bounded pagination and filters. Security properties use only `observed`, `inferred`, `tested-pass`, `tested-fail`, `unknown`, and `not-tested`; an absent or untested result never means secure.

## Development

Use Node 24 from `.nvmrc`.

```bash
npm install
npm run check
npm run dev
```

`npm run check` is the comprehensive local gate: generated binding types, TypeScript, deterministic Worker/D1 tests, and a Wrangler dry run.

After changing bindings, regenerate types:

```bash
npm run types
```

Apply migrations locally or remotely with Wrangler before running against an empty database:

```bash
npx wrangler d1 migrations apply mpp-observatory --local
npx wrangler d1 migrations apply mpp-observatory --remote
```

When provisioning a new Cloudflare environment, authenticate Wrangler with the intended account, create the storage resources, apply the lifecycle, and then deploy:

```bash
npx wrangler r2 bucket create mpp-observations
npx wrangler r2 bucket lifecycle add mpp-observations observations-30d observations/ --expire-days 30 --force
npm run deploy
```

For a newly migrated empty environment, start the fixed-source seed once through the lease-protected bootstrap URL, then poll the stats API and remote discovery runs rather than assuming the asynchronous Queue has finished:

```bash
curl -fsS 'https://mpp.ninja/?bootstrap=1' -o /tmp/mpp-bootstrap.html
curl -fsS 'https://mpp.ninja/api/stats'
```

Cloudflare deployment success, D1 migration success, queue activity, and live `https://mpp.ninja` behavior are separate acceptance checks. Do not infer one from another.

## Operating constraints

- Crawl only public HTTP(S) targets on ports 80 or 443 with no embedded credentials. Every scheduled or redirected target must use the exact normalized service hostname; cross-host advertised metadata may remain visible as an advertisement but is never fetched.
- Keep the `global_fetch_strictly_public` compatibility flag enabled.
- Never add an MPP client path that can auto-pay during discovery.
- Preserve manual redirect handling, the exact-hostname boundary, per-origin leases and public-address validation at every hop, the response/time/redirect limits, advertised-query removal, and sensitive-header/structured-value redaction. Response bodies are hashed but not retained.
- Preserve the discovery-tree budgets: 160 catalog/OpenAPI endpoints, 512 OpenAPI offers, 16 RFC 9727 links, and 192 active/256 retained crawl targets per service. Manual admissions use five-minute limits of 6 per client and 120 globally, count every unconfirmed status toward the 8-per-origin and 500-global caps, expire unconfirmed authority after 24 hours, and retain no raw client address.
- Preserve retention policy: expire R2 observation objects after 30 days, compact superseded repeat observations and terminal manual-only candidates after 30 days, and prune obsolete coordination runs after 14 days without deleting current authority or the published-service change timeline.
- Treat Queues as at-least-once delivery; every ingest and crawl write must remain idempotent.
- Cite public advisories as prior art only. Fingerprints do not establish an exact deployed version or advisory applicability.

Repository behavior and acceptance evidence are tracked in [FEATURES.md](FEATURES.md). Agent operating rules are in [AGENTS.md](AGENTS.md).
