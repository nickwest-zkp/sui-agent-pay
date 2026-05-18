# Contributing

This subtree is the Sui frontend workspace for Agent Pay.

## Scope

The maintained app lives in `packages/nextjs`.

## Local Setup

From `front/agentpayapp`:

```bash
pnpm install:web
pnpm dev
```

Copy `packages/nextjs/.env.example` to `packages/nextjs/.env.local` before running the app.

## Expected Checks

Run these before submitting changes:

```bash
pnpm lint
pnpm check-types
pnpm build
```

## Contribution Rules

- Keep the frontend Sui-only.
- Put wallet UI code behind client-only boundaries.
- Prefer Next.js API routes for server-side SDK, sqlite, x402, or audit-log access.
- Update docs when environment variables, routes, or setup steps change.
- Keep changes focused. Avoid mixing refactors with behavior changes unless they are tightly related.

## Pull Requests

- Use a clear title that describes the user-visible or developer-visible change.
- Include validation details such as `pnpm lint`, `pnpm check-types`, and `pnpm build`.
- Call out any required env vars, package ids, or shared object ids for reviewers.
