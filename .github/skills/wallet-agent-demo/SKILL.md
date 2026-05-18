---
name: wallet-agent-demo
description: "Use when testing monad-agent-pay wallet flows through either MCP or skill mode, especially for smoke testing vault deployment, temporary agent creation, session info lookup, and wallet reputation checks on Monad testnet."
---

# Wallet Agent Demo

Use this skill when the user wants to test the wallet stack in three ways:

1. Smoke mode: start the local MCP server and exercise wallet tools directly without an LLM.
2. Model mode: connect any tool-calling model to the local MCP server through the demo script.
3. Skill mode: have the agent execute the same wallet flow directly with the repo's CLI commands.

## Preconditions

- Work from the repository root.
- Prefer `.env` over `.env.example` for real secrets.
- Ensure `pnpm build` has already been run if package outputs may be stale.
- For write tests, `OWNER_PRIVATE_KEY` must be available in `.env`.

## MCP Mode

To add the wallet MCP to an agent runtime, use a config like:

```json
{
	"mcpServers": {
		"monad-agent-pay": {
			"command": "node",
			"args": ["packages/mcp-server/dist/server.js"],
			"cwd": "/absolute/path/to/monad-agent-pay",
			"env": {
				"MONAD_NETWORK": "monad-testnet",
				"MONAD_RPC_URL": "https://testnet-rpc.monad.xyz",
				"VAULT_ADDRESS": "0x0000000000000000000000000000000000000000",
				"FACTORY_ADDRESS": "0x4082E3BdCA42aee2233aF7c30bD5bF4aa59Cb66B",
				"REGISTRY_ADDRESS": "0xc09Ee0F656943B3D768503cFCEA5149Bf95F0170",
				"OWNER_ADDRESS": "<OWNER_ADDRESS>"
			}
		}
	}
}
```

Preferred read-only smoke command:

```bash
pnpm demo:agent:mcp
```

Write-path smoke test:

```bash
pnpm demo:agent:mcp:create
```

Full MCP transaction demo:

```bash
pnpm demo:agent:mcp:tx -- --recipient <RECIPIENT_ADDRESS> --token <TOKEN_ADDRESS> --amount <AMOUNT_IN_SMALLEST_UNIT> --reason "demo transfer"
```

This path deploys a vault if needed, creates a temporary agent restricted to the provided recipient and token, and then requests one payment.

Before the payment step, fund the vault with the token being transferred:

```bash
cast send <VAULT_ADDRESS> "deposit(address,uint256)" <TOKEN_ADDRESS> <AMOUNT_IN_SMALLEST_UNIT> --private-key <OWNER_PRIVATE_KEY> --rpc-url https://testnet-rpc.monad.xyz
```

Model-driven MCP demo with an OpenAI-compatible model endpoint:

```bash
pnpm demo:agent:model -- --model gpt-4.1 --base-url https://api.openai.com/v1 --api-key <API_KEY> --prompt "Inspect my wallet state and summarize it"
```

For models that are not OpenAI-compatible, use a custom command adapter:

```bash
node packages/mcp-server/examples/wallet-agent-demo.mjs --adapter command --command node --command-args scripts/my-model-adapter.mjs --prompt "Deploy a vault if needed and create a temporary agent"
```

There is a minimal reference implementation at [packages/mcp-server/examples/mock-model-adapter.mjs](packages/mcp-server/examples/mock-model-adapter.mjs), and you can validate the command path with:

```bash
pnpm demo:agent:command:mock
```

Expected behavior:

- `demo:agent:mcp` lists MCP tools, local agents, current user vaults, and wallet reputation.
- `demo:agent:mcp:create` additionally deploys a new vault from the factory and creates a temporary agent against that vault in the same MCP session.
- `demo:agent:model` runs a real agent loop: the model sees MCP tool schemas, decides which tools to call, receives tool results, and then returns a final summary.
- `--adapter command` lets the user bridge any other model protocol as long as the wrapper reads JSON from stdin and returns JSON to stdout.

## Skill Mode

When running in skill mode, execute these CLI steps in order:

```bash
pnpm build
node packages/cli/dist/index.js list-vaults --user <OWNER_ADDRESS>
node packages/cli/dist/index.js check-wallet-reputation --wallet <OWNER_ADDRESS>
node packages/cli/dist/index.js deploy-vault --owner-key <OWNER_PRIVATE_KEY>
cast send <VAULT_ADDRESS> "deposit(address,uint256)" <TOKEN_ADDRESS> <AMOUNT_IN_SMALLEST_UNIT> --private-key <OWNER_PRIVATE_KEY> --rpc-url https://testnet-rpc.monad.xyz
node packages/cli/dist/index.js create-agent --label skill-demo --type temporary --user skill-user --owner-key <OWNER_PRIVATE_KEY> --recipients <RECIPIENT_ADDRESS> --tokens <TOKEN_ADDRESS>
node packages/cli/dist/index.js request-payment --agent-id <AGENT_ID> --task-id demo-tx-1 --reason "demo transfer" --recipient <RECIPIENT_ADDRESS> --token <TOKEN_ADDRESS> --amount <AMOUNT_IN_SMALLEST_UNIT> --session-key <SESSION_KEY_PRIVATE>
node packages/cli/dist/index.js session-info --agent-id <AGENT_ID>
node packages/cli/dist/index.js audit-log --agent-id <AGENT_ID> --limit 10
```

Notes:

- Capture `vaultAddress` from `deploy-vault` output if the environment is still using the zero-address placeholder.
- Capture `agentId` from `create-agent` output and feed it into `session-info`.
- Capture `sessionKeyPrivate` from `create-agent` output and feed it into `request-payment`.
- Use `temporary` agent type by default to keep the test cheap and bounded.
- The demo script redacts secrets in console output by default, even if tools return them internally.
- The payment demo path assumes an ERC-20 transfer. The vault must be funded with that token before `request-payment` runs.

## Success Criteria

- The MCP demo returns JSON with `tools`, `checks`, and optionally `deployedVault`, `createdAgent`, and `sessionInfo`.
- The skill-mode CLI path returns a valid vault address, a valid agent id, and non-empty session metadata.
- Any live secret that was temporarily placed into `.env.example` must be removed before ending the task.