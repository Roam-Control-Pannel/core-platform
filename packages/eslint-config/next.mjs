// @roam/eslint-config/next — the Next.js + React preset.
//
// Extends the shared base (TS rules, ignores) and layers on what the consumer
// surfaces need: React Hooks correctness + Next's own plugin. Consumed by
// apps/web and apps/console; the pure-TS packages use ./base directly.
//
// This replaces `next lint` (deprecated in Next 16) with the ESLint CLI + flat
// config — the forward path, and the one that lets every workspace lint through
// the same single binary and the same shared truth.
import { base } from "./base.mjs";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export const next = [
  ...base,
  {
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
];

export default next;
