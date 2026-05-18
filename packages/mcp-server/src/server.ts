#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import * as path from "path";
import * as os from "os";

import { AgentPaySDK, DEFAULT_COIN_TYPE, SUI_NETWORKS } from "@sui-agent-pay/sdk";
import type { AppConfig, AgentType, PaidService, X402HttpRequestOptions } from "@sui-agent-pay/sdk";

function loadConfig(): AppConfig {
  const network = (process.env.SUI_NETWORK ?? "sui-testnet") as AppConfig["network"];
  return {
    network,
    fullnodeUrl: process.env.SUI_FULLNODE_URL ?? SUI_NETWORKS[network].grpcUrl,
    ownerAddress: process.env.OWNER_ADDRESS ?? "",
    dbPath: process.env.DB_PATH ?? path.join(os.homedir(), ".sui-agent-pay", "agent-pay.db"),
    vaultId: process.env.SUI_VAULT_ID,
    registryId: process.env.SUI_REGISTRY_ID,
    coinType: process.env.SUI_COIN_TYPE ?? DEFAULT_COIN_TYPE,
    move: {
      packageId: process.env.SUI_MOVE_PACKAGE_ID ?? "0x0",
      vaultModule: process.env.SUI_VAULT_MODULE ?? "agent_vault",
      registryModule: process.env.SUI_REGISTRY_MODULE ?? "agent_registry",
    },
  };
}

const TOOLS = [
  {
    name: "connect_wallet",
    description: "Resolve a Sui secret key into its wallet address and current balance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ownerKey: { type: "string" },
        coinType: { type: "string" },
      },
      required: ["ownerKey"],
    },
  },
  {
    name: "get_wallet_balance",
    description: "Get balance for a Sui wallet address.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        coinType: { type: "string" },
      },
      required: ["address"],
    },
  },
  {
    name: "create_vault",
    description: "Create a new shared AgentVault object on Sui.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ownerKey: { type: "string" },
        coinType: { type: "string" },
      },
      required: ["ownerKey"],
    },
  },
  {
    name: "create_registry",
    description: "Create a new shared AgentRegistry object on Sui.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ownerKey: { type: "string" },
      },
      required: ["ownerKey"],
    },
  },
  {
    name: "create_agent",
    description: "Create a new agent, generate a Sui session key, and register it into the vault.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string" },
        agentType: { type: "string", enum: ["long_lived", "temporary"] },
        userId: { type: "string" },
        ownerKey: { type: "string" },
        vaultId: { type: "string" },
        coinType: { type: "string" },
        recipient: { type: "string" },
      },
      required: ["label", "agentType", "userId", "ownerKey"],
    },
  },
  {
    name: "request_payment",
    description: "Run a payment through local policy checks and execute it on Sui if allowed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string" },
        agentId: { type: "string" },
        reason: { type: "string" },
        recipient: { type: "string" },
        token: { type: "string" },
        amount: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["agentId", "reason", "recipient", "amount", "sessionKey"],
    },
  },
  {
    name: "revoke_session_key",
    description: "Revoke an agent session key in the vault.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string" },
        ownerKey: { type: "string" },
      },
      required: ["agentId", "ownerKey"],
    },
  },
  {
    name: "get_session_info",
    description: "Return the locally tracked session policy for an agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "list_agents",
    description: "List all locally tracked agents.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_audit_log",
    description: "Get audit receipts for one agent or all recent receipts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "register_agent_onchain",
    description: "Register an agent identity in the Sui registry object.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ownerKey: { type: "string" },
        agentURI: { type: "string" },
        wallet: { type: "string" },
        registryId: { type: "string" },
      },
      required: ["ownerKey", "agentURI"],
    },
  },
  {
    name: "give_reputation_feedback",
    description: "Submit feedback to an agent in the Sui registry object.",
    inputSchema: {
      type: "object" as const,
      properties: {
        signerKey: { type: "string" },
        agentId: { type: "number" },
        value: { type: "number" },
        registryId: { type: "string" },
      },
      required: ["signerKey", "agentId", "value"],
    },
  },
  {
    name: "register_paid_service",
    description: "Register a paid HTTP service in local storage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        description: { type: "string" },
        priceAmount: { type: "string" },
        priceToken: { type: "string" },
        payToAddress: { type: "string" },
        ownerAgentId: { type: "string" },
      },
      required: ["url", "description", "priceAmount", "priceToken", "payToAddress"],
    },
  },
  {
    name: "list_paid_services",
    description: "List paid services in local storage.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "verify_payment_receipt",
    description: "Verify an x402 payment receipt against a stored paid service.",
    inputSchema: {
      type: "object" as const,
      properties: {
        receiptHeader: { type: "string" },
        serviceId: { type: "string" },
      },
      required: ["receiptHeader", "serviceId"],
    },
  },
  {
    name: "x402_http_request",
    description: "Make an HTTP request that automatically handles x402 payment flow.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        body: { type: "string" },
        agentId: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["url", "agentId", "reason", "sessionKey"],
    },
  },
];

async function main() {
  const config = loadConfig();
  const sdk = new AgentPaySDK(config);

  const server = new Server(
    { name: "sui-agent-pay", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "connect_wallet": {
          const walletAddress = await sdk.getWalletAddress(args?.ownerKey as string);
          const balance = await sdk.getWalletBalance(walletAddress, (args?.coinType as string | undefined) ?? config.coinType);
          return { content: [{ type: "text", text: JSON.stringify({ walletAddress, balance }, null, 2) }] };
        }

        case "get_wallet_balance": {
          const balance = await sdk.getWalletBalance(args?.address as string, (args?.coinType as string | undefined) ?? config.coinType);
          return { content: [{ type: "text", text: JSON.stringify(balance, null, 2) }] };
        }

        case "create_vault": {
          const result = await sdk.createVault(args?.ownerKey as string, args?.coinType as string | undefined);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "create_registry": {
          const result = await sdk.createRegistry(args?.ownerKey as string);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "create_agent": {
          const result = await sdk.createAgent({
            label: args?.label as string,
            agentType: args?.agentType as AgentType,
            userId: args?.userId as string,
            ownerSecretKey: args?.ownerKey as string,
            vaultId: args?.vaultId as string | undefined,
            coinType: args?.coinType as string | undefined,
            allowedRecipients: args?.recipient ? [args.recipient as string] : [],
            allowedTokens: args?.coinType ? [args.coinType as string] : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "request_payment": {
          const result = await sdk.requestPayment({
            taskId: (args?.taskId as string | undefined) ?? randomUUID(),
            agentId: args?.agentId as string,
            reason: args?.reason as string,
            recipient: args?.recipient as string,
            token: (args?.token as string | undefined) ?? config.coinType ?? DEFAULT_COIN_TYPE,
            amount: args?.amount as string,
          }, args?.sessionKey as string);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "revoke_session_key": {
          await sdk.revokeKey(args?.agentId as string, args?.ownerKey as string);
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
        }

        case "get_session_info": {
          return { content: [{ type: "text", text: JSON.stringify(sdk.getSessionInfo(args?.agentId as string), null, 2) }] };
        }

        case "list_agents": {
          return { content: [{ type: "text", text: JSON.stringify(sdk.listAgents(), null, 2) }] };
        }

        case "get_audit_log": {
          const result = args?.agentId
            ? sdk.getAuditLog(args.agentId as string, args.limit as number | undefined)
            : sdk.getRecentAuditLog(args?.limit as number | undefined);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "register_agent_onchain": {
          const result = await sdk.registerOnChainAgent(
            args?.ownerKey as string,
            args?.agentURI as string,
            args?.wallet as string | undefined,
            args?.registryId as string | undefined
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "give_reputation_feedback": {
          const result = await sdk.giveFeedback(
            args?.signerKey as string,
            args?.agentId as number,
            args?.value as number,
            args?.registryId as string | undefined
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "register_paid_service": {
          const service: PaidService = {
            serviceId: randomUUID(),
            ownerAgentId: args?.ownerAgentId as string | undefined,
            url: args?.url as string,
            description: args?.description as string,
            priceAmount: args?.priceAmount as string,
            priceToken: args?.priceToken as string,
            payToAddress: args?.payToAddress as string,
            network: config.network,
            scheme: "exact",
            createdAt: new Date().toISOString(),
          };
          sdk.registerPaidService(service);
          return { content: [{ type: "text", text: JSON.stringify(service, null, 2) }] };
        }

        case "list_paid_services": {
          return { content: [{ type: "text", text: JSON.stringify(sdk.listPaidServices(), null, 2) }] };
        }

        case "verify_payment_receipt": {
          const result = await sdk.verifyIncomingPayment(args?.receiptHeader as string, args?.serviceId as string);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "x402_http_request": {
          const requestOpts: X402HttpRequestOptions = {
            url: args?.url as string,
            method: args?.method as string | undefined,
            body: args?.body as string | undefined,
            agentId: args?.agentId as string,
            taskId: (args?.taskId as string | undefined) ?? randomUUID(),
            reason: args?.reason as string,
          };
          const result = await sdk.requestHttpPayment(requestOpts, args?.sessionKey as string);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP Server fatal:", error);
  process.exit(1);
});
