// Flat ESLint config for @roam/native — consumes the shared base preset
// (pure TS rules, no Next/DOM assumptions, correct for a React Native app).
// One source of lint truth (@roam/eslint-config); this file points at it and
// adds RN/Expo-specific ignores + a CommonJS override for Node config files.
import base from "@roam/eslint-config/base";
import globals from "globals";

export default [
  ...base,
  {
    ignores: [
      ".expo/**",
      "ios/**",
      "android/**",
      "dist/**",
      "web-build/**",
      "expo-env.d.ts",
      "scripts/**",
    ],
  },
  {
    // Build-config files (metro.config.js, etc.) are CommonJS Node modules,
    // not app source — require()/module/__dirname are correct here.
    files: ["*.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
