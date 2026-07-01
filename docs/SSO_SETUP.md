# Social sign-in (SSO) — setup

Roam offers **Continue with Google** and **Continue with Apple** alongside email/password. It's
built on Supabase Auth OAuth, so the app code is provider-agnostic — each button just calls
`signInWithOAuth({ provider })`, the user bounces to the provider, and lands back on
`/auth/callback`, which forwards them to where they were.

**Each provider is gated by a build-time flag** so a button only appears once the provider is
actually configured — no dead buttons:

```
NEXT_PUBLIC_ENABLE_GOOGLE_SSO=1   # on Vercel (web)
NEXT_PUBLIC_ENABLE_APPLE_SSO=1
```

(These are `NEXT_PUBLIC_`, so flipping one needs a Vercel redeploy.)

---

## Common Supabase step (both providers)

In **Supabase → Authentication → URL Configuration**:
- **Site URL:** `https://www.roam-local.com`
- **Redirect URLs:** add `https://www.roam-local.com/auth/callback` (and `http://localhost:3000/auth/callback` for local dev).

The OAuth callback lands on our custom auth domain (`https://auth.roam-local.com/auth/v1/callback`) — that's the URL you give Google/Apple as the provider redirect (below).

---

## 1 · Google (free — do this first)

**Google Cloud Console** → APIs & Services → Credentials → **Create OAuth client ID** (type: Web application):
- **Authorized JavaScript origins:** `https://www.roam-local.com`
- **Authorized redirect URI:** `https://auth.roam-local.com/auth/v1/callback`
- Configure the OAuth consent screen (External, app name "Roam", support email, logo, the `.../auth/v1/callback` domain as authorized).

Copy the **Client ID** and **Client secret**, then in **Supabase → Authentication → Providers → Google**: enable it and paste both. Save.

Finally, on **Vercel** set `NEXT_PUBLIC_ENABLE_GOOGLE_SSO=1` and redeploy → the Google button appears.

## 2 · Apple (needs the Apple Developer Program, $99/yr)

In the **Apple Developer** portal:
- An **App ID** (or reuse the iOS app's) with **Sign in with Apple** enabled.
- A **Services ID** (this is the OAuth `client_id`) with Sign in with Apple configured:
  - **Return URL:** `https://auth.roam-local.com/auth/v1/callback`
  - **Domain:** `auth.roam-local.com`
- A **Sign in with Apple key** (.p8) — note the Key ID and your Team ID.

Supabase needs the Services ID + a **client secret** (a JWT Supabase can generate from your Team ID, Key ID, and the .p8). In **Supabase → Authentication → Providers → Apple**: enable it, paste the Services ID and secret. Save.

Then on **Vercel** set `NEXT_PUBLIC_ENABLE_APPLE_SSO=1` and redeploy → the Apple button appears.

> Apple requirement: because you offer Google sign-in, App Store review will require Sign in with Apple in the **native** app. On web it's optional but nice to have parity.

---

## How it works in the app

- `AuthPanel` renders the enabled providers above the email form. A tap calls
  `signInWithOAuth({ provider, options: { redirectTo: <origin>/auth/callback?next=<where-they-were> } })`.
- `/auth/callback` (client) waits for the session (`detectSessionInUrl` → `SIGNED_IN`), validates
  `next` is **same-origin** (no open redirect), and forwards there. On a provider error/cancel it
  shows a gentle "didn't complete" with a way back.
- The session then flows through the existing `useSession` → tRPC token → RLS path, exactly like
  email sign-in. A first-time SSO user gets a `profiles` row from the 0006 trigger and (if the
  Brevo webhook is on) joins the new-users list — no special-casing.

## Verify

1. Enable Google in Supabase + set the Vercel flag + redeploy.
2. Open the sign-in panel → **Continue with Google** → pick an account → you land back signed in.
3. New Google account → a `profiles` row is created; existing email that matches → Supabase links by email.
