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
  secret (pg_cron via pg_net can drive it too).

Sends via Brevo's v3 transactional endpoint (`packages/api/src/brevo/transactional.ts`), reusing
`BREVO_API_KEY`. **Dormant** (status `unconfigured`, sends nothing) until the sender + unsubscribe
secret are set — so the code ships safely.

## Go-live checklist (ops)

1. **Apply migration** `0129_owner_email_digest.sql` in Supabase (adds `owner_digest_state` +
   `profiles.owner_digest_opt_out`).
2. **Verify a Brevo sender** for `no-reply@roam-local.com` (or your chosen `BREVO_SENDER_EMAIL`) in
   the Brevo dashboard — Brevo rejects transactional sends from unverified senders.
3. **Set env on the API service (Railway):**
   - `BREVO_SENDER_EMAIL` (a verified sender), optionally `BREVO_SENDER_NAME` (default `Roam`).
   - `OWNER_DIGEST_UNSUBSCRIBE_SECRET` — any long random string (signs the unsubscribe links).
   - (`BREVO_API_KEY`, `WEB_ORIGIN`/`CORS_ALLOWED_ORIGINS`, `INTERNAL_CALL_SECRET` already set.)
4. **Create the Railway cron service** pointed at `railway.cron-owner-digest.json` (mirrors the
   birthday / CJ-logo crons; each cron is its own Railway service — see `docs/AFFILIATE_DEALS_SYNC.md`).
5. **Smoke test:** trigger once (`pnpm --filter @roam/api deliver-owner-digest`, or POST the internal
   route with the secret) and confirm a digest lands; click the unsubscribe link and confirm
   `profiles.owner_digest_opt_out` flips true and the next run skips that owner.

Until steps 2–4 are done the job returns `unconfigured` and sends nothing.
