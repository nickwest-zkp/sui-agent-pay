# Sui project notes

The active backend runtime is now Sui-only.

## Current state

- `packages/sdk` no longer depends on `viem` or the old EVM contract client.
- `AgentPaySDK` now routes wallet actions through `SuiChainClient`.
- `packages/cli` and `packages/mcp-server` now load `SUI_*` env vars and use the renamed `@sui-agent-pay/*` workspace packages.
- `sui/` contains the Move package that backs the current vault and registry flow.

## Core design

- Vaults are modeled as `AgentVault<CoinType>` shared objects.
- Registry state is modeled as a shared `AgentRegistry` object.
- Session keys are Sui keypairs, generated locally and registered on-chain by the owner.
- The policy engine and audit storage remain local/off-chain, while settlement happens on-chain.

## Known gaps

1. Registry reputation read APIs are still stubbed in the SDK. Write-paths exist, but query-paths need dynamic-field reads or an indexer.
2. `get_session_info` currently reflects local tracked policy state, not a full on-chain table read.
3. `sui/Move.toml` uses a machine-local cached Sui dependency path to work around current GitHub access failures.
4. The legacy frontend and some old repo content are still present and should be cleaned in a later pass if you want the repo fully Sui-only.
