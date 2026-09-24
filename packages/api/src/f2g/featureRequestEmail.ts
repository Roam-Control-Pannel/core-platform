/**
 * The e-mail an officer gets when Roam answers their feature request (F2G plan 3.4).
 *
 * One direction only. Roam's own notification when a request arrives goes through `notifyOps`, the
 * alert channel this service already has, rather than a second internal e-mail path with its own
 * failure mode; the partner is external, so they get mail.
 *
 * Everything interpolated here comes from a partner's own text, so it is HTML-escaped. A request
 * titled `<script>…` must read as that text in the e-mail, not run in whoever opens it.
 */

/** Human wording for each status, so the e-mail does not read like a database column. */
const STATUS_WORDING: Record<string, string> = {
  new: "received",
  triaged: "been reviewed",
  planned: "been planned",
  in_progress: "been started",
  shipped: "shipped",
  declined: "been declined",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface FeatureRequestEmailInput {
  title: string;
  status: string;
  roamNotes: string | null;
  channelName: string;
  portalUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderFeatureRequestUpdate(input: FeatureRequestEmailInput): RenderedEmail {
  const wording = STATUS_WORDING[input.status] ?? `been moved to ${input.status}`;
  const subject = `Your request has ${wording}: ${input.title}`;

  const notesHtml = input.roamNotes
    ? `<p style="margin:16px 0 0"><strong>From Roam:</strong><br>${esc(input.roamNotes).replace(/\n/g, "<br>")}</p>`
    : "";
  const notesText = input.roamNotes ? `\n\nFrom Roam:\n${input.roamNotes}` : "";

  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a">
  <p style="margin:0">Hello,</p>
  <p style="margin:16px 0 0">
    The request <strong>${esc(input.title)}</strong> that ${esc(input.channelName)} raised with Roam has ${esc(wording)}.
  </p>${notesHtml}
  <p style="margin:20px 0 0">
    <a href="${esc(input.portalUrl)}" style="color:#9b1c2e">Open your organisation&rsquo;s portal</a>
  </p>
  <p style="margin:20px 0 0;font-size:13px;color:#666">
    You are receiving this because you are an officer of ${esc(input.channelName)}.
  </p>
</div>`;

  const text = `Hello,

The request "${input.title}" that ${input.channelName} raised with Roam has ${wording}.${notesText}

Open your organisation's portal: ${input.portalUrl}

You are receiving this because you are an officer of ${input.channelName}.`;

  return { subject, html, text };
}
