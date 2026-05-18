---
name: agent-pay
description: Agent-native secure payment system on Monad. Provides session-key-based restricted vault, dual-layer policy engine (hard rules + AI risk), full audit trail. Exposed as MCP tools, CLI, and TypeScript SDK for any AI Agent to call.
---

# monad-agent-pay SKILL

> Secure on-chain payment capabilities for AI Agents on Monad.

## What This Skill Provides

11 MCP tools that let any AI Agent manage payments safely:

| Tool | Description |
|------|-------------|
| `create_agent` | Create agent with session key + on-chain registration |
| `request_payment` | Payment through dual-layer policy engine → on-chain execution |
| `rotate_session_key` | Atomic session key rotation (revoke old + register new) |
| `revoke_session_key` | Permanently revoke an agent's payment capability |
| `get_session_info` | Query on-chain session key status (limits, spent, expiry) |
| `list_agents` | List all registered agents |
| `get_audit_log` | Full audit trail with policy decisions + AI risk scores |
| `emergency_pause` | Stop all vault operations immediately |
| `unpause` | Resume vault after emergency pause |
| `deposit` | Deposit native MON into the vault |
| `withdraw` | Withdraw tokens from the vault |

## Architecture

```
Agent (Claude / Codex / Manus / ...)
  │
  ▼
MCP Server / CLI
  │
  ▼
┌─────────────────────────────────┐
│         SDK Orchestrator         │
│                                  │
│  ┌───────────┐ ┌──────────────┐ │
│  │ Hard Rules │ │ AI Risk Eval │ │
│  │ (deny/     │ │ (restrict    │ │
│  │  allow/    │ │  only, never │ │
│  │  escalate) │ │  expand)     │ │
│  └─────┬─────┘ └──────┬───────┘ │
│        └──────┬───────┘          │
│               ▼                  │
│     Decision Aggregator          │
│     ┌──────────────────┐        │
│     │ hard=deny → deny │        │
│     │ allow+low → allow│        │
│     │ allow+med → ask  │        │
│     │ allow+high→ deny │        │
│     └──────────────────┘        │
│               │                  │
│               ▼                  │
│        Audit Logger              │
└───────────────┬─────────────────┘
                │
                ▼
   AgentPaymentVault.sol (Monad)
   Session Key → Restricted Payment
```

## Security Model

- **Vault pattern**: Assets live in the smart contract, session keys are just authorized signers in a mapping — rotation doesn't move funds.
- **Dual-layer policy**: Hard deterministic rules (boundaries) + AI probabilistic risk (behavioral anomaly, split-tx detection, prompt injection detection). AI can only restrict, never expand permissions.
- **Session keys**: Time-limited, amount-capped, recipient/token-whitelisted. Atomic rotation without fund movement.
- **Emergency brake**: Owner can pause all operations instantly.

## Setup

### 1. Deploy the Vault Contract

```bash
cd contracts
forge build
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC_URL --broadcast --private-key $OWNER_KEY
```

### 2. Install Dependencies

```bash
cd monad-agent-pay
pnpm install
pnpm build
```

### 3. Configure

Copy `.env.example` to `.env` and set `VAULT_ADDRESS` and `OWNER_PRIVATE_KEY`.

### 4. Use via MCP (recommended for Agents)

Add to your MCP config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "monad-agent-pay": {
      "command": "node",
      "args": ["path/to/monad-agent-pay/packages/mcp-server/dist/server.js"],
      "env": {
        "VAULT_ADDRESS": "0x...",
        "MONAD_NETWORK": "monad-testnet"
      }
    }
  }
}
```

### 5. Use via CLI

```bash
# Create agent
agent-pay create-agent --label "shopping-bot" --type long_lived --user user1 --owner-key 0x...

# Make payment
agent-pay request-payment --agent-id <id> --task-id task1 \
  --reason "API subscription fee" --recipient 0x... \
  --token 0x... --amount 1000000 --session-key 0x...

# View audit log
agent-pay audit-log --agent-id <id>

# Emergency stop
agent-pay emergency-pause --owner-key 0x...
```

## Demo Flow (4 Paths)

1. **Normal payment** — under threshold, passes hard rules, AI risk low → auto-execute
2. **Over-budget deny** — exceeds daily budget → hard-rule deny, no on-chain call
3. **AI suspicion** — split-transaction pattern detected → require_approval
4. **Emergency pause** — owner pauses vault → all payments stop

## Monad-Specific Features

- **400ms blocks / 800ms finality** — near-instant payment confirmation
- **Async execution** — 1.2s delay for new fund availability after deposit
- **Reserve balance** — 10 MON kept per EOA for gas
- **Gas charged on gas_limit** — SDK estimates carefully to minimize cost
- **`eth_sendRawTransactionSync`** — optional synchronous tx submission

## Project Structure

```
monad-agent-pay/
├── contracts/                  # Solidity + Foundry
│   ├── src/AgentPaymentVault.sol
│   ├── test/AgentPaymentVault.t.sol
│   └── script/Deploy.s.sol
├── packages/
│   ├── sdk/                    # Core TypeScript SDK
│   │   └── src/
│   │       ├── index.ts        # SDK orchestrator
│   │       ├── types.ts        # Shared types
│   │       ├── core/
│   │       │   ├── policy-engine.ts
│   │       │   ├── ai-risk-evaluator.ts
│   │       │   ├── decision-aggregator.ts
│   │       │   └── audit-logger.ts
│   │       ├── chain/
│   │       │   └── contract-client.ts
│   │       └── storage/
│   │           └── sqlite.ts
│   ├── cli/                    # CLI wrapper
│   │   └── src/index.ts
│   └── mcp-server/             # MCP server
│       └── src/server.ts
└── .env.example
```
