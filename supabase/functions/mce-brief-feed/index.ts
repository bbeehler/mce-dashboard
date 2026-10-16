// mce-brief-feed: private RSS feeds of the monthly MCE brief, watched by Power Automate in Brian's Microsoft 365.
//
//   GET ?key=<feed key>&stage=draft     -> drafts waiting for review (flow emails Brian)
//   GET ?key=<feed key>&stage=approved  -> approved briefs (flow emails Emily)
//
// The feed key lives in app_settings (service role only). Each item's description is the email body as HTML,
// so the flow can send it as is. A new item appears each time a draft is written or a brief is approved.
import { createClient } from "jsr:@supabase/supabase-js@2";

const DASH = "https://bbeehler.github.io/mce-dashboard/";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const monthName = (p: string) => new Date(p + "T12:00:00Z").toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });

// The brief's small Markdown subset (paragraphs, ## headings, - bullets, **bold**) as email-safe HTML.
function toHtml(md: string) {
  const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const out: string[] = [];
  let list = false;
  for (const raw of md.split(/\n/)) {
    const l = raw.trim();
    const b = l.match(/^[-*•]\s+(.*)$/);
    if (b) { if (!list) { out.push('<ul style="margin:6px 0 14px;padding-left:20px">'); list = true; } out.push(`<li style="margin:0 0 6px">${inline(b[1])}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (!l) continue;
    const h = l.match(/^#{1,3}\s+(.*)$/);
    out.push(h ? `<h3 style="font-size:15px;margin:18px 0 6px;color:#1b2a5a">${inline(h[1])}</h3>` : `<p style="margin:0 0 12px">${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}
function email(b: any, stage: string) {
  const link = `${DASH}?month=${b.period.slice(0, 7)}`;
  const top = stage === "draft"
    ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fff4dc;border-radius:6px;font-size:13px">Draft for your review (version ${b.version}). Edit and approve it on the <a href="${DASH}upload.html#briefCard">Upload data page</a>; approving sends it to Emily.</p>`
    : "";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f1730;max-width:640px">${top}
<div style="border-bottom:3px solid #e31b4b;padding-bottom:8px;margin-bottom:14px"><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#4a5368">AIA Canada · Marketing, Communications and Engagement</div><div style="font-size:20px;font-weight:700;color:#1b2a5a">Monthly brief, ${esc(monthName(b.period))}</div></div>
${toHtml(b.body_md)}
<p style="margin:18px 0 0"><a href="${link}" style="display:inline-block;background:#1b2a5a;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-weight:600">Open the dashboard for ${esc(monthName(b.period))}</a></p>
<p style="margin:14px 0 0;font-size:12px;color:#868d9c">Written with Claude from the MCE dashboard data (GA4, Insightly, PheedLoop, social, sentiment) and reviewed by Brian Beehler.</p></div>`;
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const stage = u.searchParams.get("stage") === "approved" ? "approved" : "draft";
  const { data: k } = await db.from("app_settings").select("value").eq("key", "brief_feed_key").maybeSingle();
  if (!k || u.searchParams.get("key") !== k.value) return new Response("Not found", { status: 404 });
  const { data } = await db.from("briefs").select("*").eq("status", stage).order(stage === "approved" ? "approved_at" : "generated_at", { ascending: false }).limit(6);
  const items = (data ?? []).map((b: any) => {
    // Drafts keep their written time, so saving edits does not look like a new item and email Brian again.
    const when = stage === "approved" ? b.approved_at : b.generated_at;
    const guid = stage === "approved" ? `${b.period}-approved-${b.approved_at}` : `${b.period}-draft-v${b.version}`;
    const title = stage === "approved" ? b.subject : `For review: ${b.subject}`;
    return `<item><title>${esc(title)}</title><link>${DASH}?month=${b.period.slice(0, 7)}</link><guid isPermaLink="false">${esc(guid)}</guid><pubDate>${new Date(when).toUTCString()}</pubDate><description><![CDATA[${email(b, stage).replaceAll("]]>", "]] >")}]]></description></item>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>MCE monthly brief (${stage})</title><link>${DASH}</link><description>AIA Canada MCE monthly brief, ${stage}</description>
${items}
</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-store" } });
});
