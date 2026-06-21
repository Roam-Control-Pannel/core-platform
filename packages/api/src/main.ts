/**
 * Production entrypoint for the standalone API service.
 *
 * server.ts exposes a transport-pure `handler(request): Promise<Response>` and
 * anticipates a per-runtime shim around it ("production uses its own runtime shim
 * around the same handler"). This is that shim for a long-running Node host (Railway):
 * it binds the platform-assigned $PORT and serves the same handler over HTTP via
 * @hono/node-server — the exact mechanism dev.ts uses locally, with two deliberate
 * differences that make it a PRODUCTION entry, not a dev one:
 *
 *   1. Env source. dev.ts is launched with `--env-file=../../.env` for local secrets.
 *      Here, env arrives from the host's own environment (Railway dashboard vars) —
 *      already present in process.env, no file. server.ts reads + fail-fasts on its
 *      required vars at module load, so a missing secret crashes the boot, as intended.
 *
 *   2. Port. Railway assigns $PORT at runtime; we bind it. There is NO 8787 fallback
 *      here on purpose: in production an unset PORT is a misconfiguration we want to
 *      surface loudly, not paper over with a dev default that would bind the wrong port.
 *
 * dev.ts stays the LOCAL runner (unchanged); this is its production peer. Keeping them
 * as two small, honestly-named files is the clean expression of "same handler, different
 * runtime shim" — neither file pretends to be the other.
 */
import { serve } from "@hono/node-server";
import { handler } from "./server.js";

const rawPort = process.env.PORT;
if (!rawPort) {
  throw new Error(
    "[@roam/api] PORT is not set. The production host must provide $PORT. " +
      "Refusing to start rather than bind a wrong default.",
  );
}
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`[@roam/api] PORT is not a valid port number: ${JSON.stringify(rawPort)}`);
}

serve({ fetch: handler, port }, (info) => {
  console.log(`[@roam/api] service listening on :${info.port}/trpc`);
});
