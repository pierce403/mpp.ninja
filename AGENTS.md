# AGENTS.md - Instructions for Coding Agents

## Self-improvement

Update this file when you verify an important repository-specific command, convention, pitfall, or collaborator preference. Record both successful approaches and failures worth avoiding. Keep guidance concise, non-secret, and useful to future agents.

## Project overview

`mpp.ninja` is a security-aware MPP observatory built with Cloudflare's MPP tooling. Its code is hosted on GitHub and the service is intended to run on Cloudflare infrastructure.

The project is in initial setup. Do not assume an application framework, Cloudflare product, data model, or deployment topology until it is selected and documented.

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
- Commit durable project knowledge when the repository workflow calls for it.

## Memory and skills

- Keep `MEMORY.md` as a compact map of durable, verified project knowledge.
- Keep `SKILLS.md` as a compact catalog of reusable project procedures.
- Put detailed reusable procedures in `skills/<name>/SKILL.md` only after a repeated workflow justifies them.
- Do not store secrets, private credentials, or unnecessary personal data in repository memory.

## Harness compatibility

`AGENTS.md` is canonical. Compatibility instruction files should be symlinks to it so guidance cannot drift.

## Recurse review

Periodically review [recurse.bot](https://recurse.bot/) for useful agent-etiquette updates. Adapt guidance to this project instead of copying it blindly, and commit only changes that reduce friction for collaborators and future agents.
