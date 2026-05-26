import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const sourceDir = path.join(workspaceRoot, "packages", "nextjs", ".next");
const targetDir = path.join(workspaceRoot, ".next");

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Next.js build output not found at ${sourceDir}`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });
