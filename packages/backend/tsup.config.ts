import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["api/index.ts"],
  platform: "node",
  target: "node20",
  format: ["cjs"],
  outDir: "api-dist",
  clean: true,
  noExternal: ["@sui-agent-pay/sdk"],
  external: ["better-sqlite3"],
});
