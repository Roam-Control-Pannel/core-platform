# Owner activity digest email

A once-a-day email to venue **owners** summarising new business activity — new reviews, orders
received, comments on their posts, and claim decisions. It reads the existing `notifications` rows
(the same in-app bell events), so there are no new per-event hooks.

- **Curated events:** `venue_review`, `order_received`, `business_post_comment`, `claim_approved`,
  `claim_rejected`.
- **Default on**, with a one-click unsubscribe in every email.
- **Idempotent per owner per day** via the `owner_digest_state.last_emailed_at` watermark; a 7-day
  hard floor bounds the scan.

## How it runs

`packages/api/src/jobs/deliverOwnerDigest.ts` — a pure `runOwnerDigest(service, deps, log)` plus a
guarded runner. Two triggers (same as `deliverBirthdays`):

- **Railway cron:** `pnpm --filter @roam/api deliver-owner-digest` (see `railway.cron-owner-digest.json`, `17 7 * * *` UTC).
- **Internal HTTP:** `POST /jobs/deliver-owner-digest` on the API, gated by the `x-internal-call`
  secret (pg_cron via pg_net can drive it too). Pick **one** trigger — don't run both.

Sends via Brevo's v3 transactional endpoint (`packages/api/src/brevo/transactional.ts`), reusing
`BREVO_API_KEY`. **Dormant** (status `unconfigured`, sends nothing) until the sender + unsubscribe
secret are set — so the code ships safely.

## Go-live checklist (ops)

1. **Apply migration** `0129_owner_email_digest.sql` in Supabase (adds `owner_digest_state` +
   `profiles.owner_digest_opt_out`). Idempotent (`if not exists` / `add column if not exists`).
2. **Verify a Brevo sender** for `no-reply@roam-local.com` (or your chosen `BREVO_SENDER_EMAIL`) in
   the Brevo dashboard (**Senders & IPs → Senders**, must show verified/green). Brevo rejects
   transactional sends from an unverified sender — this is the likeliest silent blocker.
3. **Create the Railway cron service** — its **own** service, not the API service. The API is a
   long-running `start` process and can't carry a `cronSchedule`; every background job here runs as a
   separate service (birthday delivery, CJ logos, Awin/CJ offers — see `docs/AFFILIATE_DEALS_SYNC.md`).
   In the Railway dashboard:
   1. **New service → GitHub Repo → `Roam-Control-Pannel/core-platform`**, branch `main`.
   2. **Settings → Config-as-code → Railway Config File →** `railway.cron-owner-digest.json`. The
      schedule (`17 7 * * *` UTC) and start command (`deliver-owner-digest`) come from that file.

   > **Gotcha (same as the deals crons):** the root `railway.json` pins `startCommand` to
   > `pnpm --filter @roam/api start`, and **config-as-code overrides the dashboard on every deploy**.
   > A cron service that does *not* point at its own config file will silently ignore its schedule and
   > just run a **second copy of the API** — spending money and sending nothing. Step 3.2 is what
   > prevents that.
4. **Set env on the cron service** (Railway variables are **per-service** — the cron does *not*
   inherit the API service's vars; reference them from the API service, or promote to project
   **Shared Variables** for a single source of truth):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — **required** (the job throws without them).
   - `BREVO_API_KEY`, `OWNER_DIGEST_UNSUBSCRIBE_SECRET` — **required to send** (missing → the job runs
     but returns `unconfigured` and sends nothing). The secret is any long random string
     (`openssl rand -hex 32`) and signs the one-click unsubscribe links.
   - `BREVO_SENDER_EMAIL` (the verified sender from step 2), optionally `BREVO_SENDER_NAME`
     (default `Roam`).
   - `WEB_ORIGIN` **or** `CORS_ALLOWED_ORIGINS` — the job uses
     `WEB_ORIGIN ?? CORS_ALLOWED_ORIGINS.split(",")[0]`, so if `CORS_ALLOWED_ORIGINS` already starts
     with your production web URL you don't need `WEB_ORIGIN`. This is the domain in the email's
     unsubscribe + dashboard links — make sure it's the real origin, not `localhost`.
   - **Not needed:** `INTERNAL_CALL_SECRET`. That only gates the HTTP route (below); the cron runs the
     job directly.
5. **Smoke test on Railway** (not your laptop — the `deliver-owner-digest` script does not load a
   local `.env`, and a local run would need prod secrets on your machine). After step 4, use
   **⋯ → Redeploy** on the cron service to run it once now instead of waiting for 07:17 UTC, and watch
   the logs for the summary block:
   ```
   status:        ok
   candidates:    N
   emails sent:   N
   send failures: 0
   opted out:     0
   ```
   `status: ok` with `emails sent > 0` = working; `status: unconfigured` = the Brevo key or unsubscribe
   secret isn't set on this service. Then click the unsubscribe link in a delivered email and confirm
   `profiles.owner_digest_opt_out` flips `true` and the next run skips that owner.

Until steps 2–4 are done the job returns `unconfigured` and sends nothing, so scheduling it early is
harmless.

### Alternative: schedule the internal HTTP route

If you'd rather keep the long-running API as the sole worker, POST to the route from any scheduler
(e.g. pg_cron via pg_net) using the server-to-server secret — this is the one path that *does* use
`INTERNAL_CALL_SECRET`:

```bash
curl -fsS -X POST https://<api-host>/jobs/deliver-owner-digest \
  -H "x-internal-call: $INTERNAL_CALL_SECRET"
```

The route no-ops safely when the Brevo sender / unsubscribe secret aren't set.
