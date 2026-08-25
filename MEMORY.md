---
summary: Compact map of durable, verified knowledge about mpp.ninja.
directories:
  notes: Durable project observations, created when useful.
  logs: Dated work records, created when useful.
---

# Memory

- The project is a security-aware MPP observatory intended to use Cloudflare tooling and infrastructure.
- GitHub is the source host.
- The initial application is a TypeScript Cloudflare Worker managed with npm and Wrangler; it has no MPP functionality yet.
- The production Worker is `mpp-ninja` at `https://mpp-ninja.bcrt43.workers.dev`; initial verified version `4885040a-9061-4bba-ae75-1d0080546439` came from Git SHA `eba6fedf072aaa1bcb25b220224a1bb0efd13883`.
- The primary production URL is `https://mpp.ninja`, configured as a Worker Custom Domain. Verified version `d4e09698-0b36-45ad-a3dc-9ade4e2993a1` came from Git SHA `97cad32c21d1f8d9b058eba36b6751a4740ff589`; the `workers.dev` fallback remains enabled and preview URLs are disabled.
- Use Node 24 from `.nvmrc`; Node 23 is unsupported by the current test stack.
- `AGENTS.md` is the canonical operating guide; `FEATURES.md` is the product and acceptance tracker.
