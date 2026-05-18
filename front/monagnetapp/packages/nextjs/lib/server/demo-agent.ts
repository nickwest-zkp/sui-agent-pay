import { randomUUID } from "crypto";

type ParsedTransferInstruction = {
  recipient: string;
  amountInput: string;
  amount: string;
  reason: string;
};

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
  const combined = `${normalizedWhole}${normalizedFraction}`.replace(/^0+(?=\d)/, "") || "0";
  return combined;
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

export function parseTransferInstruction(instruction: string, decimals: number): ParsedTransferInstruction {
  const normalized = normalizeInstruction(instruction);
  if (!normalized) {
    throw new Error("Instruction is empty");
  }

  const recipient = extractRecipient(normalized);
  const amountInput = extractAmountInput(normalized);

  return {
    recipient,
    amountInput,
    amount: parseAmountInput(amountInput, decimals),
    reason: normalized,
  };
}

export function buildDemoAgentTrace(args: {
  instruction: string;
  parsed: ParsedTransferInstruction;
  agentId: string;
}) {
  return [
    {
      step: 1,
      type: "planner",
      message: `Received instruction: ${args.instruction}`,
    },
    {
      step: 2,
      type: "skill",
      message: `Wallet skill parsed recipient=${args.parsed.recipient} amount=${args.parsed.amountInput}`,
    },
    {
      step: 3,
      type: "tool",
      message: `Calling runtime payment for agentId=${args.agentId}`,
    },
  ];
}

export function createTaskId() {
  return randomUUID();
}
