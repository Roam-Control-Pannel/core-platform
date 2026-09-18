#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SUPABASE_VERSION = "2.117.0";
const CONSOLIDATED_VERSIONS = ["0001", "0002", "0003", "0004", "0005", "0006"];
const RETIRED_VERSIONS = Array.from({ length: 109 }, (_, index) => index + 7)
  .filter((version) => version !== 21)
  .map((version) => String(version).padStart(4, "0"));

function usage() {
  console.log(`Usage:
  node scripts/reconcile-pre-f2g-migration-history.mjs --local [--apply --backup-file /absolute/path.sql]

  node scripts/reconcile-pre-f2g-migration-history.mjs \\
    --project-ref <ref> \\
    --confirm-project-ref <same-ref> \\
    --schema-equivalence-confirmed \\
    [--apply --backup-file /absolute/path.sql]

Without --apply, the script only validates the repository and prints the plan.

This script changes only supabase_migrations.schema_migrations. It never copies,
deletes, or rewrites application-table data.`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    local: false,
    schemaEquivalenceConfirmed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--apply") options.apply = true;
    else if (argument === "--local") options.local = true;
    else if (argument === "--schema-equivalence-confirmed") {
      options.schemaEquivalenceConfirmed = true;
    } else if (
      argument === "--project-ref" ||
      argument === "--confirm-project-ref" ||
      argument === "--backup-file"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
      options[argument.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function validateRepository() {
  const migrationDirectory = resolve("supabase/migrations");
  const preF2gVersions = readdirSync(migrationDirectory)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => file.split("_", 1)[0])
    .filter((version) => Number(version) < 116)
    .sort();

  if (preF2gVersions.join(",") !== CONSOLIDATED_VERSIONS.join(",")) {
    fail(
      `expected exactly ${CONSOLIDATED_VERSIONS.join(", ")} below 0116; found ${preF2gVersions.join(", ")}`,
    );
  }
}

function runSupabase(arguments_) {
  const result = spawnSync(
    "pnpm",
    ["dlx", `supabase@${SUPABASE_VERSION}`, ...arguments_],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PNPM_CONFIG_PM_ON_FAIL: "ignore" },
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    fail(`Supabase CLI exited with status ${result.status}: ${arguments_.join(" ")}`);
  }

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const options = parseArgs(process.argv.slice(2));
validateRepository();

if (options.local === Boolean(options.projectRef)) {
  fail("choose exactly one target: --local or --project-ref <ref>");
}

if (options.projectRef && options.apply) {
  if (options.confirmProjectRef !== options.projectRef) {
    fail("--confirm-project-ref must exactly match --project-ref");
  }
  if (!options.schemaEquivalenceConfirmed) {
    fail("remote repair requires --schema-equivalence-confirmed");
  }
}

const targetArguments = options.local
  ? ["--local"]
  : ["--project-ref", options.projectRef];
const targetLabel = options.local ? "local disposable database" : `project ${options.projectRef}`;

console.log(`Target: ${targetLabel}`);
console.log("Plan:");
console.log(`  1. Back up supabase_migrations.schema_migrations.`);
console.log(`  2. Mark retired versions 0007–0115 (except unused 0021) reverted.`);
console.log(`  3. Mark consolidated versions ${CONSOLIDATED_VERSIONS.join(", ")} applied.`);
console.log("  4. Prove db push has no pending migrations.");
console.log("Application schemas and table data are not modified.");

if (!options.apply) {
  console.log("Dry run only. Re-run with --apply and --backup-file to execute.");
  process.exit(0);
}

if (!options.backupFile) fail("--apply requires --backup-file");
if (!isAbsolute(options.backupFile)) fail("--backup-file must be an absolute path outside the repository");
const relativeBackupPath = relative(process.cwd(), options.backupFile);
if (!relativeBackupPath.startsWith("..") && !isAbsolute(relativeBackupPath)) {
  fail("--backup-file must be outside the repository");
}
if (existsSync(options.backupFile)) fail(`backup file already exists: ${options.backupFile}`);

runSupabase([
  "db",
  "dump",
  ...targetArguments,
  "--schema",
  "supabase_migrations",
  "--data-only",
  "--use-copy",
  "--file",
  options.backupFile,
]);

if (!existsSync(options.backupFile) || statSync(options.backupFile).size === 0) {
  fail("migration-ledger backup was not created or is empty; no repair was attempted");
}

console.log(`Migration-ledger backup: ${options.backupFile}`);
runSupabase(["migration", "list", ...targetArguments]);
runSupabase([
  "migration",
  "repair",
  ...targetArguments,
  "--status",
  "reverted",
  ...RETIRED_VERSIONS,
  "--yes",
]);
runSupabase([
  "migration",
  "repair",
  ...targetArguments,
  "--status",
  "applied",
  ...CONSOLIDATED_VERSIONS,
  "--yes",
]);
runSupabase(["migration", "list", ...targetArguments]);

const dryRunOutput = runSupabase(["db", "push", ...targetArguments, "--dry-run"]);
if (!dryRunOutput.includes('"upToDate":true') || !dryRunOutput.includes('"migrations":[]')) {
  fail("ledger repair completed, but db push still reports pending work; inspect the backup and migration list");
}

console.log(`Migration history reconciled for ${targetLabel}; application data was preserved.`);
