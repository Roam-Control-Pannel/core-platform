#!/usr/bin/env node
/**
 * apple-client-secret.mjs — generate the "Sign in with Apple" client secret (a signed JWT).
 *
 * Supabase's Apple provider needs a client secret that is NOT a static string: it's a short-lived
 * ES256 JWT you sign with the .p8 key you downloaded from the Apple Developer portal. Apple caps
 * its lifetime at 6 months, so this has to be regenerated periodically (set a calendar reminder).
 *
 * This script is DEPENDENCY-FREE (Node's built-in `crypto` only) and runs entirely on your machine
 * — the .p8 private key is read locally and never leaves your computer. Nothing is sent anywhere.
 *
 * Usage (from the repo root, with the .p8 you downloaded):
 *
 *   node scripts/apple-client-secret.mjs \
 *     --team-id C89J4TDK6E \
 *     --client-id com.roamlocal.signin \
 *     --key-id ABCDE12345 \
 *     --p8 ~/Downloads/AuthKey_ABCDE12345.p8
 *
 * Flags (all required unless noted):
 *   --team-id     Your 10-char Apple Team ID   (issuer `iss`)         e.g. C89J4TDK6E
 *   --client-id   Your Services ID             (subject `sub`/aud)    e.g. com.roamlocal.signin
 *   --key-id      The 10-char Key ID for the .p8 (JWT header `kid`)   e.g. ABCDE12345
 *   --p8          Path to the AuthKey_XXXX.p8 you downloaded from Apple
 *   --days        Optional. Validity in days (default 180; Apple max is ~180 / 6 months)
 *
 * It prints the JWT to stdout. Paste that whole string into Supabase → Authentication → Providers
 * → Apple → "Secret Key (for OAuth)". (The "Client IDs" field there is the Services ID.)
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function die(msg) {
  console.error(`\nError: ${msg}\n`);
  console.error(
    "Usage: node scripts/apple-client-secret.mjs --team-id <TEAM> --client-id <SERVICES_ID> --key-id <KEYID> --p8 <path-to-.p8> [--days 180]",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const teamId = args["team-id"];
const clientId = args["client-id"];
const keyId = args["key-id"];
const p8Path = args["p8"];
const days = args["days"] ? Number(args["days"]) : 180;

if (!teamId || teamId === true) die("--team-id is required (your Apple Team ID).");
if (!clientId || clientId === true) die("--client-id is required (your Services ID).");
if (!keyId || keyId === true) die("--key-id is required (the .p8 Key ID).");
if (!p8Path || p8Path === true) die("--p8 is required (path to the AuthKey_XXXX.p8 file).");
if (!Number.isFinite(days) || days <= 0 || days > 180) {
  die("--days must be a number between 1 and 180 (Apple caps the client secret at 6 months).");
}

let privateKey;
try {
  privateKey = readFileSync(p8Path, "utf8");
} catch (err) {
  die(`could not read the .p8 file at "${p8Path}" — ${err instanceof Error ? err.message : String(err)}`);
}

if (!privateKey.includes("BEGIN PRIVATE KEY")) {
  die(`"${p8Path}" doesn't look like a PKCS#8 .p8 (missing "BEGIN PRIVATE KEY"). Point --p8 at the AuthKey_XXXX.p8 you downloaded from Apple.`);
}

const nowSec = Math.floor(Date.now() / 1000);
const expSec = nowSec + Math.floor(days * 24 * 60 * 60);

const header = { alg: "ES256", kid: keyId };
const payload = {
  iss: teamId,
  iat: nowSec,
  exp: expSec,
  aud: "https://appleid.apple.com",
  sub: clientId,
};

const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

let signature;
try {
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // Apple/JWS ES256 requires the raw R||S (P1363) signature, NOT the ASN.1/DER encoding Node
  // defaults to. dsaEncoding: "ieee-p1363" gives the 64-byte concatenated form.
  signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
} catch (err) {
  die(`failed to sign — ${err instanceof Error ? err.message : String(err)}. Check the .p8 and Key ID match.`);
}

const jwt = `${signingInput}.${base64url(signature)}`;

const expiryDate = new Date(expSec * 1000).toISOString().slice(0, 10);
process.stderr.write(
  `\n✅ Apple client secret generated.\n` +
    `   Team ID (iss):    ${teamId}\n` +
    `   Services ID (sub): ${clientId}\n` +
    `   Key ID (kid):     ${keyId}\n` +
    `   Expires:          ${expiryDate} (${days} days) — regenerate before then.\n\n` +
    `Paste the JWT below into Supabase → Authentication → Providers → Apple → "Secret Key (for OAuth)":\n\n`,
);

// The JWT itself goes to stdout so it can be piped/copied cleanly; the notes above go to stderr.
process.stdout.write(`${jwt}\n`);
