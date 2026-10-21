// linkedin-sync: reads AIA Canada's LinkedIn company page statistics (read-only) and stores monthly totals in
// metric_values (source "social", dimension "LinkedIn"), the same rows the monthly upload uses.
// Runs daily from pg_cron, and once right after the page is connected.
//
//   followers    month-end followers: today's count (networkSizes) minus follower gains after each month end
//   impressions  organic impressions (organizationalEntityShareStatistics, MONTH)
//   engagements  reactions + comments + reposts + clicks (LinkedIn's own definition of engagements)
//   link_clicks  clicks on posts
//   page_views   all page views (organizationPageStatistics, MONTH)
//   posts        posts published that month (posts API, if the r_organization_social scope was granted)
//
// LinkedIn keeps 12 months of statistics. Months already uploaded by hand before LinkedIn was connected are kept;
// from the connection month on, LinkedIn's numbers are used.
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "202610";
const MIN_GAP_MS = 30 * 60 * 1000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7) + "-01";

async function getS(keys: string[]) { const { data } = await db.from("app_settings").select("key,value").in("key", keys); return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])); }

Deno.serve(async () => {
  const { data: last } = await db.from("sync_log").select("started_at,ok").eq("source", "linkedin").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true });
  const started = new Date();
  const log: Record<string, unknown> = { source: "linkedin", started_at: started.toISOString() };
  try {
    const s = await getS(["linkedin_access_token", "linkedin_access_expires", "linkedin_refresh_token", "linkedin_org_id", "linkedin_since", "linkedin_scope"]);
    if (!s.linkedin_access_token) return json({ skipped: true, reason: "LinkedIn isn't connected yet" });
    let token = s.linkedin_access_token as string;

    // Refresh the access token when it has less than 5 days left (needs a refresh token).
    if (s.linkedin_refresh_token && new Date(s.linkedin_access_expires ?? 0).getTime() - Date.now() < 5 * 864e5) {
      const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.linkedin_refresh_token, client_id: Deno.env.get("LINKEDIN_CLIENT_ID")!, client_secret: Deno.env.get("LINKEDIN_CLIENT_SECRET")! }) });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) throw new Error(`Refreshing the LinkedIn sign-in failed (${t.error_description ?? r.status}). Connect LinkedIn again on the Upload data page.`);
      token = t.access_token;
      const up = [{ key: "linkedin_access_token", value: token }, { key: "linkedin_access_expires", value: new Date(Date.now() + (Number(t.expires_in) || 5184000) * 1000).toISOString() }];
      if (t.refresh_token) up.push({ key: "linkedin_refresh_token", value: t.refresh_token });
      await db.from("app_settings").upsert(up, { onConflict: "key" });
    }

    const org = `urn:li:organization:${s.linkedin_org_id}`, enc = encodeURIComponent(org);
    const H = { Authorization: `Bearer ${token}`, "LinkedIn-Version": VERSION, "X-Restli-Protocol-Version": "2.0.0" };
    const get = async (path: string) => { const r = await fetch(`https://api.linkedin.com/rest/${path}`, { headers: H }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`LinkedIn ${r.status} on ${path.split("?")[0]}: ${String(b.message ?? "").slice(0, 160)}`); return b; };

    // 12-month window, starting at the first of the month 11 months ago (LinkedIn keeps 12 months).
    const now = new Date(), startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1), end = Date.now();
    const ti = (gran: string) => `timeIntervals=(timeRange:(start:${startMonth},end:${end}),timeGranularityType:${gran})`;
    const V: Record<string, Record<string, number>> = {}; const put = (m: string, k: string, v: number) => { (V[m] ??= {})[k] = Math.round(((V[m][k] ?? 0) + v) * 100) / 100; };

    const share = await get(`organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc}&${ti("MONTH")}`);
    for (const e of share.elements ?? []) {
      const m = monthKey(e.timeRange.start), t = e.totalShareStatistics ?? {};
      put(m, "impressions", Number(t.impressionCount) || 0);
      put(m, "link_clicks", Number(t.clickCount) || 0);
      put(m, "engagements", (Number(t.likeCount) || 0) + (Number(t.commentCount) || 0) + (Number(t.shareCount) || 0) + (Number(t.clickCount) || 0));
    }
    try {
      const pages = await get(`organizationPageStatistics?q=organization&organization=${enc}&${ti("MONTH")}`);
      for (const e of pages.elements ?? []) put(monthKey(e.timeRange.start), "page_views", Number(e.totalPageStatistics?.views?.allPageViews?.pageViews) || 0);
    } catch (e) { console.error("page views:", e); }

    // Month-end followers, worked back from today's total with daily follower gains.
    const size = await get(`networkSizes/${enc}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`);
    const total = Number(size.firstDegreeSize) || 0;
    const fol = await get(`organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${enc}&${ti("DAY")}`);
    const gains = (fol.elements ?? []).map((e: any) => ({ t: e.timeRange.start, g: (Number(e.followerGains?.organicFollowerGain) || 0) + (Number(e.followerGains?.paidFollowerGain) || 0) }));
    for (let i = 0; i < 12; i++) {
      const mStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1), nextStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1);
      const after = gains.filter((x: any) => x.t >= nextStart).reduce((a: number, x: any) => a + x.g, 0);
      put(monthKey(mStart), "followers", i === 0 ? total : total - after);
    }

    // Posts published per month (needs r_organization_social; skipped if not granted).
    if (String(s.linkedin_scope ?? "").includes("r_organization_social")) {
      try {
        for (let st = 0; st < 1000; st += 100) {
          const b = await get(`posts?author=${enc}&q=author&count=100&start=${st}&sortBy=CREATED`);
          const els = b.elements ?? [];
          for (const p of els) { const t = Number(p.publishedAt ?? p.createdAt); if (t >= startMonth) put(monthKey(t), "posts", 1); }
          if (els.length < 100 || els.some((p: any) => Number(p.publishedAt ?? p.createdAt) < startMonth)) break;
        }
      } catch (e) { console.error("posts:", e); }
    }

    // Keep hand-uploaded months from before the connection; LinkedIn owns the rest.
    const since = s.linkedin_since ?? monthKey(Date.now());
    const { data: existing } = await db.from("metric_values").select("period,metric,updated_by").eq("source", "social").eq("dimension", "LinkedIn").eq("brand", "All").gte("period", monthKey(startMonth));
    const manual = new Set((existing ?? []).filter((r: any) => r.updated_by !== "linkedin api").map((r: any) => `${r.period}|${r.metric}`));
    const rows: any[] = [];
    for (const [period, vals] of Object.entries(V)) for (const [metric, value] of Object.entries(vals)) {
      if (period < since && manual.has(`${period}|${metric}`)) continue;
      rows.push({ period, stream: "communications", source: "social", brand: "All", metric, dimension: "LinkedIn", value, updated_by: "linkedin api", updated_at: new Date().toISOString() });
    }
    if (rows.length) { const { error } = await db.from("metric_values").upsert(rows, { onConflict: "period,source,brand,metric,dimension" }); if (error) throw new Error(error.message); }

    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_written: rows.length, note: `${total} followers; ${rows.length} numbers written` });
    await db.from("sync_log").insert(log);
    return json({ ok: true, followers: total, written: rows.length });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
