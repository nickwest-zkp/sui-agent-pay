const path = require("path");

const buildNextEslintCommand = (filenames) =>
  `pnpm --dir packages/nextjs exec eslint --fix ${filenames
    .map((f) => path.relative(path.join("packages", "nextjs"), f))
    .join(" ")}`;

const checkTypesNextCommand = () => "pnpm --dir packages/nextjs check-types";

module.exports = {
  "packages/nextjs/**/*.{ts,tsx}": [
    buildNextEslintCommand,
    checkTypesNextCommand,
  ],
};
