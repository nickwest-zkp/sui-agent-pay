import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const nextTypesDir = path.join(".next", "types");
const typecheckCommand = "pnpm exec tsc --noEmit";
const buildCommand = "node ./node_modules/.ignored/next/dist/bin/next build";

const run = command =>
  execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const ensureGeneratedTypes = () =>
  execSync(buildCommand, {
    stdio: "inherit",
  });

if (!existsSync(nextTypesDir)) {
  ensureGeneratedTypes();
}

try {
  run(typecheckCommand);
} catch (error) {
  const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;

  if (!output.includes(".next/types/")) {
    process.stderr.write(output);
    process.exit(1);
  }

  ensureGeneratedTypes();

  try {
    run(typecheckCommand);
  } catch (retryError) {
    process.stderr.write(`${retryError.stdout ?? ""}\n${retryError.stderr ?? ""}`);
    process.exit(1);
  }
}
