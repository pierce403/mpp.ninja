# Architecture

## Purpose and boundaries

`mpp.ninja` is a global index of public Machine Payments Protocol services. It combines advertised metadata with narrowly bounded public HTTP observations, retains provenance and history, and exposes the result through a technical HTML interface and read-only JSON API.

The crawler is not a payment client or a vulnerability scanner. It has no path for making payments, creating or signing credentials, replaying authorizations, fuzzing inputs, exploiting a suspected flaw, or intentionally changing remote state. [METHODOLOGY.md](METHODOLOGY.md) defines the enforceable scan and evidence boundary.

## System overview

```text
mpp.dev catalog ─────────────┐
MPPScan anonymous HTML ──────┼──> scheduled discovery ──> mpp-crawl Queue
advertised OpenAPI ──────────┤                                │
manual submission ──────────┘                                v
                                                       queue consumer
                                                             │
                                      URL/DNS/redirect safety policy
                                                             │
                                      harmless GET/HEAD observation
                                                             │
                                      ┌──────────────────────┴─────────┐
                                      v                                v
                               D1 normalized index              R2 redacted evidence
                                      │
                                      v
                         HTML observatory + read-only JSON API
```

One TypeScript Cloudflare Worker has three entry points:

1. The `fetch` handler renders the public UI, serves the read-only API, and validates service submissions.
2. The `scheduled` handler refreshes fixed discovery sources and enqueues records that are due for observation.
3. The `queue` handler idempotently ingests catalog records or performs one bounded public probe per message.

This keeps policy, parsers, normalization, and evidence semantics in one deployable artifact. Network work remains asynchronous so a slow or failing origin does not hold open an interactive request.

## Cloudflare resources

| Resource | Name/binding | Responsibility |
| --- | --- | --- |
| Worker | `mpp-ninja` | UI, API, submission validation, discovery coordination, queue consumption |
| D1 | `mpp-observatory` / `DB` | Normalized index, provenance, security states, changes, and crawl coordination |
| R2 | `mpp-observations` / `OBSERVATIONS` | Bounded redacted observation documents with a 30-day object lifecycle |
| Queue | `mpp-crawl` / `CRAWL_QUEUE` | Delayed catalog-ingest and crawl messages |
| Dead-letter Queue | `mpp-crawl-dlq` | Messages that exhaust bounded retry |
| Cron | `17 */6 * * *` | Six-hour discovery refresh and due-target scheduling |
| Version metadata | `VERSION` | Deployed Worker version evidence |
| Custom Domain | `mpp.ninja` | Primary production origin |

The Queue consumer uses one message per invocation, a maximum concurrency of 5, 5 retries, a 30-second retry delay, and a dead-letter queue. Catalog records carry at most one endpoint and OpenAPI operation records carry at most one offer so large public documents remain within D1's per-invocation query budget. Producer batches stay below both Cloudflare limits: 100 messages and a conservative 240,000-byte aggregate budget; a source run is also capped at 5,000 expanded messages, 10 MiB, and 50 batches before any batch is sent. Queue delivery is at least once, so database identifiers and writes are deterministic or conflict-safe; failed sends leave the target retryable rather than falsely queued, and stale `enqueueing` reservations are recovered after five minutes. Application checks and D1 triggers jointly cap each service at 192 active and 256 retained crawl targets, 160 retained OpenAPI endpoints, and 512 retained OpenAPI offers. Reactivation is subject to the same active-target limit.

Durable Objects are not used. The current coordination problem is a relational index with conditional per-origin leases, not a long-lived strongly consistent entity or WebSocket session. D1 is the smaller operational surface for that requirement. Revisit this only if measured contention shows that D1 leases are insufficient.

The production `mpp-observations` bucket is provisioned and bound to the Worker. Its enabled `observations-30d` lifecycle expires the `observations/` prefix after 30 days; that rule is part of the production data-minimization boundary and must not be removed.

## Discovery and provenance

Every service retains one or more source records with first-seen and last-seen timestamps. Discovery statements and runtime observations are separate evidence layers.

### mpp.dev catalog

The fixed source is `https://mpp.dev/api/services`. A valid record must contain an ID, name, and `serviceUrl`. The importer preserves the `serviceUrl` path as the advertised service base while removing any query; a general `url`, docs homepage, or API-reference URL is not substituted for it.

Scheduled discovery bounds the catalog response at 1 MiB, the accepted catalog at 500 services per run, and each service at 160 advertised endpoints. The endpoint limit leaves headroom above the largest live `mpp.dev` service observed on 2026-08-25 (107 endpoints) without allowing an unbounded tree. A live endpoint may explicitly advertise `payment: null`; that means no catalog payment offer for that endpoint rather than an invalid catalog. Catalog records become queue messages before D1 normalization. Ingestion records advertised endpoints and offers, then schedules:

- one bounded `GET` of advertised API-reference metadata when present, otherwise the conventional `openapi.json` candidate;
- a bounded `GET` of the origin's RFC 9727 `/.well-known/api-catalog`;
- catalog endpoints whose advertised method is `GET` or `HEAD`.

When a catalog service has no advertised endpoint, its service base is scheduled as the bounded fallback runtime target. This avoids a redundant base request for services that already provide a concrete harmless endpoint.

### MPPScan/Merit fallback

The fixed anonymous source is `https://mppscan.com/`. No documented API contract is assumed. The importer fetches the public HTML without cookies or credentials and extracts only exact, bounded `originUrls` arrays from page hydration data. It does not crawl arbitrary page links or scripts.

Each accepted candidate schedules one bounded `GET` observation, one bounded `GET` of its conventional `openapi.json` candidate, and one bounded RFC 9727 API-catalog lookup. Invalid, credentialed, query-bearing, private-literal, non-HTTP(S), oversized, and excess entries are ignored or reject the bounded source. A non-empty successfully parsed page starts a whole-source Queue barrier. Only after every normalized origin has been scheduled does the run withdraw MPPScan crawl provenance for omitted origins and retire discovery data whose parent has no other active provenance. Failed fetches, invalid or empty hydration data, and incomplete Queue runs retain the last-known membership. Completed-run timestamps prevent a delayed older message from restoring authority or withdrawing a newer member.

### Advertised discovery metadata

OpenAPI support accepts OpenAPI 3.x path operations and normalizes operation-level `x-payment-info` data, including the draft shapes seen in the public ecosystem. A document may contribute at most 160 paid operations and 512 offers; an RFC 9727 document may contribute at most 16 discovery links. Per-service D1 triggers independently enforce the retained 160-endpoint and 512-offer limits. When a split item reaches a retained limit, it is deterministically skipped and marked processed so the enclosing source-snapshot barrier can still finish without partially activating new membership. This metadata remains labeled `openapi`; it is an advertisement, not proof that an endpoint currently enforces payment.

### Manual submission

A submission accepts one public HTTP(S) URL plus bounded optional public context. Cheap syntax, query, credential-shaped path, and duplicate checks run before rate or candidate capacity is consumed; public-address validation runs before persistence. Five-minute rate windows allow 6 accepted attempts per client and 120 globally. Client keys are one-way digests scoped to a single window, so D1 never retains a raw client address or a stable cross-window identifier. Every unconfirmed status counts toward the pool cap of 8 candidates per origin and 500 globally. Authority expires after 24 hours; terminal manual-only records are retained for 30 days for dedupe and operational evidence.

An unconfirmed manual candidate receives only one fixed first pass against the submitted base, conventional `openapi.json`, and RFC 9727 path. Discovery metadata may be normalized, but it cannot schedule advertised descendants or recurring work. A structurally valid runtime `402` challenge promotes the service and permits the bounded discovery tree; trusted `mpp.dev` or MPPScan provenance supplies the same gate independently. A harmless non-MPP response retires the manual target immediately, transient failures stop after three attempts, and Cron expires any remaining unconfirmed candidate. Submission is not authorization for active testing and does not create an arbitrary request proxy.

### Runtime challenge evidence

A public `402` response may contain one or more `WWW-Authenticate: Payment ...` challenges. The parser records normalized method, intent, amount, currency, recipient, chain, decimals, unit type, and public session fields while redacting challenge IDs, opaque values, credentials, and secret-shaped nested fields. Runtime evidence is timestamped and never overwrites its source identity with a catalog claim.

## Crawl pipeline

1. Normalize the URL, remove fragments and query strings, reject embedded credentials and unsupported schemes or ports, and deduplicate on a deterministic service/endpoint/probe-kind/URL target ID.
2. Apply deterministic hash-based jitter before queue delivery.
3. Require every target to carry an existing service identity and use that service's exact hostname, then acquire a conditional 30-second D1 lease for the origin. Contention is retryable, not a reason to run concurrent requests.
4. Validate public DNS twice and make one unauthenticated `HEAD` (homepage) or `GET` (endpoint/discovery) with manual redirect processing.
5. Re-run URL and DNS validation at every redirect hop. Stop after 3 redirects, reject an HTTPS-to-HTTP downgrade or exact URL loop, and reject any redirect whose hostname differs from the normalized service hostname. Canonical same-host redirects share the probe's single origin lease.
6. Enforce an 8-second fetch timeout and bound the body at 256 KiB for ordinary responses or 1 MiB for discovery metadata.
7. Redact headers, challenge values, and structured values, then stage a bounded observation document in R2. Store a body digest and byte count, never response-body content.
8. Reconfirm the crawl-run processing lease and active target provenance before applying normalized state.
9. Normalize catalog/OpenAPI/challenge data, compute a conservative implementation fingerprint, compare mutable fields, and store the queryable summary in D1. A retry replays the deterministic R2 stage instead of refetching the target after a partial D1 interruption.
10. Schedule a completed trusted or confirmed target for its next six-hour observation; retire an unconfirmed manual candidate after its bounded first pass. Retry its transient failures at most three times and reject policy violations.

The R2 key layout is date- and service-scoped:

```text
observations/YYYY/MM/DD/<service-id>/<observation-id>.json
```

Stored request and redirect URLs omit query strings. R2 objects are not exposed as an arbitrary public object browser; the JSON API reads normalized D1 records. Cross-host endpoints or discovery links may remain as advertised metadata, but no crawl target is created and no request is sent to them.

## Normalized D1 model

The initial migration creates:

- `services`: stable service identity, canonical query-free advertised URL, origin, description/tags, fingerprint, and first/last/probe times;
- `endpoints`: method and URL, kind, status, content type, TLS state, redirect count, challenge format, and history anchors;
- `endpoint_sources`: source-scoped current membership for every historical endpoint;
- `payment_offers`: method, intent, chain, currency, recipient, price, decimals, unit type, session fields, source type/ordinal, and first/last seen;
- `sources`: source kind, exact public source URL, bounded evidence, and first/last seen;
- `observations`: D1 summary, redacted challenge/DNS/TLS data, size, status, error, SHA-256 body digest, and R2 key;
- `security_properties`: one named property with state, evidence, basis, optional public prior-art link, and observation time;
- `changes`: field-level old/new values with evidence and time;
- `submissions`: normalized URL/origin dedupe, candidate expiry, confirmation, and scheduling state;
- `submission_rate_windows`: short-lived global and window-scoped one-way client counters without raw client addresses;
- `crawl_targets`: target dedupe, attempt state, next due time, and last bounded error;
- `crawl_target_sources`: source-scoped target authority, including withdrawal and restoration;
- `origin_rate_limits`: conditional per-origin leases;
- `source_snapshots`, `source_snapshot_items`, and staging tables: per-service atomic publication barriers for catalog, OpenAPI, and RFC 9727 data;
- `discovery_runs` and `discovery_run_services`: whole-catalog barriers, source-run status, and bounded result counts.

IDs are deterministic hashes where an external stable ID is unavailable. A service found through multiple sources converges on its normalized service URL, while each provenance record remains distinct. Catalog records are split to one endpoint, OpenAPI records to one offer, RFC 9727 fan-out to one scheduling link, and Cron due work to one target per Queue message so each invocation stays inside D1 query budgets. Catalog and OpenAPI revision clocks are separate from runtime `last_seen`, so a later runtime probe cannot suppress delayed-but-new source metadata. Payment-offer identity is stable per endpoint, source, and source ordinal; method, currency, chain, recipient, price, and session changes update that slot while triggers preserve field history. Change detection also covers service fields, endpoint fields, challenge format, status, transport observations, redirects, security-property transitions, and implementation fingerprint.

Per-service source snapshots stage normalized services, endpoints, offers, and target authority until every split item completes, then publish the complete revision in one D1 batch. Readers filter on published membership, so neither new nor replacement partial state becomes visible. Budget-exhausted OpenAPI items count as completed skips and do not enqueue a child target. Terminal Queue exhaustion marks a snapshot failed and deletes its staging data; a 24-hour Cron backstop does the same for abandoned runs. Both paths preserve the prior published revision and release staging budgets. A whole-catalog barrier withdraws services omitted from a complete credible run; an empty catalog, a run over 500 services, or a greater-than-50% shrink from an established catalog fails closed instead. Observation timestamps and completed-run guards prevent delayed older messages from resurrecting newer withdrawals. If an advertised OpenAPI parent loses all active provenance, its derived endpoint/offer membership and child probes are explicitly withdrawn; restoration queues a fresh document probe before derived data can become current again. Runtime scheduling derives trust from active crawl-target provenance rather than historical source rows.

## Retention and bounded growth

R2 stores redacted observation documents under `observations/` for 30 days. D1 keeps the immutable SHA-256 body digest and normalized summary after clearing an expired object pointer. Cron compacts superseded repeat observations while preserving the newest summary per target, removes long-inactive endpoints and retired targets, and removes terminal manual-only services after 30 days. Short-lived submission counters and origin leases are pruned promptly; superseded source snapshots and discovery runs are pruned after 14 days while the newest authoritative run remains. Published-service change records are retained as the historical timeline; deletion of an unconfirmed manual-only service also removes its candidate-only rows. Each cleanup is bounded to 5,000 rows per operation.

## Fingerprints and economic metadata

Implementation categories are `mppx`, `mpp-rs`, Cloudflare `mpp-proxy`, `custom`, and `unknown`. Attribution requires explicit product markers in public headers, structurally valid `402` challenges, or named OpenAPI implementation/generator extension fields. Arbitrary prose and paths are never product evidence. Each result stores confidence and the exact signal; hosting on Cloudflare or implementing the MPP challenge format is not enough for a high-confidence product attribution.

Session and streaming metrics are derived only when the required public numeric fields exist. The formula and inputs remain visible with the result. Missing inputs produce `unknown`; a descriptive ratio is not a vulnerability verdict.

## Public interface

Server-rendered pages cover the dashboard, services/search, service details, payment configuration, implementation concentration, recent changes, methodology, and submission. The minimum read-only JSON interface is:

- `/api/services`
- `/api/services/:id`
- `/api/endpoints`
- `/api/implementations`
- `/api/changes`
- `/api/stats`

List responses use capped pagination. Service filters map to parameterized D1 queries for free-text, payment method, chain, implementation, and evidence state. API records expose redacted normalized evidence, never R2 bodies, authorization material, cookies, challenge IDs, opaque values, or signed payment credentials.

## Deployment and verification state

`wrangler.jsonc` preserves the existing `mpp.ninja` Custom Domain, `workers.dev` fallback, disabled preview URLs, observability, and version metadata while adding the data, queue, schedule, and strict-public-fetch bindings. D1, R2, and both Queues are provisioned; migrations `0001_observatory.sql` and `0002_redact_provider_identifiers.sql` are applied to remote D1; and the R2 30-day lifecycle is enabled. Observatory commit `e947ace18165f8378008f234beda1d28ebc74c7f` was deployed as Worker version `2cfb8a5b-21d6-4e38-ba94-4e72ea216e0f`, then verified through the Custom Domain and `workers.dev` fallback.

For an empty production database, `GET /?bootstrap=1` starts the same fixed-source scheduled workflow only when the index has zero services and a ten-minute D1 lease is acquired. It is an asynchronous one-time operator trigger, not a general crawl endpoint; completion must be verified through `/api/stats`, discovery-run state, Queue progress, and an explicit R2 object.

The first production seed was started through the bootstrap lease and verified independently through remote discovery state, Queue-driven observations, an explicit R2 object readback, live UI/API responses at `https://mpp.ninja`, exact Worker version metadata, and remote `main` parity. Point-in-time indexed counts and the latest release evidence are recorded in `FEATURES.md` rather than treated as fixed architecture.
