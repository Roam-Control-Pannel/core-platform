/**
 * ActivatePanel — /activate (F2G plan 2.4). The member path that replaces invite→claim.
 *
 * THE CHANGE THIS EMBODIES. B3-d's emailed link conferred ownership on whoever clicked it while
 * signed in, so a forwarded invite was a live credential. Here the link only names a (member, venue)
 * pair; taking control needs proof that you control the organisation's own e-mail address — either
 * because your account already uses it, or because you can type back a code sent to it.
 *
 * FOUR STEPS, and the UI never runs ahead of the server. `choose` lists only rows this account could
 * already see (venues it owns, plus the one an invite names). `start` decides whether a code is even
 * needed. `code` collects it. `done` reports what the conferral actually did. Every refusal is
 * rendered as an explanation, because most of them — "your organisation's address is not on file",
 * "this needs the Association to check the address" — are not the user's fault and are not errors.
 *
 * WHAT IS NOT SHOWN. The organisation's e-mail address, ever. Only the mask the server returns. At
 * the moment of asking we do not know the asker owns that inbox; that is the entire reason for the
 * code.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { useChannel } from "./ChannelProvider";

interface Candidate {
  memberId: string;
  venueId: string;
  business: string;
  venueName: string;
  bound: boolean;
}

type Step = "loading" | "choose" | "code" | "done";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ActivatePanel() {
  const trpc = useTrpc();
  const session = useSession();
  const channel = useChannel();
  const channelKey = channel.key;

  const [step, setStep] = useState<Step>("loading");
  const [channelName, setChannelName] = useState<string>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [maskedTo, setMaskedTo] = useState<string>("");
  const [expiresIn, setExpiresIn] = useState<number>(15);
  const [code, setCode] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const token = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("token") ?? undefined
    : undefined;

  const load = useCallback(() => {
    if (!session || !channelKey) return;
    setStep("loading");
    (trpc as any).activation.candidates
      .query({ channelKey, ...(token ? { token } : {}) })
      .then((r: { channelName: string; candidates: Candidate[] }) => {
        setChannelName(r.channelName);
        setCandidates(r.candidates);
        setStep("choose");
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : "Could not load your listings.");
        setStep("choose");
      });
  }, [trpc, session, channelKey, token]);

  useEffect(() => { load(); }, [load]);

  async function start(c: Candidate) {
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await (trpc as any).activation.start.mutate({
        channelKey, memberId: c.memberId, venueId: c.venueId,
      });
      setChosen(c);
      if (r.outcome === "sent") {
        setMaskedTo(r.sentToMasked ?? "");
        setExpiresIn(r.expiresInMinutes ?? 15);
        setStep("code");
      } else if (r.outcome === "already_verified") {
        // The account already uses the organisation's address, so there is nothing to type.
        await confer(c);
      } else {
        setNotice(startMessage(r.outcome, r.throttle));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start activation.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!chosen) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await (trpc as any).activation.verify.mutate({
        channelKey, memberId: chosen.memberId, venueId: chosen.venueId, code,
      });
      if (r.outcome === "verified") {
        await confer(chosen);
      } else if (r.outcome === "wrong_code") {
        setAttemptsLeft(r.attemptsRemaining ?? null);
        setNotice(
          r.attemptsRemaining === 1
            ? "That code is not right. One more try before it stops working."
            : `That code is not right. ${r.attemptsRemaining ?? 0} tries left.`,
        );
      } else if (r.outcome === "too_many_attempts") {
        setNotice("That code has had too many tries. Ask for a new one.");
        setAttemptsLeft(0);
      } else {
        setNotice("That code has expired or has already been used. Ask for a new one.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not check that code.");
    } finally {
      setBusy(false);
    }
  }

  async function confer(c: Candidate) {
    const r = await (trpc as any).activation.activate.mutate({
      channelKey, memberId: c.memberId, venueId: c.venueId,
    });
    setOutcome(r.outcome);
    setStep("done");
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <main style={wrap}>
        <h1 style={h1}>Activate your listing</h1>
        <p style={lede}>
          Sign in first — activation links your account to your organisation&rsquo;s membership, so we
          need to know who you are before anything else.
        </p>
        <AuthPanel
          intro="Sign in to activate your listing."
          emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          onAuthed={() => {}}
        />
      </main>
    );
  }

  if (step === "loading") {
    return <main style={wrap}><div style={skeleton} aria-hidden /></main>;
  }

  if (step === "done") {
    return (
      <main style={wrap}>
        <h1 style={h1}>{doneTitle(outcome)}</h1>
        <p style={lede}>{doneBody(outcome, channelName || "the organisation")}</p>
        {outcome === "activated" || outcome === "already_claimed" ? (
          <Link href="/dashboard" style={linkStyle}>Open your dashboard</Link>
        ) : (
          <Link href="/" style={linkStyle}>Back to {channelName || "the storefront"}</Link>
        )}
      </main>
    );
  }

  if (step === "code" && chosen) {
    return (
      <main style={wrap}>
        <h1 style={h1}>Enter your code</h1>
        <p style={lede}>
          We sent a six-digit code to <strong>{maskedTo}</strong> — the address {channelName || "the organisation"}{" "}
          holds for <strong>{chosen.business}</strong>. It expires in {expiresIn} minutes.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Six-digit code"
          placeholder="000000"
          maxLength={7}
          style={codeInput}
        />
        {notice ? <p style={noticeStyle}>{notice}</p> : null}
        {err ? <p style={errStyle}>{err}</p> : null}
        <div style={{ display: "flex", gap: 10, marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <button type="button" style={primaryBtn} disabled={busy || code.replace(/\D/g, "").length !== 6}
            onClick={() => void submitCode()}>
            {busy ? "Checking…" : "Confirm"}
          </button>
          <button type="button" style={plainBtn} disabled={busy}
            onClick={() => { setCode(""); setAttemptsLeft(null); void start(chosen); }}>
            Send a new code
          </button>
        </div>
        {attemptsLeft === 0 ? (
          <p style={noticeStyle}>Ask for a new code to try again.</p>
        ) : null}
        <p style={fine}>
          Not your organisation&rsquo;s address?{" "}
          <button type="button" style={linkBtn} onClick={() => { setChosen(null); setCode(""); setStep("choose"); }}>
            Go back
          </button>
          .
        </p>
      </main>
    );
  }

  // step === "choose"
  return (
    <main style={wrap}>
      <h1 style={h1}>Activate your listing</h1>
      {candidates.length === 0 ? (
        <>
          <p style={lede}>
            We can&rsquo;t find a {channelName || "membership"} listing linked to the venues on this
            account.
          </p>
          <p style={lede}>
            Claim your venue first, then come back — or ask {channelName || "the organisation"} to
            check the details they hold for you.
          </p>
          <Link href="/" style={linkStyle}>Back to the storefront</Link>
        </>
      ) : (
        <>
          <p style={lede}>
            Confirm which listing is yours. We&rsquo;ll send a short code to the email address{" "}
            {channelName || "the organisation"} holds for it.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "var(--space-3) 0 0", display: "grid", gap: 10 }}>
            {candidates.map((c) => (
              <li key={`${c.memberId}:${c.venueId}`} style={card}>
                <div style={{ fontWeight: 600 }}>{c.business}</div>
                <div style={{ color: "var(--ink-2)", fontSize: 13 }}>
                  {c.venueName}
                  {!c.bound ? " · the Association will need to check this pairing" : ""}
                </div>
                <button type="button" style={{ ...primaryBtn, marginTop: 10 }} disabled={busy}
                  onClick={() => void start(c)}>
                  {busy ? "Working…" : "This is mine"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {notice ? <p style={noticeStyle}>{notice}</p> : null}
      {err ? <p style={errStyle}>{err}</p> : null}
    </main>
  );
}

function startMessage(outcome: string, throttle?: string | null): string {
  switch (outcome) {
    case "no_email":
      // Plan §3.2: these members have no self-serve path at all and are activated by HQ.
      return "We don't hold an email address for this listing, so it can't be activated here. Ask the organisation to add one, or to activate it for you.";
    case "not_activatable":
      return "This listing has already been activated. If that wasn't you, contact the organisation.";
    case "throttled":
      return throttle === "member_hourly"
        ? "This listing has had several codes recently. Try again in an hour."
        : "You've asked for several codes recently. Try again in an hour.";
    case "unconfigured":
      return "Activation emails aren't switched on yet. Please try again later.";
    case "send_failed":
      return "We couldn't send the code just now. Please try again in a moment.";
    default:
      return "That activation isn't available.";
  }
}

function doneTitle(outcome: string | null): string {
  switch (outcome) {
    case "activated": return "You're in";
    case "already_claimed": return "Already activated";
    case "review": return "We've passed this to the organisation";
    case "claimed_by_other": return "Someone else manages this venue";
    default: return "We couldn't finish that";
  }
}

function doneBody(outcome: string | null, org: string): string {
  switch (outcome) {
    case "activated":
      return `Your venue is now linked to your ${org} membership. You'll be ranked and badged as a member, and you can manage your details, menu and orders from your dashboard.`;
    case "already_claimed":
      return "This listing was already activated on your account — nothing more to do.";
    case "review":
      return `The postcode ${org} holds for this listing doesn't match the venue, so we haven't linked them automatically. ${org} will check it and get back to you.`;
    case "claimed_by_other":
      return "This venue is already managed by a different account. If that's wrong, contact the organisation.";
    case "conflict":
      return "Someone else linked this listing while you were working. Refresh and take another look.";
    default:
      return "Something didn't line up. Contact the organisation and they can sort it out.";
  }
}

const wrap: React.CSSProperties = { maxWidth: 560, margin: "0 auto", padding: "var(--space-5) var(--space-4) var(--space-12)" };
const h1: React.CSSProperties = { fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 };
const lede: React.CSSProperties = { margin: "var(--space-2) 0 var(--space-3)", color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 };
const fine: React.CSSProperties = { ...lede, fontSize: 12.5, marginTop: "var(--space-4)" };
const skeleton: React.CSSProperties = { height: 160, borderRadius: 16, background: "var(--paper-2)" };
const card: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" };
const codeInput: React.CSSProperties = {
  width: "100%", padding: "14px 16px", fontSize: 26, letterSpacing: ".3em",
  fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", textAlign: "center",
  border: "1px solid var(--line)", borderRadius: 12, background: "var(--paper)",
};
const primaryBtn: React.CSSProperties = {
  padding: "10px 16px", borderRadius: 10, border: 0, background: "var(--ink)",
  color: "var(--paper)", fontWeight: 600, fontSize: 14, cursor: "pointer",
};
const plainBtn: React.CSSProperties = {
  padding: "10px 16px", borderRadius: 10, border: "1px solid var(--line)",
  background: "transparent", color: "var(--ink)", fontSize: 14, cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  background: "none", border: 0, padding: 0, font: "inherit",
  color: "var(--ink)", textDecoration: "underline", cursor: "pointer",
};
const linkStyle: React.CSSProperties = { color: "var(--ink)", textDecoration: "underline", fontSize: 14 };
const noticeStyle: React.CSSProperties = { color: "var(--ink-2)", fontSize: 13.5, margin: "var(--space-2) 0 0", lineHeight: 1.5 };
const errStyle: React.CSSProperties = { color: "var(--danger, #b00)", fontSize: 13.5, margin: "var(--space-2) 0 0" };
/* eslint-enable @typescript-eslint/no-explicit-any */
