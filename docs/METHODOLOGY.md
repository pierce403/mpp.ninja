# Security methodology

## Governing rule

`mpp.ninja` observes the public MPP ecosystem without becoming a paying client or an active security tester.

A recorded result applies only to the named property, endpoint, evidence, and observation time. In particular:

- untested does not mean secure;
- an unreachable endpoint does not mean vulnerable;
- a catalog or OpenAPI declaration does not prove runtime enforcement;
- a valid `402` challenge does not prove correct authorization, delivery, debit, or settlement;
- a fingerprint does not prove a source package, exact version, configuration, or advisory match; and
- a public advisory or research class is prior art until direct public evidence establishes applicability.

## Authorized observation boundary

The crawler may:

- fetch fixed public discovery sources;
- request an advertised public discovery document with unauthenticated `GET`;
- request an advertised public service base with unauthenticated `GET` or `HEAD`;
- request an advertised public `GET` or `HEAD` endpoint;
- observe a legitimate `402 Payment Required` response and its MPP challenge;
- follow a small bounded redirect chain after validating every destination; and
- record public HTTP, DNS, response-size, redirect, and transport evidence made available by the Cloudflare runtime.

The crawler must never:

- make or simulate a payment;
- create, sign, attach, relay, or replay a payment credential or authorization;
- send cookies, API keys, bearer tokens, session material, or user-supplied headers;
- submit forms, perform advertised state-changing methods, or intentionally change remote state;
- fuzz parameters, race requests, bypass controls, exploit a suspected weakness, or test a vulnerability hypothesis against a live target;
- probe non-public networks or use the service as an open proxy; or
- infer a general security verdict from the absence of evidence.

MPP libraries may be used only for pure parsing or explicitly inert protocol helpers. Any auto-payment, wallet, signer, or credential-producing behavior must remain absent from the scanner path.

## Source and evidence hierarchy

The observatory retains provenance rather than collapsing all inputs into one truth claim.

1. **Source listing:** `mpp.dev`, MPPScan/Merit, or a manual submitter advertised a URL. This supports only the listing and its time.
2. **Advertised configuration:** a catalog record or OpenAPI `x-payment-info` document declared an endpoint or offer. This supports only what was advertised.
3. **Runtime observation:** a bounded public response exposed a status, headers, redirects, or MPP challenge at a specific time.
4. **Derived inference:** a deterministic parser or formula derived a value from named public inputs. The result stores its basis and must not outrank the inputs.
5. **Harmless test:** the scanner exercised one non-state-changing control, such as rejecting a private redirect or enforcing a response limit. Passing that test says nothing about unrelated security properties.

For the mpp.dev catalog, the exact `serviceUrl` is the advertised service identity. A homepage `url` is not silently substituted. For MPPScan, only the exact bounded `originUrls` hydration array is accepted; the anonymous HTML parser is explicitly a fallback, not a documented feed contract. A change in page rendering is not evidence that an origin ceased to exist.

OpenAPI ingestion accepts OpenAPI 3.x operations with `x-payment-info` and preserves `openapi` as the source type. Runtime MPP challenges preserve `challenge` as the source type. First-seen and last-seen timestamps are tracked independently from source authority.

## SSRF and open-proxy controls

Untrusted URLs enter through public sources and manual submissions. The same policy is applied before queueing and again before each network request.

### URL policy

- Accept only `http:` and `https:`.
- Reject embedded usernames or passwords.
- Reject manual submission paths with credential-, reset-, token-, or high-entropy secret-shaped segments before persistence or rate accounting.
- Accept only the default ports 80 and 443.
- Reject empty hostnames, `localhost`, and `.localhost`, `.local`, `.internal`, or `.home.arpa` names.
- Reject the observatory's own production and Workers.dev hostnames.
- Remove URL fragments and query strings during discovery normalization.
- Require every queued, due, or redirected target to use the exact normalized service hostname. Cross-host metadata may be indexed as an advertisement, but it is never fetched.
- Do not expose a fetch-and-return route or allow submitters to choose request headers or methods.

### Address policy

Private and reserved IPv4 space is blocked, including unspecified, loopback, RFC1918, carrier-grade NAT, link-local and metadata addresses, documentation/test ranges, benchmark ranges, multicast, and reserved space. IPv6 checks reject unspecified, loopback, unique-local, link-local, site-local, multicast, documentation, Teredo, NAT64 well-known-prefix, and private/reserved IPv4-mapped destinations.

For a hostname, the scanner resolves both A and AAAA records twice through Cloudflare DNS before fetching. It rejects an empty answer, any private/reserved answer, or a changed answer set. The process repeats at every redirect hop. The `global_fetch_strictly_public` compatibility flag adds a Cloudflare runtime restriction but does not replace these application checks.

Double resolution narrows common DNS-rebinding opportunities but cannot prove that a remote deployment will never change DNS. Records therefore describe the observed validation, not a permanent origin property.

### Request and redirect policy

- Advertised `HEAD` operations use `HEAD`; service-base, endpoint, and discovery observations use `GET`.
- Requests contain only bounded `Accept` and observatory `User-Agent` headers.
- Redirect mode is manual.
- At most 3 redirects are followed.
- Every redirect is normalized and re-resolved before a request is sent.
- An exact redirect URL loop is rejected. A bounded same-host canonical redirect shares the probe's one lease; a different hostname is rejected before its DNS lookup or fetch.
- HTTPS-to-HTTP downgrade is rejected.
- A redirect without `Location` is rejected.
- A fetch is bounded at 8 seconds.
- Ordinary response bodies are bounded at 256 KiB; discovery documents are bounded at 1 MiB.
- A declared oversized `Content-Length` is rejected before body consumption, and streamed bodies are stopped once the limit is exceeded.

### Scheduling policy

Targets are deduplicated by service, endpoint, probe kind, and normalized URL. Hash-based jitter spreads new work, D1 grants a 30-second conditional per-origin lease, and the Queue consumer is limited to five concurrent single-message invocations. Catalog/OpenAPI messages are split to one endpoint/offer; each RFC 9727 link and each due-target scheduling unit gets its own message to stay within D1 query budgets. Producer calls also obey Queue count and byte budgets. Per-document limits are 160 catalog endpoints per service, 160 paid OpenAPI operations, 512 OpenAPI offers, and 16 RFC 9727 links. Application checks and D1 triggers cap each service at 192 active and 256 retained crawl targets, 160 retained OpenAPI endpoints, and 512 retained OpenAPI offers; inactive-target reactivation must also fit the active budget. A budget-exhausted OpenAPI item is recorded as a completed skip, never a retry that can strand its snapshot.

Manual submissions receive cheap shape, query, credential-path, and duplicate checks before consuming a rate window; public DNS validation precedes persistence. Five-minute windows allow 6 accepted attempts per client and 120 globally. The client counter key is a window-scoped one-way digest, not a retained client address. Every unconfirmed status counts toward the caps of 8 candidates per origin and 500 globally, preventing stale relabeling from reopening capacity. Each candidate's authority expires after 24 hours. Until a valid runtime `402` promotes it, a manual candidate may run only the submitted base, conventional OpenAPI path, and RFC 9727 path once: normalized metadata is allowed, but descendant targets and recurring crawls are not. Only currently active `mpp.dev` or MPPScan target provenance independently permits derived discovery; an old source row does not. Harmless non-MPP results retire immediately, transient manual failures stop after three attempts, and Cron withdraws expired manual authority.

Other transient failures receive bounded retry and then move to `mpp-crawl-dlq`; stale enqueue reservations are recovered, while policy violations are rejected rather than retried as ordinary targets. Confirmed or trusted completed targets become due on the six-hour observation interval.

These controls reduce load and accidental state changes; they do not grant permission for a target that prohibits even ordinary public access. Operators may remove or suppress a target when appropriate.

## Redaction and retention

Redaction occurs before D1 or R2 persistence and before API exposure.

Header handling redacts at least:

- `Authorization` and `Proxy-Authorization`;
- `Cookie` and `Set-Cookie`;
- API-key, token, secret, credential, and session-shaped headers;
- payment credential, signature, receipt, and response headers; and
- MPP challenge `id`, `opaque`, and encoded `request` header values.

`Location` and `Content-Location` values are stored without credentials, queries, or fragments; `Link` and `Refresh` URL metadata is not retained.

The challenge parser decodes the public request object only for normalization, recursively redacts secret-shaped keys, bounds structure depth/width and strings, and retains only the redacted value. Opaque values are not retained; an implementation marker may become a boolean fingerprint signal. Response-body content is never persisted: the evidence record retains only the bounded byte count and a SHA-256 digest after transient parsing.

Advertised, submitted, and redirect query strings are removed before fetch because they may contain bearer material; stored request, final, and redirect URLs therefore remain query-free. Manual URLs with credential-shaped path segments are rejected rather than redacted into a retained candidate. Submission rate counters store only a digest scoped to one five-minute window and expire after at most two windows; raw client addresses and stable client identifiers are not retained. D1 stores queryable normalized fields, a redacted observation summary, and the body digest. R2 stores the bounded redacted document under a deterministic crawl-run key so an at-least-once retry can replay it without refetching. Neither store should receive response bodies, request authorization material, cookies, challenge IDs, opaque values, or signed payment credentials.

R2 observation objects expire after 30 days. The D1 object pointer is then cleared while its digest and normalized summary remain. Bounded Cron cleanup retains the latest summary per target while compacting older repeat observations, removes inactive targets/endpoints and terminal manual-only candidates after 30 days, and prunes obsolete coordination snapshots/runs after 14 days without removing current authority. The published-service field-level change timeline is retained; candidate-only rows disappear when a terminal unconfirmed manual-only service is pruned.

Redaction is defense in depth, not a reason to collect unnecessary data. New headers or fields require a necessity review and deterministic secret-leak tests before retention.

## Security-property states

Every property uses exactly one state:

| State | Meaning |
| --- | --- |
| `observed` | The public response or discovery record directly contained the named fact. No broader claim is implied. |
| `inferred` | A deterministic interpretation was derived from named public evidence, with uncertainty retained. |
| `tested-pass` | The named harmless test passed for this target and observation. This is not a general security guarantee. |
| `tested-fail` | The named harmless test failed. The evidence must distinguish target behavior from scanner policy rejection or parser failure. |
| `unknown` | Available public evidence cannot determine the property. |
| `not-tested` | Testing the property would exceed the unauthenticated, non-state-changing boundary. |

The scanner may record harmless controls such as HTTPS transport, stable public target validation, redirect-policy compliance, bounded response handling, and challenge parsing. Paid economic behavior, concurrency, replay, and settlement normally remain `not-tested`; absence of a challenge normally remains `unknown`, not a passed result.

## MPP challenge normalization

The parser supports at most eight `Payment` challenges in one `WWW-Authenticate` value without splitting quoted commas. It records:

- payment method and intent;
- realm, description, and expiry when public;
- presence—not value—of challenge ID and opaque fields;
- amount, currency, recipient, chain ID, decimals, and unit type;
- bounded public session or streaming fields; and
- deterministic parse errors.

For observed-MPP classification, the response must be HTTP `402` and the challenge must contain the current draft's required non-empty `id`, `realm`, lowercase `method`, syntactically valid `intent`, and decodable base64url JSON `request`. Values may still be nonconforming to a method-specific schema; the observatory does not claim full protocol conformance.

An advertised or challenged offer is normalized with its source type and first/last-seen times. Recipients, prices, currencies, chains, session parameters, endpoint details, challenge format, HTTP/TLS observations, and fingerprints participate in historical change detection.

## Conservative implementation fingerprints

Only explicit public product markers support product attribution:

| Category | Maximum current confidence | Required class of evidence |
| --- | ---: | --- |
| Cloudflare `mpp-proxy` | 0.95 | Explicit proxy header or named OpenAPI implementation/generator field |
| `mpp-rs` | 0.90 | Explicit server product or named OpenAPI implementation/generator field |
| `mppx` | 0.85 | Explicit `_mppx_scope` marker in a structurally valid `402` challenge |
| `custom` | 0.35 | A valid MPP challenge with no product-specific marker |
| `unknown` | 0.00 | No conservative implementation marker |

Known hosting infrastructure, a `workers.dev` URL, generic Cloudflare response headers, arbitrary discovery-document prose, or ordinary standards compliance are not product fingerprints. When signals conflict, the stored evidence lists every signal and the deterministic precedence is visible. No fingerprint establishes an exact version or a vulnerability.

## Economic-security research classes

The observatory keeps the following properties separate. The taxonomy was informed by an August 24 MPP economic-security review and then reduced to claims that can be grounded in public protocol material, public advisories, and public implementation discussions:

- authorization, delivery, recorded consumption, and settlement consistency;
- per-request advertised price versus actual debit consistency;
- concurrency, atomicity, and single-winner behavior;
- replay resistance, idempotency, credential scope, and retry behavior;
- session/channel lifecycle and settlement binding;
- fee-payer, cosigner, recipient, chain, and authorization binding; and
- payment-method selection, fallback, and downgrade behavior.

These are research classes, not findings about every MPP service. The harmless unauthenticated scanner cannot safely establish most of them, so they remain `unknown` or `not-tested`. Public references such as [GHSA-fxc9-7j2w-vx54](https://github.com/advisories/GHSA-fxc9-7j2w-vx54) and [a public mppx authorization/delivery discussion](https://github.com/wevm/mppx/pull/510#discussion_r3377899233) may be attached as prior art. A record must not call a class an advisory, claim that private research is a public advisory, or infer applicability without target- and version-specific public evidence.

### Observable session and streaming metrics

Metrics are calculated only from finite, non-negative numeric fields in the advertised offer or runtime challenge. Current normalized derivations include:

- `depositWindowRatio = deposit / authorizationWindow` when both exist and the window is greater than zero; and
- `observableAuthorizationExposure = max(0, authorizationWindow - unitPrice * units)` when all three inputs exist.

The result includes a note that it is derived from advertised or challenged values. If the required fields are absent, wrong-typed, negative, or the denominator is zero, the result is `null`/`unknown`. These numbers describe possible economic shape; they do not prove over-authorization, loss, incorrect debit, or exploitability.

## Historical comparison

Change records are field-level differences between bounded observations. They can show that an advertised recipient, price, chain, endpoint, session field, challenge format, status, redirect count, TLS state, or implementation signal changed. They cannot identify why it changed, whether every edge had converged, or whether private backend state agreed.

Timestamped observations are especially important for public endpoints whose challenges vary by request, deployment, region, or session. The UI must present history as evidence, not as a timeless target profile.

## Deterministic verification

`npm run check` is the comprehensive repository gate. Tests cover:

- mixed-scheme challenge splitting, decoding, normalization, malformed input, and nested redaction;
- OpenAPI `x-payment-info` ingestion and draft-shape normalization;
- URL normalization, private/reserved IPv4 and IPv6 policy, double DNS resolution, and rebinding rejection;
- manual redirects, cross-host confinement, HTTPS downgrade, self-targets, timeouts, and body limits;
- header, JSON, text, query, and challenge-value redaction;
- deterministic fingerprint confidence and evidence precedence;
- economic-metric unknown and boundary behavior;
- source and target dedupe, atomic snapshot publication/failure cleanup, global-catalog authority, bounded retention, change detection, API filters/pagination, and D1 migrations; and
- a Wrangler deployment dry run.

Local tests prove deterministic code paths under fixtures. They do not prove production bindings, a migrated production database, R2 writes, Queue delivery, scheduled execution, public DNS/TLS, or live target behavior. Each production property must be verified separately and tied to the deployed Worker version.

## Important limitations

Harmless public probing cannot establish:

- correctness of signed authorization validation;
- delivery, metering, debit, refund, or settlement accounting;
- replay resistance or idempotency under real credentials;
- transaction isolation or concurrency safety;
- private implementation source, exact version, configuration, or dependency state;
- internal topology, origin certificate details hidden by a proxy, or non-public endpoints; or
- ecosystem completeness, because every discovery source can be incomplete or stale and advertised cross-host links are intentionally recorded but not followed.

The Workers fetch API confirms platform certificate validation for HTTPS and may expose the negotiated HTTP protocol. It does not expose the remote certificate chain, expiry, cipher, or TLS version, so `mpp.ninja` is not a certificate-grade SSL scanner. DNS validation cannot pin the subsequent Workers fetch to the exact preflight address; `global_fetch_strictly_public` remains the platform-enforced backstop.

Those limitations are product behavior. They must remain visible in the UI/API rather than being converted into reassuring defaults.
