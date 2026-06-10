// Flat ESLint config for @roam/native — consumes the shared base preset
// (pure TS rules, no Next/DOM assumptions, correct for a React Native app).
// One source of lint truth (@roam/eslint-config); this file points at it and
// adds RN/Expo-specific ignores for generated output.
import base from "@roam/eslint-config/base";

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
];
