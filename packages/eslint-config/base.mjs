// @roam/eslint-config/base — the shared TypeScript flat-config preset.
//
// One source of lint truth, consumed by every workspace (the same principle
// that makes @roam/core the one source of domain truth). This is the BASE layer:
// pure-TS rules with no React/Next assumptions. The `next` preset extends it.
//
// Pragmatic-but-strict by intent: real-bug rules are errors; stylistic noise is
// left to the formatter. tsconfig.base.json already enforces the hard type rules
// (noUnusedLocals, exactOptionalPropertyTypes, etc.) at typecheck time, so eslint
// here targets what the compiler can't see, not what it already catches.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const base = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

export default base;
