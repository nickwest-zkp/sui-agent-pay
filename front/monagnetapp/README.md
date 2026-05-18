# Sui Agent Pay Frontend

This subtree is the Sui-only frontend workspace for Agent Pay.

## Structure

- `packages/nextjs`: Next.js frontend for the Sui wallet console
- `packages/nextjs/app/dashboard`: main Sui control panel
- `packages/nextjs/app/api`: server routes that expose SDK, storage, audit, and x402 capabilities
- `packages/nextjs/lib/sui-app.ts`: shared Sui network and Move object configuration
- `packages/nextjs/lib/server`: server-side adapter for `@sui-agent-pay/sdk`

## Environment

Copy `packages/nextjs/.env.example` to `packages/nextjs/.env.local` and set at least:

```bash
NEXT_PUBLIC_SUI_NETWORK=sui-testnet
NEXT_PUBLIC_SUI_MOVE_PACKAGE_ID=0x...
NEXT_PUBLIC_SUI_VAULT_ID=0x...
NEXT_PUBLIC_SUI_REGISTRY_ID=0x...
```

If you want the dashboard to use the local SDK, audit log, paid services, and x402 routes, also set the server-side variables:

```bash
SUI_NETWORK=sui-testnet
SUI_FULLNODE_URL=https://fullnode.testnet.sui.io:443
SUI_MOVE_PACKAGE_ID=0x...
SUI_VAULT_ID=0x...
SUI_REGISTRY_ID=0x...
SUI_COIN_TYPE=0x2::sui::SUI
OWNER_ADDRESS=0x...
DB_PATH=/absolute/path/to/agent-pay.db
```

## Commands

From `front/monagnetapp`:

```bash
pnpm install:web
pnpm dev
pnpm check-types
pnpm build
```

## Pages

- `/`: overview page
- `/dashboard`: Sui wallet and agent operations console

## Notes

- Wallet UI is isolated behind client-only wrappers so `next build` can prerender without browser globals.
- The frontend talks to the SDK through Next.js API routes instead of importing browser-unsafe SDK code into client components.
- This workspace uses `pnpm`. Yarn and npm lockfiles are intentionally not part of the maintained workflow.
