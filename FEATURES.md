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

