# MonAgentPay Frontend Mapping

This document maps the current Sui frontend to the backend SDK and Move-based payment flow.

## Runtime Areas

| UI area | Main data | Current source | Notes |
| :--- | :--- | :--- | :--- |
| Home page | Product overview, setup hints, network summary | Static app content plus `lib/sui-app.ts` | Entry page for the Sui-only workspace. |
| Dashboard header | Connected address, network, wallet state | `@mysten/dapp-kit-react` hooks | Wallet state comes from the Sui dapp-kit layer. |
| Backend status card | API health, database status, server config | `GET /api/backend/status` | Verifies the local SDK adapter is available. |
| Agents panel | Registered agents and policy state | `GET /api/agents` | Reads registry and stored agent metadata. |
| Payments panel | Payment history and current requests | `GET /api/payments` | Surfaces server-side settlement results. |
| Audit log panel | Audit events and operator traces | `GET /api/audit-log` | Keeps client components free of direct sqlite access. |
| Services / x402 panel | Paid service discovery and verification | `GET /api/services`, `POST /api/x402/*` | Keeps x402 logic on the server boundary. |

## Sui Transaction Flow

| User action | Frontend entry point | Server or chain target | Notes |
| :--- | :--- | :--- | :--- |
| Connect wallet | Client-only wallet components | Sui wallet standard provider | Browser-only integration through dapp-kit wrappers. |
| Inspect network config | `lib/sui-app.ts` | Fullnode URL and package ids | Shared by pages, providers, and API routes. |
| Review agent state | Dashboard client | `/api/agents` and Move registry objects | Reads Sui registry and locally stored agent metadata. |
| Submit payment operation | Dashboard client | Sui transaction block against the vault object | Uses Move package id, module name, and shared object ids. |
| Verify paid request | Client or server API call | `/api/x402/request` and `/api/x402/verify` | Payment proof handling stays server-side. |

## Guardrails

- Keep wallet code in client modules only.
- Keep SDK and database access behind Next.js API routes.
- Treat `NEXT_PUBLIC_SUI_MOVE_PACKAGE_ID`, `NEXT_PUBLIC_SUI_VAULT_ID`, and `NEXT_PUBLIC_SUI_REGISTRY_ID` as required deployment bindings.
