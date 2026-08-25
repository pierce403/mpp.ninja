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

**Stability:** in-progress

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

- [ ] TypeScript and Worker-runtime tests pass.
- [ ] Wrangler configuration and generated types are current.
- [ ] A dry-run deployment succeeds.
- [ ] The deployed Worker returns the expected page, status codes, and security headers.
- [ ] The deployed version is tied to a known Git commit.

### Evidence

- Initial Worker scaffold added on 2026-08-25.
