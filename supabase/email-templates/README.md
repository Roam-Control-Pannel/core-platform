# Roam transactional email — Brevo SMTP + branded auth templates

Supabase Auth sends the account lifecycle emails (sign-up confirmation, magic link,
password reset, email change, invite, reauthentication). Out of the box those go through
Supabase's shared SMTP with a default, unbranded body and a low rate limit. This folder
brands them and routes them through **Brevo** so they arrive as Roam, from a Roam address,
at production deliverability.

Two independent pieces — do both:

1. **Brevo as custom SMTP** (the sender / deliverability).
2. **The branded HTML templates** in this folder (the look).

Everything here is applied in the **Supabase dashboard** (and the Brevo dashboard); there is
no migration and no app code change. Apply on the **Roam-Core-Platform** project.

---

## 1 · Point Supabase Auth at Brevo SMTP

In **Brevo → Settings → SMTP & API → SMTP**, note the relay credentials. Brevo's SMTP host
is `smtp-relay.brevo.com`, port `587`, username = your Brevo SMTP login, password = an SMTP
**key** you generate there (not your account password).

Then in **Supabase → Authentication → Emails → SMTP Settings**, enable *Custom SMTP* and set:

| Field | Value |
| --- | --- |
| Sender email | `no-reply@roam-local.com` (must be a verified Brevo sender/domain) |
| Sender name | `Roam` |
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| Username | your Brevo SMTP login |
| Password | your Brevo SMTP key |
| Minimum interval | leave default |

**Before this works**, verify the domain in **Brevo → Senders, Domains & Dedicated IPs →
Domains**: add `roam-local.com` and publish the DKIM + SPF (and a DMARC) DNS records Brevo
gives you, at the same DNS provider where the domain is hosted. Unverified sender → Brevo
rejects the send and auth emails silently fail.

> Keep the SMTP key out of git. It lives only in the Supabase dashboard.

---

## 2 · Apply the branded templates

In **Supabase → Authentication → Emails → Templates**, pick each template, switch the body to
**HTML source**, and paste the matching file from this folder:

| Supabase template | File | Subject line to set |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | `Confirm your email · Roam` |
| Magic Link | `magic-link.html` | `Your Roam sign-in link` |
| Reset Password | `reset-password.html` | `Reset your Roam password` |
| Change Email Address | `change-email.html` | `Confirm your new email · Roam` |
| Invite user | `invite.html` | `You're invited to Roam` |
| Reauthentication | `reauthentication.html` | `Verify it's you · Roam` |

### Template variables

The templates use Supabase's Go template variables — leave them exactly as written:

- `{{ .ConfirmationURL }}` — the action link (confirm / sign-in / reset / accept).
- `{{ .Token }}` — the 6-digit one-time code (magic link + reauthentication).
- `{{ .Email }}` / `{{ .NewEmail }}` — the recipient / the requested new address.
- `{{ .SiteURL }}` — your configured Site URL.

The `{{ .ConfirmationURL }}` already honours the **Site URL** and **Redirect URLs** configured
under *Authentication → URL Configuration*, so confirmed sign-ups land back on
`https://www.roam-local.com`. No per-template URL editing needed.

### Notes on the design

- The logo loads from `https://www.roam-local.com/roam-logo.png` (already deployed in
  `apps/web/public`). If you move the asset, update the `<img src>` in each file.
- Layout is table-based with inline styles and web-safe fonts (Georgia for headings, system
  sans for body) — the only combination that renders consistently across Gmail, Outlook,
  Apple Mail, and mobile clients. Brand colours mirror the design tokens
  (crimson `#C2123F`, ink `#211D1A`, paper `#F6F3EF`, line `#E4DED6`).
- Each template degrades gracefully if images are blocked: the `alt="Roam"` text shows, and
  every action also appears as a pasteable link or a code.

### Verifying

Trigger one of each from a real flow (sign up with a throwaway address; use "forgot
password") and confirm: it arrives **from Roam `<no-reply@roam-local.com>`**, renders the
branded layout, the button works, and it lands in the inbox (not spam — that's what the DKIM/
SPF/DMARC records buy you).
