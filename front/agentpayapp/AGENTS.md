# AGENTS.md

This file describes the current frontend subtree for coding agents.

## Scope

`front/agentpayapp` is a pnpm-based Sui frontend subtree.

## Active Package

- `packages/nextjs`: Next.js App Router frontend for Sui Agent Pay

## Key Runtime Split

- Client wallet code lives behind client-only wrappers.
- Shared Sui config lives in `packages/nextjs/lib/sui-app.ts`.
- SDK access happens through Next.js API routes under `packages/nextjs/app/api`.
- Server-side SDK helpers live in `packages/nextjs/lib/server`.

## Commands

Run commands from `front/agentpayapp`:

```bash
pnpm install:web
pnpm dev
pnpm lint
pnpm check-types
pnpm build
```

## Important Frontend Files

- `packages/nextjs/app/page.tsx`
- `packages/nextjs/app/dashboard/page.tsx`
- `packages/nextjs/components/AppProviders.tsx`
- `packages/nextjs/lib/sui-app.ts`
- `packages/nextjs/lib/sui-dapp-kit.ts`
- `packages/nextjs/lib/server/agent-pay-sdk.ts`

## Guidance

- Keep the frontend Sui-only.
- Prefer server routes for anything that touches sqlite, x402, or the SDK directly.
- Avoid importing wallet UI modules into server-rendered modules unless they are wrapped behind client-only boundaries.
