import { randomUUID } from "crypto";

type ParsedTransferInstruction = {
  kind: "payment";
  recipient: string;
  amountInput: string;
  amount: string;
  reason: string;
};

type ContractCallArgumentInput = {
  kind: "object" | "address" | "u64" | "string" | "bool";
  value: string | boolean;
};

type ParsedContractCallInstruction = {
  kind: "contract_call";
  packageId: string;
  module: string;
  functionName: string;
  typeArguments: string[];
  arguments: ContractCallArgumentInput[];
  target: string;
  reason: string;
};

type ParsedDeepBookSwapInstruction = {
  kind: "deepbook_swap";
  inputSymbol: string;
  outputSymbol: string;
  amountInput: string;
  amount: string;
  reason: string;
};

export type ParsedAgentInstruction =
  | ParsedTransferInstruction
  | ParsedContractCallInstruction
  | ParsedDeepBookSwapInstruction;

function parseAmountInput(value: string, decimals: number) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Amount is missing");
  }

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Amount format is invalid");
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount supports at most ${decimals} decimal places`);
  }

  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return `${normalizedWhole}${normalizedFraction}`.replace(/^0+(?=\d)/, "") || "0";
}

function normalizeInstruction(instruction: string) {
  return instruction
    .trim()
    .replace(/[,;!]/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ");
}

function extractRecipient(normalized: string) {
  const addressMatches = [...normalized.matchAll(/0x[a-fA-F0-9]{2,64}/g)].map(match => match[0]);
  if (addressMatches.length === 0) {
    throw new Error("Could not find a recipient address in the instruction");
  }

  return addressMatches.find(address => new RegExp(`(?:to|for)\\s*${address}`, "i").test(normalized)) ?? addressMatches[0];
}

function extractAmountInput(normalized: string) {
  const patterns = [
    /(?:pay|send|transfer|tip|charge)\s+(\d+(?:\.\d+)?)\s*(?:sui)?/i,
    /(\d+(?:\.\d+)?)\s*(?:sui)?\s+(?:to|for)\b/i,
    /(?:amount)\s*(?:is|=|:)?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const numericMatches = [...normalized.matchAll(/(^|[^\w.])(\d+(?:\.\d+)?)(?=$|[^\w.])/g)]
    .map(match => match[2])
    .filter(Boolean);

  if (numericMatches.length === 0) {
    throw new Error("Could not find an amount in the instruction");
  }

  return numericMatches[0];
}

function parseJsonArray(raw: string, fieldName: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("JSON array")) {
      throw error;
    }
    throw new Error(`${fieldName} must be valid JSON`);
  }
}

function extractBracketArray(source: string, marker: RegExp, fieldName: string): string[] | ContractCallArgumentInput[] {
  const match = marker.exec(source);
  if (!match?.[1]) {
    return [];
  }

  return parseJsonArray(match[1], fieldName) as string[] | ContractCallArgumentInput[];
}

function parseContractCallInstruction(instruction: string): ParsedContractCallInstruction | null {
  const trimmed = instruction.trim();
  if (!trimmed) {
    throw new Error("Instruction is empty");
  }

  const targetMatch =
    trimmed.match(/(?:^|\b)(?:call|invoke|execute)\s+(0x[a-fA-F0-9]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)(?:\b|$)/i) ??
    trimmed.match(/^(0x[a-fA-F0-9]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)(?:\b|$)/);

  if (!targetMatch) {
    return null;
  }

  const [, packageId, module, functionName] = targetMatch;
  const typeArguments = extractBracketArray(
    trimmed,
    /type\s*args?\s*(?:=|:)?\s*(\[[\s\S]*?\])(?=\s+(?:with\s+)?args?\b|$)/i,
    "type arguments",
  ) as string[];
  const args = extractBracketArray(
    trimmed,
    /(?:^|\s)(?:with\s+)?args?\s*(?:=|:)?\s*(\[[\s\S]*\])$/i,
    "contract arguments",
  ) as ContractCallArgumentInput[];

  return {
    kind: "contract_call",
    packageId,
    module,
    functionName,
    typeArguments,
    arguments: args,
    target: `${packageId}::${module}::${functionName}`,
    reason: trimmed,
  };
}

function parseDeepBookSwapInstruction(instruction: string, decimals: number): ParsedDeepBookSwapInstruction | null {
  const normalized = normalizeInstruction(instruction);
  if (!normalized) {
    throw new Error("Instruction is empty");
  }

  const match = normalized.match(
    /(?:swap|convert|exchange)\s+(\d+(?:\.\d+)?)\s+([a-zA-Z0-9]+)\s+(?:to|for|into)\s+([a-zA-Z0-9]+)(?:\s+(?:via|on)\s+deepbook)?/i,
  );
  if (!match) {
    return null;
  }

  const [, amountInput, inputSymbol, outputSymbol] = match;
  if (!/deepbook/i.test(normalized) && !/^swap\b/i.test(normalized)) {
    return null;
  }

  return {
    kind: "deepbook_swap",
    inputSymbol: inputSymbol.toUpperCase(),
    outputSymbol: outputSymbol.toUpperCase(),
    amountInput,
    amount: parseAmountInput(amountInput, decimals),
    reason: normalized,
  };
}

function parseTransferInstruction(instruction: string, decimals: number): ParsedTransferInstruction {
  const normalized = normalizeInstruction(instruction);
  if (!normalized) {
    throw new Error("Instruction is empty");
  }

  return {
    kind: "payment",
    recipient: extractRecipient(normalized),
    amountInput: extractAmountInput(normalized),
    amount: parseAmountInput(extractAmountInput(normalized), decimals),
    reason: normalized,
  };
}

export function parseAgentInstruction(instruction: string, decimals: number): ParsedAgentInstruction {
  const contractCall = parseContractCallInstruction(instruction);
  if (contractCall) return contractCall;

  const deepBookSwap = parseDeepBookSwapInstruction(instruction, decimals);
  if (deepBookSwap) return deepBookSwap;

  return parseTransferInstruction(instruction, decimals);
}

export function buildDemoAgentTrace(args: {
  instruction: string;
  parsed: ParsedAgentInstruction;
  agentId: string;
}) {
  if (args.parsed.kind === "deepbook_swap") {
    return [
      { step: 1, type: "planner", message: `Received instruction: ${args.instruction}` },
      {
        step: 2,
        type: "skill",
        message: `Wallet skill parsed DeepBook swap ${args.parsed.amountInput} ${args.parsed.inputSymbol} -> ${args.parsed.outputSymbol}`,
      },
      { step: 3, type: "tool", message: `Calling runtime DeepBook swap for agentId=${args.agentId}` },
    ];
  }

  if (args.parsed.kind === "contract_call") {
    return [
      { step: 1, type: "planner", message: `Received instruction: ${args.instruction}` },
      {
        step: 2,
        type: "skill",
        message: `Wallet skill parsed contract target=${args.parsed.target} typeArgs=${args.parsed.typeArguments.length} args=${args.parsed.arguments.length}`,
      },
      { step: 3, type: "tool", message: `Calling runtime contract call for agentId=${args.agentId}` },
    ];
  }

  return [
    { step: 1, type: "planner", message: `Received instruction: ${args.instruction}` },
    {
      step: 2,
      type: "skill",
      message: `Wallet skill parsed recipient=${args.parsed.recipient} amount=${args.parsed.amountInput}`,
    },
    { step: 3, type: "tool", message: `Calling runtime payment for agentId=${args.agentId}` },
  ];
}

export function createTaskId() {
  return randomUUID();
}
