# AGENTS.md - Instructions for Coding Agents

## Self-improvement

Update this file when you verify an important repository-specific command, convention, pitfall, or collaborator preference. Record both successful approaches and failures worth avoiding. Keep guidance concise, non-secret, and useful to future agents.

## Project overview

`mpp.ninja` is a global, security-aware observatory for public Machine Payments Protocol services. Its code is hosted on GitHub and runs as one TypeScript Cloudflare Worker.

The selected topology is documented in `docs/ARCHITECTURE.md`: D1 holds the normalized index and crawl state, R2 holds bounded redacted observations, Queues provide asynchronous crawl delivery and retry, and Cron schedules discovery and recrawls. Durable Objects are not currently justified. Preserve this topology unless a measured requirement supports changing it.

## Responsibilities

- Build, test, and maintain the observatory with security as an explicit design constraint.
- Verify claims against the checkout, current Cloudflare documentation, tests, and deployed behavior as applicable.
- Keep product behavior and acceptance evidence current in `FEATURES.md`.
- Preserve focused commits and avoid unrelated changes.
- Never commit credentials, tokens, `.dev.vars`, or environment-specific secrets.

## Before important work

1. Confirm the working directory is inside this Git repository and inspect `git status`.
2. Read this file and the affected entries in `FEATURES.md`.
3. Check `MEMORY.md` and `SKILLS.md` for relevant durable context or procedures.
4. Verify changing Cloudflare APIs, configuration, limits, and security guidance against current official documentation.

## Build and test commands

The application is a TypeScript Cloudflare Worker managed with npm and Wrangler.

```bash
npm install
npm run check
npm run dev
npm run deploy
```

Run `npm run types` after changing `wrangler.jsonc` bindings. Add only commands that have been run successfully in this checkout.

Use Node 24 as specified by `.nvmrc`. Node 23 is unsupported by current Vitest and triggered an npm 11.1 dependency-resolver failure during setup.

## Feature specifications

- Treat `FEATURES.md` as the living behavioral specification and acceptance tracker.
- Use exactly `stable`, `in-progress`, or `planned` for feature stability.
- Read affected properties, dependencies, and test criteria before changing behavior.
- Update feature behavior, evidence, dependencies, and stability in the same contribution.
- Mark a feature `stable` only after it is complete, tested, and production-ready.

## Working conventions

- Prefer inspectable, repeatable CLI workflows and small repository scripts.
- Use official Cloudflare documentation as the source of truth for current platform behavior.
- Separate local implementation, automated test evidence, deployment success, and live production verification.
- Keep security observations evidence-scoped; distinguish hypotheses from confirmed findings.
- Preserve the scanner's harmless-probing boundary: public discovery documents, unauthenticated `GET`/`HEAD`, legitimate `402` challenges, redirects, and TLS/HTTP metadata only. Never pay, sign or send credentials, replay authorizations, fuzz, exploit, or intentionally change remote state.
- Never use an MPP library mode that can auto-pay during discovery.
- Treat Cloudflare Queues as at-least-once delivery. Ingest, crawl, history, and submission writes must remain idempotent.
- Keep source identities distinct. For `mpp.dev`, preserve the advertised `serviceUrl` path (while removing queries); do not replace it with a homepage `url`. MPPScan/Merit discovery is an anonymous HTML fallback over an exact embedded `originUrls` array, not a documented API. Reconcile MPPScan omissions only after its complete Queue barrier; fetch, parse, empty-list, and partial-processing failures retain last-known authority, and newer completed runs defeat delayed older messages.
- Treat a live-catalog endpoint with `payment: null` as an endpoint without an advertised offer. Keep complete per-source and whole-catalog barriers authoritative: partial runs do not withdraw current data, and delayed older messages must not resurrect a newer completed withdrawal.
- Preserve provenance and evidence layers: catalog and OpenAPI values are advertised, while a runtime `402` challenge is a time-specific observation.
- Use only `observed`, `inferred`, `tested-pass`, `tested-fail`, `unknown`, and `not-tested` for security-property state. A missing, unknown, or untested result never means secure.
- Keep fingerprints conservative and version-agnostic. Arbitrary OpenAPI prose is not product evidence; only explicit headers, valid challenge markers, or named implementation/generator fields qualify. Public advisories are prior art until observable evidence establishes target and version applicability.
- Derive session or streaming economic metrics only from public numeric inputs and publish the formula; otherwise store `unknown`.
- Commit durable project knowledge when the repository workflow calls for it.

## Known issues and solutions

- If HTTPS pushes invoke the removed Snap path `/snap/bin/gh`, run `gh auth setup-git` to point Git's credential helper at the installed GitHub CLI.
- The initial Worker uses compatibility date `2026-08-22`, the newest date supported by the current local `workerd` test runtime when verified on 2026-08-25.
- Keep the `global_fetch_strictly_public` compatibility flag enabled. Application checks still must require the exact normalized service hostname for queued, due, and redirected targets; reject private/reserved destinations; validate DNS twice at every allowed hop; block HTTPS downgrade and self-targets; and enforce limits. Cross-host advertised metadata may be retained, but must never be fetched. The platform flag is defense in depth.
- Production resource names are `mpp-observatory` (D1), `mpp-observations` (R2), `mpp-crawl` (Queue), and `mpp-crawl-dlq` (dead-letter Queue). Migration `0001_observatory.sql` is applied to remote D1. R2 is declared in `wrangler.jsonc`, but the Cloudflare account still needs R2 activation before the bucket can be created and an observatory deployment can complete.
- Bindings in `wrangler.jsonc` are top-level and non-inheritable. Run `npm run types` after changing them, and keep D1 schema changes in ordered migrations.
- Scanner limits are repository security invariants: 8-second fetch timeout, at most 3 manual same-host redirects with no exact URL revisit, 256 KiB ordinary bodies, 1 MiB discovery bodies, at most 8 parsed Payment challenges, and one 30-second lease for the service origin in a bounded probe. Changing them requires updated deterministic boundary tests and methodology documentation.
- Advertised and redirect query strings are removed before fetch or persistence. R2 observations store response byte counts and SHA-256 body digests, not response-body content. Queue producer batches must remain below 100 messages and the conservative 240,000-byte aggregate budget.
- Keep the Queue consumer batch at 1; split catalog endpoints, OpenAPI offers, RFC 9727 links, and due-target scheduling into one unit per message unless a query-budget proof and tests support a change. Preserve five-minute stale-`enqueueing` recovery and source-specific catalog/OpenAPI clocks.
- Keep discovery-tree limits synchronized across `src/budgets.ts`, D1 triggers, tests, architecture, and methodology: 160 catalog/OpenAPI endpoints, 512 OpenAPI offers, 16 RFC 9727 links, and 192 active/256 retained crawl targets per service. Budget exhaustion must complete its source-snapshot item without scheduling a child.
- Manual candidates are untrusted until a valid runtime `402` or currently active mpp.dev/MPPScan target provenance promotes them. Before promotion, allow only one fixed base/OpenAPI/API-catalog pass, never derived or recurring targets; retain no raw client address; enforce 6/client and 120/global per five-minute window; count every unconfirmed status toward 8 candidates/origin and 500 globally; expire unconfirmed authority after 24 hours; and prune terminal manual-only records after 30 days.
- Source snapshots must stage normalized membership and target authority until their complete barrier publishes atomically. Terminal Queue exhaustion and the 24-hour stale-run backstop must fail and clean staging without changing the prior published revision or leaving recurring targets.
- Preserve bounded retention: 30-day R2 lifecycle and observation/manual cleanup, 14-day obsolete coordination cleanup, D1 body digests after object-pointer expiry, latest per-target summaries, current authority, and the published-service field-level change timeline.
- Count a runtime service as observed MPP only for HTTP `402` plus a structurally valid current-draft challenge (`id`, `realm`, lowercase `method`, syntactically valid `intent`, and decodable `request`).
- Preserve mixed-scheme `WWW-Authenticate` handling: a valid Payment challenge must remain parseable before or after Bearer, Basic, Digest, or another standards-valid scheme.
- Deployment, migration, queue processing, R2 persistence, and public UI/API behavior are separate gates. Verify each directly before recording production evidence in `FEATURES.md`.

## Memory and skills

- Keep `MEMORY.md` as a compact map of durable, verified project knowledge.
- Keep `SKILLS.md` as a compact catalog of reusable project procedures.
- Put detailed reusable procedures in `skills/<name>/SKILL.md` only after a repeated workflow justifies them.
- Do not store secrets, private credentials, or unnecessary personal data in repository memory.

## Harness compatibility

`AGENTS.md` is canonical. Compatibility instruction files should be symlinks to it so guidance cannot drift.

## Recurse review

Periodically review [recurse.bot](https://recurse.bot/) for useful agent-etiquette updates. Adapt guidance to this project instead of copying it blindly, and commit only changes that reduce friction for collaborators and future agents.
