#!/usr/bin/env node

import { Command } from "commander";
import { randomUUID } from "crypto";
import { AgentPaySDK, DEFAULT_COIN_TYPE, SUI_NETWORKS } from "@sui-agent-pay/sdk";
import type { AppConfig, AgentType, PaidService, X402HttpRequestOptions } from "@sui-agent-pay/sdk";
import * as path from "path";
import * as os from "os";

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

const program = new Command();
program
  .name("sui-agent-pay")
  .description("Sui Agent Payment CLI")
  .version("0.1.0");

program
  .command("wallet-address")
  .requiredOption("--secret-key <key>", "Sui secret key")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      console.log(JSON.stringify({ address: await sdk.getWalletAddress(opts.secretKey) }, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("wallet-balance")
  .option("--secret-key <key>", "Sui secret key")
  .option("--address <address>", "Wallet address")
  .option("--coin-type <type>", "Coin type")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const address = opts.address ?? await sdk.getWalletAddress(opts.secretKey);
      const balance = await sdk.getWalletBalance(address, opts.coinType);
      console.log(JSON.stringify({ address, balance }, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("create-vault")
  .requiredOption("--owner-key <key>", "Owner Sui secret key")
  .option("--coin-type <type>", "Coin type")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const result = await sdk.createVault(opts.ownerKey, opts.coinType);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("create-registry")
  .requiredOption("--owner-key <key>", "Owner Sui secret key")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const result = await sdk.createRegistry(opts.ownerKey);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("create-agent")
  .requiredOption("--label <label>", "Agent label")
  .requiredOption("--agent-type <type>", "long_lived or temporary")
  .requiredOption("--user-id <user>", "User identifier")
  .requiredOption("--owner-key <key>", "Owner Sui secret key")
  .option("--vault-id <id>", "Vault object ID")
  .option("--coin-type <type>", "Coin type")
  .option("--recipient <address>", "Single allowed recipient")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const result = await sdk.createAgent({
        label: opts.label,
        agentType: opts.agentType as AgentType,
        userId: opts.userId,
        ownerSecretKey: opts.ownerKey,
        vaultId: opts.vaultId,
        coinType: opts.coinType,
        allowedRecipients: opts.recipient ? [opts.recipient] : [],
        allowedTokens: opts.coinType ? [opts.coinType] : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("request-payment")
  .requiredOption("--agent-id <id>", "Agent ID")
  .requiredOption("--reason <reason>", "Payment reason")
  .requiredOption("--recipient <address>", "Recipient address")
  .requiredOption("--amount <amount>", "Amount in smallest unit")
  .requiredOption("--session-key <key>", "Agent session key")
  .option("--token <type>", "Coin type")
  .option("--task-id <id>", "Task ID")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const result = await sdk.requestPayment({
        taskId: opts.taskId ?? randomUUID(),
        agentId: opts.agentId,
        reason: opts.reason,
        recipient: opts.recipient,
        token: opts.token ?? loadConfig().coinType ?? DEFAULT_COIN_TYPE,
        amount: opts.amount,
      }, opts.sessionKey);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("revoke-session-key")
  .requiredOption("--agent-id <id>", "Agent ID")
  .requiredOption("--owner-key <key>", "Owner Sui secret key")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      await sdk.revokeKey(opts.agentId, opts.ownerKey);
      console.log(JSON.stringify({ success: true }, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("get-session-info")
  .requiredOption("--agent-id <id>", "Agent ID")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      console.log(JSON.stringify(sdk.getSessionInfo(opts.agentId), null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("list-agents")
  .action(async () => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      console.log(JSON.stringify(sdk.listAgents(), null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("get-audit-log")
  .option("--agent-id <id>", "Agent ID")
  .option("--limit <n>", "Result limit", (value) => Number(value))
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const result = opts.agentId
        ? sdk.getAuditLog(opts.agentId, opts.limit)
        : sdk.getRecentAuditLog(opts.limit);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("register-agent-onchain")
  .requiredOption("--owner-key <key>", "Owner Sui secret key")
  .requiredOption("--agent-uri <uri>", "Agent metadata URI")
  .option("--wallet <address>", "Payment wallet address")
  .option("--registry-id <id>", "Registry object ID")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      console.log(JSON.stringify(
        await sdk.registerOnChainAgent(opts.ownerKey, opts.agentUri, opts.wallet, opts.registryId),
        null,
        2
      ));
    } finally {
      sdk.close();
    }
  });

program
  .command("give-feedback")
  .requiredOption("--signer-key <key>", "Signer Sui secret key")
  .requiredOption("--agent-id <id>", "Agent ID", (value) => Number(value))
  .requiredOption("--value <score>", "Score 0-100", (value) => Number(value))
  .option("--registry-id <id>", "Registry object ID")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      console.log(JSON.stringify(
        await sdk.giveFeedback(opts.signerKey, opts.agentId, opts.value, opts.registryId),
        null,
        2
      ));
    } finally {
      sdk.close();
    }
  });

program
  .command("register-paid-service")
  .requiredOption("--url <url>", "Service URL")
  .requiredOption("--description <text>", "Service description")
  .requiredOption("--price-amount <amount>", "Price amount")
  .requiredOption("--price-token <type>", "Coin type")
  .requiredOption("--pay-to <address>", "Pay-to address")
  .option("--owner-agent-id <id>", "Owner agent ID")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const service: PaidService = {
        serviceId: randomUUID(),
        ownerAgentId: opts.ownerAgentId,
        url: opts.url,
        description: opts.description,
        priceAmount: opts.priceAmount,
        priceToken: opts.priceToken,
        payToAddress: opts.payTo,
        network: loadConfig().network,
        scheme: "exact",
        createdAt: new Date().toISOString(),
      };
      sdk.registerPaidService(service);
      console.log(JSON.stringify(service, null, 2));
    } finally {
      sdk.close();
    }
  });

program
  .command("x402-http-request")
  .requiredOption("--url <url>", "Target URL")
  .requiredOption("--agent-id <id>", "Agent ID")
  .requiredOption("--reason <reason>", "Reason")
  .requiredOption("--session-key <key>", "Session key")
  .option("--task-id <id>", "Task ID")
  .option("--method <method>", "HTTP method")
  .option("--body <body>", "HTTP body")
  .action(async (opts) => {
    const sdk = new AgentPaySDK(loadConfig());
    try {
      const request: X402HttpRequestOptions = {
        url: opts.url,
        method: opts.method,
        body: opts.body,
        agentId: opts.agentId,
        taskId: opts.taskId ?? randomUUID(),
        reason: opts.reason,
      };
      console.log(JSON.stringify(await sdk.requestHttpPayment(request, opts.sessionKey), null, 2));
    } finally {
      sdk.close();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
