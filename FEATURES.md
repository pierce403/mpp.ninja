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
- [x] `GET https://mpp.ninja/` returns the expected Hello World page and security headers.
- [x] Custom-domain error and method behavior matches the verified `workers.dev` deployment.
- [x] The deployed custom-domain configuration is tied to a known Git commit.

### Evidence

- Before configuration on 2026-08-25, `mpp.ninja` returned NXDOMAIN.
- Cloudflare created the apex DNS records and issued a Google Trust Services certificate covering `mpp.ninja` and `*.mpp.ninja`.
- Git commit `97cad32c21d1f8d9b058eba36b6751a4740ff589` deployed as Worker version `d4e09698-0b36-45ad-a3dc-9ade4e2993a1` with the apex custom domain and `workers.dev` fallback enabled; preview URLs are explicitly disabled.
- Live verification on 2026-08-25 returned `200` with the expected page and security headers at `https://mpp.ninja/`; `HEAD /` returned `200`, `GET /mpp` returned `404`, and `POST /` returned `405` with `Allow: GET, HEAD`.
- The fallback `https://mpp-ninja.bcrt43.workers.dev/` continued to return `200` after custom-domain deployment.
