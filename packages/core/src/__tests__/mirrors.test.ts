/**
 * Core ↔ web mirror lockstep guard (review debt D11).
 *
 * `apps/web` cannot import `@roam/core` — Turbopack can't resolve core's `.js`-suffixed Node-ESM
 * internals in the browser bundle — so a handful of `apps/web/src/lib/*` files hand-mirror core
 * constants and are "kept in step by contract, not by import". Nothing asserted that contract, so a
 * change to a core constant that wasn't hand-copied into its web mirror drifted silently and only
 * surfaced as wrong behaviour in the browser (a missing category filter, a mislabeled group).
 *
 * This test closes that gap for the pairs where the web file is a VERBATIM literal mirror of a core
 * export. It reads the web mirror's source text (rather than importing it — the web file pulls in
 * `next-intl`, and importing `apps/web` into a core test would also couple core's typecheck to the
 * web tsconfig) and compares the extracted literal against the core export. A genuine drift fails
 * the build; reformatting/whitespace/comment changes do not.
 *
 * Adding a pair: give `MIRRORS` the core array and the `{ file, exportName }` of its web twin. Only
 * add pairs that are TRUE 1:1 literal mirrors — several web `lib/*` files are hand-curated
 * supersets/reshapes of core data, not verbatim copies, and asserting deep-equality on those would
 * be a false alarm, not a guard.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CATEGORIES } from "../places/index.js";

/** Walk up from this test file until the workspace root (the dir holding pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("mirrors.test: could not locate the workspace root (pnpm-workspace.yaml)");
}

/**
 * Extract the ordered list of quoted string literals from `export const <name> = [ ... ]` in a
 * source file. Tolerant of single/double quotes, trailing commas, `as const`, and line comments;
 * throws (rather than returning []) if the export can't be found, so a rename is a loud failure.
 */
function extractStringArray(fileText: string, exportName: string): string[] {
  const start = fileText.search(new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*\\[`));
  if (start === -1) throw new Error(`mirrors.test: export const ${exportName} = [ … ] not found`);
  const open = fileText.indexOf("[", start);
  const close = fileText.indexOf("]", open);
  if (open === -1 || close === -1) throw new Error(`mirrors.test: unterminated array for ${exportName}`);
  const body = fileText.slice(open + 1, close);
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

const ROOT = repoRoot();

interface MirrorPair {
  name: string;
  core: readonly string[];
  webFile: string; // repo-relative
  webExport: string;
}

const MIRRORS: MirrorPair[] = [
  {
    name: "category groups (core CATEGORIES ↔ web CATEGORY_GROUPS)",
    core: CATEGORIES,
    webFile: "apps/web/src/lib/categories.ts",
    webExport: "CATEGORY_GROUPS",
  },
];

describe("core ↔ web mirror lockstep (D11)", () => {
  it.each(MIRRORS)("$name stays in step", ({ core, webFile, webExport }) => {
    const text = readFileSync(join(ROOT, webFile), "utf8");
    const web = extractStringArray(text, webExport);
    // Order matters (these lists drive ordered UI), so compare as ordered arrays.
    expect(web).toEqual([...core]);
  });

  it("the extractor itself is honest (fails loudly on a missing export)", () => {
    expect(() => extractStringArray("const x = 1;", "NOPE")).toThrow(/not found/);
  });
});
