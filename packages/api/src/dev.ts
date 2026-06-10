/**
 * Local dev runner for the standalone API service.
 *
 * server.ts exposes a transport-pure `handler(request): Promise<Response>`. This module
 * is the thin Node shim that serves it over HTTP for local development — exactly the
 * "wrap in a few lines that forward the Request" the server comment describes. It adds
 * no logic and no architecture; production uses its own runtime shim (e.g. a Netlify
 * Function) around the same handler.
 *
 * Env: server.ts reads its required vars at module load and fail-fasts if any are
 * missing (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * INTERNAL_CALL_SECRET). We load .env from the repo root first so those are present.
 *
 * Run: `pnpm --filter @roam/api dev` (PORT defaults to 8787 to match NEXT_PUBLIC_API_URL).
 */
import { serve } from "@hono/node-server";
import { handler } from "./server.js";

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: handler, port }, (info) => {
  console.log(`[@roam/api] dev service listening on http://localhost:${info.port}/trpc`);
});
