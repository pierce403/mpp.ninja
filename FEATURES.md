# Features

This file is the living product specification and acceptance tracker for `mpp.ninja`.

## Observatory foundation

**Stability:** planned

### Properties

- Provides a security-aware observatory using Cloudflare's MPP tooling.
- Runs on explicitly documented Cloudflare infrastructure.
- Keeps security-sensitive configuration and credentials out of source control.
- Makes observed data provenance, collection boundaries, and security assumptions inspectable.

### Dependencies

- Product scope and threat model
- Selection of the relevant Cloudflare MPP tooling and runtime components
- Local application scaffold
- GitHub and Cloudflare deployment configuration

### Test criteria

- [ ] The supported observation workflows and non-goals are documented.
- [ ] The threat model and data-handling boundaries are documented.
- [ ] Automated tests cover the selected core workflows and security boundaries.
- [ ] A deployment is tied to a known commit and verified through live behavior.
- [ ] No credentials or environment-specific secrets are committed.

### Evidence

- Repository setup started on 2026-08-25.

## Hello World deployment

**Stability:** stable

### Properties

- Serves an HTML status page from a TypeScript Cloudflare Worker.
- States clearly that MPP functionality is not enabled.
- Supports `GET` and `HEAD` at `/`, returns `404` for other paths, and `405` for unsupported methods.
- Sends baseline content, framing, MIME-sniffing, and referrer security headers.
- Enables Cloudflare Workers observability without storing application data.

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
