import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(
  new URL("../packages/db/src/generated/database.types.ts", import.meta.url),
);
const checkOnly = process.argv.includes("--check");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");

if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  process.exit(2);
}

const generatorArgs = [
  "gen",
  "types",
  "typescript",
  "--local",
  "--schema",
  "public",
];
const spawnOptions = {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
};

let generated = spawnSync("supabase", generatorArgs, spawnOptions);
if (
  generated.error?.code === "ENOENT" ||
  generated.error?.code === "EACCES"
) {
  console.error(
    "Supabase CLI is not installed; using the repository-pinned CLI via pnpm dlx.",
  );
  generated = spawnSync(
    "pnpm",
    ["dlx", "supabase@2.117.0", ...generatorArgs],
    {
      ...spawnOptions,
      env: { ...process.env, PNPM_CONFIG_PM_ON_FAIL: "ignore" },
    },
  );
}

if (generated.stderr) process.stderr.write(generated.stderr);

if (generated.error) {
  console.error(`Failed to run Supabase CLI: ${generated.error.message}`);
  process.exit(1);
}

if (generated.status !== 0) {
  console.error(`Supabase type generation exited with status ${generated.status}.`);
  process.exit(generated.status ?? 1);
}

if (!generated.stdout.includes("export type Database")) {
  console.error("Supabase returned an invalid database type definition; file not changed.");
  process.exit(1);
}

const generatedTypes = `${generated.stdout.trimEnd()}\n`;

if (checkOnly) {
  const checkedIn = readFileSync(outputPath, "utf8");
  if (checkedIn !== generatedTypes) {
    console.error(
      "Generated database types are stale. Run `pnpm db:types` after `supabase db reset`, then commit the result.",
    );
    process.exit(1);
  }

  console.log("Generated database types match the local schema.");
} else {
  writeFileSync(outputPath, generatedTypes);
  console.log(`Generated database types at ${outputPath}.`);
}
