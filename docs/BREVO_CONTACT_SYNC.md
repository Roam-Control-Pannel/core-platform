# Brevo contact-list sync — setup

Roam adds people to two Brevo lists automatically:

| Moment | Brevo list | How |
| --- | --- | --- |
| A new user signs up | **#93** (new users) | Supabase webhook → `/api/brevo/contact-created` → `marketing.syncNewUser` |
| A business claim is **approved** | **#3** (businesses) | `venues.approveClaim` calls Brevo directly (server-side) |

Both are **best-effort** — if Brevo is unreachable or the key is missing, signups and claim approvals still succeed; the sync just logs and moves on. The list ids default to 93 / 3 and can be overridden per environment.

There's **no migration** — the only DB-side change is a Database Webhook you create in the dashboard.

---

## 1 · Brevo API key (enables both syncs)

In **Brevo → SMTP & API → API Keys → Generate a new API key** (this is the **v3 API key**, *not* the SMTP key). Then set it on the **API service (Railway)**:

```
BREVO_API_KEY=<the v3 key>
# optional overrides (defaults shown):
BREVO_LIST_NEW_USERS=93
BREVO_LIST_BUSINESSES=3
```

Restart the API after setting them. Until `BREVO_API_KEY` is set, both syncs are no-ops (the API still runs).

## 2 · Webhook secret (protects the new-user route)

Pick a long random string. Set it as `BREVO_WEBHOOK_SECRET` on the **web app (Vercel)** — the `/api/brevo/contact-created` route rejects any request whose `x-webhook-secret` header doesn't match.

```
BREVO_WEBHOOK_SECRET=<long random string>
```

## 3 · Supabase Database Webhook (fires on every signup)

In **Supabase → Database → Webhooks → Create a new hook**:

- **Name:** `brevo-new-user`
- **Table:** `public.profiles`
- **Events:** `INSERT` only
- **Type:** HTTP Request
- **Method:** `POST`
- **URL:** `https://www.roam-local.com/api/brevo/contact-created`
- **HTTP Headers:** add one — `x-webhook-secret` = the same value as `BREVO_WEBHOOK_SECRET` above.

Leave the payload as the default (Supabase sends `{ type, table, record, ... }`; the route reads `record.id`). Every new auth user gets a `profiles` row from the 0006 trigger, so this fires once per signup.

> Why `profiles` and not `auth.users`: the dashboard webhook UI targets the `public` schema, and a `profiles` row is created for every new user anyway. The route looks the email up from the auth user id, so `profiles` carrying no email is fine.

## 4 · Verify

- **New user:** sign up with a throwaway email → within a few seconds it should appear in Brevo list **#93**. If not, check the API logs for `[brevo]` lines and the Supabase webhook's delivery log.
- **Business:** approve a venue claim (the `venues.approveClaim` internal call) → the owner should appear in list **#3**.

A contact can be on both lists — adding to one never removes them from the other.
