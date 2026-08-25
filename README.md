# mpp.ninja

A security-aware MPP observatory built with Cloudflare's MPP tooling and deployed on Cloudflare infrastructure.

The current app is a Hello World Cloudflare Worker. It intentionally has no MPP functionality yet. Product scope and acceptance criteria are tracked in [FEATURES.md](FEATURES.md).

Live app: <https://mpp-ninja.bcrt43.workers.dev>

## Development

```bash
npm install
npm run check
npm run dev
```

Deploy with `npm run deploy` after authenticating Wrangler with the intended Cloudflare account.
