# sui-agent-pay

Agent-native payment system on Sui.

This repo now treats Sui as the only target chain. The active stack is:

- `sui/`: Move package with `agent_vault` and `agent_registry`
- `packages/sdk`: TypeScript SDK for agent policy, audit, x402 flow, and Sui execution
- `packages/cli`: CLI for local ops
- `packages/mcp-server`: MCP server exposing the wallet tools to agents

## Build

```bash
pnpm install
pnpm build
pnpm build:sui:move
```

## Environment

The runtime now uses Sui-only config:

```bash
SUI_NETWORK=sui-testnet
SUI_FULLNODE_URL=https://fullnode.testnet.sui.io:443
SUI_MOVE_PACKAGE_ID=0x...
SUI_VAULT_MODULE=agent_vault
SUI_REGISTRY_MODULE=agent_registry
SUI_VAULT_ID=0x...
SUI_REGISTRY_ID=0x...
SUI_COIN_TYPE=0x2::sui::SUI
OWNER_ADDRESS=0x...
DB_PATH=/absolute/path/agent-pay.db
```

## CLI

Examples:

```bash
node packages/cli/dist/index.js wallet-address --secret-key <SUI_SECRET_KEY>
node packages/cli/dist/index.js create-vault --owner-key <SUI_SECRET_KEY>
node packages/cli/dist/index.js create-registry --owner-key <SUI_SECRET_KEY>
node packages/cli/dist/index.js create-agent --label bot --agent-type temporary --user-id demo --owner-key <SUI_SECRET_KEY> --vault-id <VAULT_ID>
node packages/cli/dist/index.js request-payment --agent-id <AGENT_ID> --reason "api fee" --recipient <SUI_ADDRESS> --amount 10000000 --session-key <SESSION_SECRET_KEY>
```

## MCP

Example MCP config:

```json
{
  "mcpServers": {
    "sui-agent-pay": {
      "command": "node",
      "args": ["packages/mcp-server/dist/server.js"],
      "cwd": "/absolute/path/to/sui-agent-pay",
      "env": {
        "SUI_NETWORK": "sui-testnet",
        "SUI_FULLNODE_URL": "https://fullnode.testnet.sui.io:443",
        "SUI_MOVE_PACKAGE_ID": "0x...",
        "SUI_VAULT_ID": "0x...",
        "SUI_REGISTRY_ID": "0x..."
      }
    }
  }
}
```

Current MCP tools include wallet connect/balance, vault creation, registry creation, agent creation, payment requests, session revocation, audit queries, paid-service registration, and x402 payment flow.

## Notes

- `sui/Move.toml` currently points to a local cached Sui framework path on this workstation because remote GitHub fetches are failing here.
- The old EVM runtime is no longer part of the active SDK/CLI/MCP path.
- The legacy frontend and some old demo files are still present in the repo and can be cleaned separately.
