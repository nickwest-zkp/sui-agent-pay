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

const nftFiles = [];

function collectNftFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectNftFiles(fullPath);
      continue;
    }

    if (entry.name.endsWith(".nft.json")) {
      nftFiles.push(fullPath);
    }
  }
}

collectNftFiles(targetDir);

for (const nftFile of nftFiles) {
  const raw = fs.readFileSync(nftFile, "utf8");
  const manifest = JSON.parse(raw);
  const relativeNftPath = path.relative(targetDir, nftFile);
  const sourceNftFile = path.join(sourceDir, relativeNftPath);
  const sourceNftDir = path.dirname(sourceNftFile);
  const targetNftDir = path.dirname(nftFile);

  if (Array.isArray(manifest.files)) {
    manifest.files = manifest.files.map(file => {
      if (typeof file !== "string") {
        return file;
      }

      const sourceFile = path.resolve(sourceNftDir, file);
      const targetFile = sourceFile.startsWith(sourceDir + path.sep)
        ? path.join(targetDir, path.relative(sourceDir, sourceFile))
        : sourceFile;

      return path.relative(targetNftDir, targetFile).replaceAll(path.sep, "/");
    });
  }

  fs.writeFileSync(nftFile, `${JSON.stringify(manifest)}\n`);
}
