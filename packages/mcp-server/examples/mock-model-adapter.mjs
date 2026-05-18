#!/usr/bin/env node

import process from "node:process";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function extractLastToolResult(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "tool") {
      try {
        return JSON.parse(messages[index].content ?? "{}");
      } catch {
        return { raw: messages[index].content ?? "" };
      }
    }
  }
  return null;
}

const request = JSON.parse(await readStdin() || "{}");
const messages = Array.isArray(request.messages) ? request.messages : [];
const hasToolResult = messages.some((message) => message?.role === "tool");

if (!hasToolResult) {
  process.stdout.write(JSON.stringify({
    content: "I will inspect the local agent registry first.",
    toolCalls: [
      {
        id: "mock-list-agents",
        name: "list_agents",
        arguments: {},
      },
    ],
  }));
  process.exit(0);
}

const lastToolResult = extractLastToolResult(messages);
const totalAgents = Array.isArray(lastToolResult) ? lastToolResult.length : 0;
process.stdout.write(JSON.stringify({
  content: `Command adapter demo completed. MCP returned ${totalAgents} local agents.`,
  toolCalls: [],
}));
