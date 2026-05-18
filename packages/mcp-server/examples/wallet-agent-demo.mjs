#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const DEFAULT_SYSTEM_PROMPT = [
  "You are a Monad wallet agent using MCP tools from monad-agent-pay.",
  "You support both Chinese and English natural language commands.",
  "When the user says things like '帮我转账到0x...' or 'send 1 MON to 0x...', you should use the send_transfer tool.",
  "When the user says '连接钱包' or 'connect wallet', use the connect_wallet tool.",
  "When the user says '查询余额' or 'check balance', use the get_wallet_balance tool.",
  "Prefer read-only checks first. Only perform write actions when the user explicitly asks or the runtime flags permit it.",
  "When a tool returns sensitive values such as private keys, use them only for follow-up tool calls and do not reveal them in the final answer unless the user explicitly asks for secrets.",
  "Be concise and operational. Summarize what you checked, what actions you took, and any on-chain outputs that matter.",
  "For transfers, parse the recipient address, token address (default to 0x0000000000000000000000000000000000000000 for native MON), and amount from the user's message.",
  "Amount conversion: if the user says '1 MON', convert to wei: 1000000000000000000. If they say '0.1 MON', convert to 100000000000000000.",
].join(" ");
const SECRET_FIELD_PATTERN = /(key|secret|token|sessionKeyPrivate)/i;

function parseArgs(argv) {
  const args = {
    adapter: "smoke",
    prompt: "",
    system: "",
    model: "",
    baseUrl: "",
    apiKey: "",
    command: "",
    commandArgs: [],
    maxSteps: 6,
    trace: true,
    help: false,
    deployVault: false,
    createAgent: false,
    requestPayment: false,
    recipient: "",
    token: "",
    amount: "",
    taskId: "",
    reason: "",
    userId: "demo-user",
    label: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--adapter":
        args.adapter = argv[++index] ?? args.adapter;
        break;
      case "--prompt":
        args.prompt = argv[++index] ?? "";
        break;
      case "--system":
        args.system = argv[++index] ?? "";
        break;
      case "--model":
        args.model = argv[++index] ?? "";
        break;
      case "--base-url":
        args.baseUrl = argv[++index] ?? "";
        break;
      case "--api-key":
        args.apiKey = argv[++index] ?? "";
        break;
      case "--command":
        args.command = argv[++index] ?? "";
        break;
      case "--command-args":
        args.commandArgs = parseStringArray(argv[++index] ?? "[]");
        break;
      case "--max-steps": {
        const value = Number(argv[++index] ?? args.maxSteps);
        args.maxSteps = Number.isFinite(value) && value > 0 ? Math.floor(value) : args.maxSteps;
        break;
      }
      case "--deploy-vault":
        args.deployVault = true;
        break;
      case "--create-agent":
        args.createAgent = true;
        break;
      case "--request-payment":
        args.requestPayment = true;
        break;
      case "--recipient":
        args.recipient = argv[++index] ?? "";
        break;
      case "--token":
        args.token = argv[++index] ?? "";
        break;
      case "--amount":
        args.amount = argv[++index] ?? "";
        break;
      case "--task-id":
        args.taskId = argv[++index] ?? "";
        break;
      case "--reason":
        args.reason = argv[++index] ?? "";
        break;
      case "--user-id":
        args.userId = argv[++index] ?? args.userId;
        break;
      case "--label":
        args.label = argv[++index] ?? "";
        break;
      case "--no-trace":
        args.trace = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function parseStringArray(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return rawValue.split(" ").map((value) => value.trim()).filter(Boolean);
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const entries = {};
  const content = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of content) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    entries[match[1].trim()] = match[2].trim();
  }
  return entries;
}

function normalizePrivateKey(value) {
  if (!value || value === "your_private_key_here") return undefined;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function toBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function normalizeAdapter(value) {
  const normalized = (value || "smoke").toLowerCase();
  if (["smoke", "openai", "openai-compatible", "command"].includes(normalized)) {
    return normalized === "openai" ? "openai-compatible" : normalized;
  }
  throw new Error(`Unsupported adapter: ${value}`);
}

function buildChatEndpoint(baseUrl) {
  if (!baseUrl) {
    throw new Error("MODEL_BASE_URL or --base-url is required for the openai-compatible adapter");
  }
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function maskSecret(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 12) return "***redacted***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (!value || typeof value !== "object") {
    return SECRET_FIELD_PATTERN.test(key) ? maskSecret(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      SECRET_FIELD_PATTERN.test(entryKey) ? maskSecret(entryValue) : redactValue(entryValue, entryKey),
    ])
  );
}

function toTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function getTextContent(result) {
  const textPart = result.content?.find((item) => item.type === "text");
  return textPart?.text ?? "";
}

async function callJsonTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = getTextContent(result);
  if (!text) return { isError: result.isError ?? false };
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text, isError: result.isError ?? false };
  }
}

function requireEnvValue(env, key, reason) {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required: ${reason}`);
  }
  return value;
}

function buildDemoPrompt(args, runtimeEnv) {
  if (args.prompt) return args.prompt;

  const tasks = [
    "Inspect the configured Monad wallet setup using MCP tools.",
    "List the available wallet tools, inspect local agents, and summarize the current vault and reputation state.",
  ];

  if (args.deployVault) {
    tasks.push("If no usable vault exists, deploy a vault through the configured factory.");
  }
  if (args.createAgent) {
    tasks.push("Create a temporary demo agent and fetch its session information.");
  }
  if (args.requestPayment) {
    tasks.push("Execute one payment using the local wallet tools.");
    tasks.push(`Payment recipient: ${args.recipient}.`);
    tasks.push(`Payment token: ${args.token}.`);
    tasks.push(`Payment amount: ${args.amount}.`);
    tasks.push("If you create a new agent for this payment, restrict it to the provided recipient and token.");
  }

  tasks.push(`Current owner address: ${runtimeEnv.OWNER_ADDRESS || "unknown"}.`);
  tasks.push(`Current configured vault address: ${runtimeEnv.VAULT_ADDRESS || ZERO_ADDRESS}.`);
  tasks.push("Return a short operational summary with the exact tool actions you took.");
  return tasks.join(" ");
}

function buildSystemPrompt(args) {
  if (!args.system) return DEFAULT_SYSTEM_PROMPT;
  return `${DEFAULT_SYSTEM_PROMPT} ${args.system}`;
}

function printHelp() {
  console.log([
    "wallet-agent-demo.mjs",
    "",
    "Modes:",
    "  smoke                Direct MCP smoke test without an LLM (default)",
    "  openai-compatible    Any OpenAI-compatible model endpoint with tool calling",
    "  command              Any custom model adapter command over stdin/stdout JSON",
    "",
    "Examples:",
    "  pnpm demo:agent:mcp",
    "  pnpm demo:agent:mcp:create",
    '  node packages/mcp-server/examples/wallet-agent-demo.mjs --deploy-vault --create-agent --request-payment --recipient 0xRecipient --token 0xToken --amount 1000000 --reason "demo transfer"',
    '  node packages/mcp-server/examples/wallet-agent-demo.mjs --adapter openai-compatible --model gpt-4.1 --base-url https://api.openai.com/v1 --api-key sk-... --prompt "List wallet tools and check current vault status"',
    '  node packages/mcp-server/examples/wallet-agent-demo.mjs --adapter openai-compatible --model qwen2.5:14b --base-url http://127.0.0.1:11434/v1 --prompt "Create a temporary agent and summarize the result"',
    '  node packages/mcp-server/examples/wallet-agent-demo.mjs --adapter command --command node --command-args scripts/my-model-adapter.mjs --prompt "Inspect wallet state"',
    "",
    "Environment overrides:",
    "  MODEL_ADAPTER, MODEL_NAME, MODEL_BASE_URL, MODEL_API_KEY, MODEL_HEADERS, MODEL_COMMAND, MODEL_COMMAND_ARGS, MODEL_SYSTEM_PROMPT, AGENT_PROMPT, MODEL_MAX_STEPS",
  ].join("\n"));
}

async function callToolAndParse(client, name, args = {}) {
  const parsed = await callJsonTool(client, name, args);
  return {
    name,
    arguments: redactValue(args),
    result: redactValue(parsed),
  };
}

function buildExecutionContext(args, fileEnv, ownerKey) {
  return {
    ownerKey,
    ownerAddress: fileEnv.OWNER_ADDRESS || "",
    defaultRecipient: args.recipient || fileEnv.DEMO_RECIPIENT || "",
    defaultToken: args.token || fileEnv.DEMO_TOKEN || "",
    defaultAmount: args.amount || fileEnv.DEMO_AMOUNT || "",
    defaultTaskId: args.taskId || fileEnv.DEMO_TASK_ID || `demo-task-${Date.now()}`,
    defaultReason: args.reason || fileEnv.DEMO_REASON || "demo transfer",
    defaultUserId: args.userId || fileEnv.DEMO_USER_ID || "demo-user",
    defaultLabel: args.label || fileEnv.DEMO_AGENT_LABEL || `demo-agent-${Date.now()}`,
    lastAgentId: "",
    lastSessionKeyPrivate: "",
    lastSessionKeyAddress: "",
    lastVaultAddress: fileEnv.VAULT_ADDRESS || ZERO_ADDRESS,
  };
}

function requirePaymentContext(context) {
  if (!context.defaultRecipient || !context.defaultToken || !context.defaultAmount) {
    throw new Error("recipient, token, and amount are required for --request-payment (or set DEMO_RECIPIENT, DEMO_TOKEN, DEMO_AMOUNT)");
  }
}

function enrichToolArguments(name, providedArgs, context) {
  const nextArgs = { ...providedArgs };

  if (name === "deploy_vault" && !nextArgs.ownerKey && context.ownerKey) {
    nextArgs.ownerKey = context.ownerKey;
  }

  if (name === "create_agent") {
    if (!nextArgs.ownerKey && context.ownerKey) nextArgs.ownerKey = context.ownerKey;
    if (!nextArgs.agentType) nextArgs.agentType = "temporary";
    if (!nextArgs.userId) nextArgs.userId = context.defaultUserId;
    if (!nextArgs.label) nextArgs.label = context.defaultLabel;
    if (!nextArgs.allowedRecipients && context.defaultRecipient) {
      nextArgs.allowedRecipients = [context.defaultRecipient];
    }
    if (!nextArgs.allowedTokens && context.defaultToken) {
      nextArgs.allowedTokens = [context.defaultToken];
    }
  }

  if (name === "request_payment") {
    if (!nextArgs.agentId && context.lastAgentId) nextArgs.agentId = context.lastAgentId;
    if (!nextArgs.sessionKey && context.lastSessionKeyPrivate) nextArgs.sessionKey = context.lastSessionKeyPrivate;
    if (!nextArgs.taskId) nextArgs.taskId = context.defaultTaskId;
    if (!nextArgs.reason) nextArgs.reason = context.defaultReason;
    if (!nextArgs.recipient) nextArgs.recipient = context.defaultRecipient;
    if (!nextArgs.token) nextArgs.token = context.defaultToken;
    if (!nextArgs.amount) nextArgs.amount = context.defaultAmount;
  }

  if (name === "get_session_info" && !nextArgs.agentId && context.lastAgentId) {
    nextArgs.agentId = context.lastAgentId;
  }

  if (name === "get_user_vaults" && !nextArgs.userAddress && context.ownerAddress) {
    nextArgs.userAddress = context.ownerAddress;
  }

  if (name === "check_wallet_reputation" && !nextArgs.wallet && context.ownerAddress) {
    nextArgs.wallet = context.ownerAddress;
  }

  // ── Wallet connection & simplified transfer tools ──────────
  if (name === "connect_wallet" && !nextArgs.ownerKey && context.ownerKey) {
    nextArgs.ownerKey = context.ownerKey;
  }

  if (name === "send_transfer") {
    if (!nextArgs.ownerKey && context.ownerKey) nextArgs.ownerKey = context.ownerKey;
    if (!nextArgs.recipient && context.defaultRecipient) nextArgs.recipient = context.defaultRecipient;
    if (!nextArgs.token && context.defaultToken) nextArgs.token = context.defaultToken;
    if (!nextArgs.amount && context.defaultAmount) nextArgs.amount = context.defaultAmount;
    if (!nextArgs.reason) nextArgs.reason = context.defaultReason;
  }

  if (name === "get_wallet_balance" && !nextArgs.address && context.ownerAddress) {
    nextArgs.address = context.ownerAddress;
  }

  return nextArgs;
}

function updateExecutionContext(context, name, toolResult) {
  if (name === "deploy_vault" && toolResult?.vaultAddress) {
    context.lastVaultAddress = toolResult.vaultAddress;
  }
  if (name === "create_agent") {
    if (toolResult?.agentId) context.lastAgentId = toolResult.agentId;
    if (toolResult?.sessionKeyPrivate) context.lastSessionKeyPrivate = toolResult.sessionKeyPrivate;
    if (toolResult?.sessionKeyAddress) context.lastSessionKeyAddress = toolResult.sessionKeyAddress;
  }
  // Track results from wallet connection and transfer tools
  if (name === "connect_wallet" && toolResult?.walletAddress) {
    context.ownerAddress = toolResult.walletAddress;
    if (toolResult.vault?.address) {
      context.lastVaultAddress = toolResult.vault.address;
    }
  }
  if (name === "send_transfer") {
    if (toolResult?.vaultAddress) context.lastVaultAddress = toolResult.vaultAddress;
    if (toolResult?.agentId) context.lastAgentId = toolResult.agentId;
  }
}

function buildOpenAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: toTextContent(message.content),
      };
    }
    if (message.role === "assistant" && message.tool_calls) {
      return {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
      };
    }
    return {
      role: message.role,
      content: toTextContent(message.content),
    };
  });
}

async function runOpenAiCompatibleAgent(client, tools, runtime, prompt, executionContext) {
  const endpoint = buildChatEndpoint(runtime.baseUrl);
  const messages = [
    { role: "system", content: runtime.systemPrompt },
    { role: "user", content: prompt },
  ];
  const trace = [];

  for (let step = 0; step < runtime.maxSteps; step += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}),
        ...runtime.extraHeaders,
      },
      body: JSON.stringify({
        model: runtime.model,
        messages: buildOpenAiMessages(messages),
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const failureText = await response.text();
      throw new Error(`Model request failed (${response.status}): ${failureText}`);
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error("Model response did not contain choices[0].message");
    }

    const assistantText = toTextContent(message.content);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments ?? "{}",
          },
        }))
      : [];

    messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls,
    });

    if (toolCalls.length === 0) {
      return {
        mode: "model",
        adapter: runtime.adapter,
        model: runtime.model,
        prompt,
        finalResponse: assistantText,
        toolTrace: trace,
      };
    }

    for (const toolCall of toolCalls) {
      const rawToolArgs = JSON.parse(toolCall.function.arguments || "{}");
      const toolArgs = enrichToolArguments(toolCall.function.name, rawToolArgs, executionContext);
      const toolOutput = await callJsonTool(client, toolCall.function.name, toolArgs);
      updateExecutionContext(executionContext, toolCall.function.name, toolOutput);
      const toolResult = {
        name: toolCall.function.name,
        arguments: redactValue(toolArgs),
        result: redactValue(toolOutput),
      };
      trace.push(toolResult);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolOutput),
      });
    }
  }

  return {
    mode: "model",
    adapter: runtime.adapter,
    model: runtime.model,
    prompt,
    finalResponse: "Model loop stopped because max steps were reached before a final answer was returned.",
    toolTrace: trace,
    stoppedReason: "max_steps",
  };
}

async function runCommandModelAdapter(runtime, tools, messages) {
  return await new Promise((resolve, reject) => {
    const child = spawn(runtime.command, runtime.commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Model adapter command exited with code ${code}: ${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Failed to parse model adapter JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify({
      model: runtime.model || null,
      systemPrompt: runtime.systemPrompt,
      messages,
      tools,
      repoRoot,
    }));
    child.stdin.end();
  });
}

async function runCommandAgent(client, tools, runtime, prompt, executionContext) {
  const messages = [
    { role: "system", content: runtime.systemPrompt },
    { role: "user", content: prompt },
  ];
  const trace = [];

  for (let step = 0; step < runtime.maxSteps; step += 1) {
    const response = await runCommandModelAdapter(runtime, tools, messages);
    const assistantText = toTextContent(response.content ?? response.output ?? "");
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];

    messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        },
      })),
    });

    if (toolCalls.length === 0) {
      return {
        mode: "model",
        adapter: runtime.adapter,
        model: runtime.model || runtime.command,
        prompt,
        finalResponse: assistantText,
        toolTrace: trace,
      };
    }

    for (const toolCall of toolCalls) {
      const toolArgs = enrichToolArguments(toolCall.name, toolCall.arguments ?? {}, executionContext);
      const toolOutput = await callJsonTool(client, toolCall.name, toolArgs);
      updateExecutionContext(executionContext, toolCall.name, toolOutput);
      const toolResult = {
        name: toolCall.name,
        arguments: redactValue(toolArgs),
        result: redactValue(toolOutput),
      };
      trace.push(toolResult);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolOutput),
      });
    }
  }

  return {
    mode: "model",
    adapter: runtime.adapter,
    model: runtime.model || runtime.command,
    prompt,
    finalResponse: "Command adapter loop stopped because max steps were reached before a final answer was returned.",
    toolTrace: trace,
    stoppedReason: "max_steps",
  };
}

async function runSmokeDemo(client, args, runtimeEnv, ownerKey) {
  const tools = await client.listTools();
  const output = {
    mode: "smoke",
    flags: {
      deployVault: args.deployVault,
      createAgent: args.createAgent,
    },
    config: {
      network: runtimeEnv.MONAD_NETWORK,
      vaultAddress: runtimeEnv.VAULT_ADDRESS,
      factoryAddress: runtimeEnv.FACTORY_ADDRESS || null,
      registryAddress: runtimeEnv.REGISTRY_ADDRESS || null,
      ownerAddress: runtimeEnv.OWNER_ADDRESS || null,
    },
    tools: tools.tools.map((tool) => tool.name),
    checks: {},
  };

  if (runtimeEnv.OWNER_ADDRESS && runtimeEnv.FACTORY_ADDRESS) {
    output.checks.userVaults = redactValue(await callJsonTool(client, "get_user_vaults", {
      userAddress: runtimeEnv.OWNER_ADDRESS,
    }));
  }

  if (runtimeEnv.OWNER_ADDRESS && runtimeEnv.REGISTRY_ADDRESS) {
    output.checks.ownerReputation = redactValue(await callJsonTool(client, "check_wallet_reputation", {
      wallet: runtimeEnv.OWNER_ADDRESS,
    }));
  }

  output.checks.localAgents = redactValue(await callJsonTool(client, "list_agents", {}));

  if (args.deployVault) {
    requireEnvValue(runtimeEnv, "FACTORY_ADDRESS", "deploy_vault requires FACTORY_ADDRESS");
    output.deployedVault = redactValue(await callJsonTool(client, "deploy_vault", {
      ownerKey,
    }));
    if (output.deployedVault?.vaultAddress) {
      output.config.vaultAddress = output.deployedVault.vaultAddress;
    }
  }

  let createdAgentRaw;
  if (args.createAgent || args.requestPayment) {
    if (args.requestPayment) {
      requirePaymentContext({
        defaultRecipient: args.recipient,
        defaultToken: args.token,
        defaultAmount: args.amount,
      });
    }

    createdAgentRaw = await callJsonTool(client, "create_agent", {
      label: args.label || `demo-agent-${Date.now()}`,
      agentType: "temporary",
      userId: args.userId || "demo-user",
      ownerKey,
      allowedRecipients: args.recipient ? [args.recipient] : undefined,
      allowedTokens: args.token ? [args.token] : undefined,
    });
    output.createdAgent = redactValue(createdAgentRaw);
    if (createdAgentRaw?.agentId) {
      output.sessionInfo = redactValue(await callJsonTool(client, "get_session_info", {
        agentId: createdAgentRaw.agentId,
      }));
    }
  }

  if (args.requestPayment) {
    const paymentResult = await callJsonTool(client, "request_payment", {
      agentId: createdAgentRaw?.agentId,
      taskId: args.taskId || `demo-task-${Date.now()}`,
      reason: args.reason || "demo transfer",
      recipient: args.recipient,
      token: args.token,
      amount: args.amount,
      sessionKey: createdAgentRaw?.sessionKeyPrivate,
    });
    output.payment = redactValue(paymentResult);
  }

  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const envFromExample = loadEnvFile(path.join(repoRoot, ".env.example"));
  const envFromLocal = loadEnvFile(path.join(repoRoot, ".env"));
  const fileEnv = { ...envFromExample, ...envFromLocal };
  const ownerKey = normalizePrivateKey(fileEnv.OWNER_PRIVATE_KEY);
  const adapter = normalizeAdapter(args.adapter || fileEnv.MODEL_ADAPTER || "smoke");
  const executionContext = buildExecutionContext(args, fileEnv, ownerKey);

  if ((args.deployVault || args.createAgent || args.requestPayment) && !ownerKey) {
    throw new Error("OWNER_PRIVATE_KEY must be set in .env for --deploy-vault or --create-agent");
  }

  if (args.requestPayment) {
    requirePaymentContext(executionContext);
  }

  const modelRuntime = {
    adapter,
    model: args.model || fileEnv.MODEL_NAME || "",
    baseUrl: args.baseUrl || fileEnv.MODEL_BASE_URL || "",
    apiKey: args.apiKey || fileEnv.MODEL_API_KEY || "",
    extraHeaders: (() => {
      if (!fileEnv.MODEL_HEADERS) return {};
      try {
        return JSON.parse(fileEnv.MODEL_HEADERS);
      } catch {
        throw new Error("MODEL_HEADERS must be valid JSON");
      }
    })(),
    command: args.command || fileEnv.MODEL_COMMAND || "",
    commandArgs: args.commandArgs.length > 0 ? args.commandArgs : parseStringArray(fileEnv.MODEL_COMMAND_ARGS || "[]"),
    maxSteps: args.maxSteps || Number(fileEnv.MODEL_MAX_STEPS || 6),
    systemPrompt: buildSystemPrompt({
      ...args,
      system: args.system || fileEnv.MODEL_SYSTEM_PROMPT || "",
    }),
  };

  if (adapter !== "smoke" && !modelRuntime.model && adapter === "openai-compatible") {
    throw new Error("MODEL_NAME or --model is required for the openai-compatible adapter");
  }

  if (adapter === "command" && !modelRuntime.command) {
    throw new Error("MODEL_COMMAND or --command is required for the command adapter");
  }

  const runtimeEnv = {
    ...process.env,
    MONAD_NETWORK: fileEnv.MONAD_NETWORK || "monad-testnet",
    MONAD_RPC_URL: fileEnv.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
    VAULT_ADDRESS: fileEnv.VAULT_ADDRESS && fileEnv.VAULT_ADDRESS !== "0x..."
      ? fileEnv.VAULT_ADDRESS
      : ZERO_ADDRESS,
    FACTORY_ADDRESS: fileEnv.FACTORY_ADDRESS || "",
    REGISTRY_ADDRESS: fileEnv.REGISTRY_ADDRESS || "",
    OWNER_ADDRESS: fileEnv.OWNER_ADDRESS || "",
    DB_PATH: path.join(os.tmpdir(), "monad-agent-pay-wallet-agent-demo.db"),
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, "dist", "server.js")],
    cwd: repoRoot,
    env: runtimeEnv,
    stderr: "inherit",
  });

  const client = new Client(
    { name: "wallet-agent-demo", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    let output;

    if (adapter === "smoke") {
      output = await runSmokeDemo(client, args, runtimeEnv, ownerKey);
    } else {
      const tools = await client.listTools();
      const prompt = buildDemoPrompt({
        ...args,
        prompt: args.prompt || fileEnv.AGENT_PROMPT || "",
      }, runtimeEnv);
      const executionRuntime = {
        ...modelRuntime,
        adapter,
      };

      output = adapter === "command"
        ? await runCommandAgent(client, tools.tools, executionRuntime, prompt, executionContext)
        : await runOpenAiCompatibleAgent(client, tools.tools, executionRuntime, prompt, executionContext);

      output.config = redactValue({
        network: runtimeEnv.MONAD_NETWORK,
        vaultAddress: runtimeEnv.VAULT_ADDRESS,
        factoryAddress: runtimeEnv.FACTORY_ADDRESS || null,
        registryAddress: runtimeEnv.REGISTRY_ADDRESS || null,
        ownerAddress: runtimeEnv.OWNER_ADDRESS || null,
      });
      if (!args.trace) {
        delete output.toolTrace;
      }
    }

    console.log(JSON.stringify(redactValue(output), null, 2));
  } finally {
    await transport.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});