---
name: agent-pay
description: Agent-native secure payment system on Sui. Provides session-key-based vault controls, policy evaluation, audit logging, MCP tools, CLI, and a TypeScript SDK for agent-driven payment flows.
---

# Sui Agent Pay Skill

> Secure on-chain payment capabilities for AI agents on Sui.

## What This Skill Provides

- Vault creation and shared object management
- Session key registration, funding, and revocation
- Policy-based payment requests with approval escalation
- Local audit log and approval tracking
- x402 paid-service request and verification flow
- MCP, CLI, and SDK entry points over the same backend primitives

## Active Stack

- `sui/`: Move package with `agent_vault` and `agent_registry`
- `packages/sdk/`: TypeScript SDK
- `packages/cli/`: local operator CLI
- `packages/mcp-server/`: MCP server for agent integration
- `front/agentpayapp/packages/nextjs/`: dashboard and demo runtime

## Core Security Model

- Funds live in the vault object, not in the session key wallet
- Session keys are constrained by amount, expiry, and recipient policy
- Hard policy and risk evaluation decide whether to allow, deny, or escalate
- Every request is written to the audit log
- Human approval can be routed through Telegram for demo purposes

## Local Setup

```bash
pnpm install
pnpm build
pnpm build:sui:move
```

## Required Environment

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

## MCP Example

```json
{
  "mcpServers": {
    "sui-agent-pay": {
      "command": "node",
      "args": ["packages/mcp-server/dist/server.js"],
      "cwd": "/absolute/path/to/sui-agent-pay"
    }
  }
}
```
