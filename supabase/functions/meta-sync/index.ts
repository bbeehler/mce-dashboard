// meta-sync: reads statistics for the connected Facebook Pages and their linked Instagram business accounts
// (read-only) and stores monthly totals, all Pages combined, in metric_values (source "social", dimensions
// "Facebook" and "Instagram"). Runs daily from pg_cron, and once right after connecting.
//
// Facebook (Graph API v25.0 Page Insights; Meta retired "impressions" and "page fans" in favour of views and follows)
//   impressions  page_media_view (views)          engagements  page_post_engagements
//   page_views   page_views_total                 followers    followers_count today; page_follows at past month ends
//   posts        published posts that month
// Instagram (user insights, metric_type=total_value)
//   impressions  views          engagements  total_interactions          link_clicks  profile_links_taps
//   followers    followers_count today      posts  media published that month
//
// Months already uploaded by hand before connecting are kept; from the connection month on, Meta's numbers are used.
import { createClient } from "jsr:@supabase/supabase-js@2";

const G = "https://graph.facebook.com/v25.0";
const MIN_GAP_MS = 30 * 60 * 1000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7) + "-01";
const gj = async (url: string) => { const r = await fetch(url); const b = await r.json().catch(() => ({})); if (!r.ok || b.error) throw new Error(String(b.error?.message ?? `Facebook answered ${r.status}`).slice(0, 200)); return b; };

Deno.serve(async () => {
  const { data: last } = await db.from("sync_log").select("started_at,ok").eq("source", "meta").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true });
  const log: Record<string, unknown> = { source: "meta", started_at: new Date().toISOString() };
  try {
    const { data: set } = await db.from("app_settings").select("key,value").in("key", ["meta_pages", "meta_since"]);
    const S = Object.fromEntries((set ?? []).map((r: any) => [r.key, r.value]));
    if (!S.meta_pages) return json({ skipped: true, reason: "Facebook isn't connected yet" });
    const pages: any[] = JSON.parse(S.meta_pages);

    const now = new Date(), startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1), sec = (ms: number) => Math.floor(ms / 1000);
    const V: Record<string, Record<string, Record<string, number>>> = { Facebook: {}, Instagram: {} };
    const put = (pl: string, m: string, k: string, v: number) => { const o = (V[pl][m] ??= {}); o[k] = Math.round(((o[k] ?? 0) + v) * 100) / 100; };
    const notes: string[] = [];
    // 90-day windows for Page Insights (Meta's limit per request).
    const windows: [number, number][] = []; for (let a = startMs; a < now.getTime(); a += 90 * 864e5) windows.push([a, Math.min(a + 90 * 864e5, now.getTime())]);

    for (const p of pages) {
      const t = `access_token=${encodeURIComponent(p.token)}`;
      // ---- Facebook ----
      const daily = async (metric: string, fn: (day: number, v: number) => void) => {
        for (const [a, b] of windows) {
          const r = await gj(`${G}/${p.id}/insights?metric=${metric}&period=day&since=${sec(a)}&until=${sec(b)}&${t}`);
          for (const s of r.data ?? []) for (const v of s.values ?? []) fn(new Date(v.end_time).getTime() - 864e5, Number(v.value) || 0);
        }
      };
      for (const [metric, key] of [["page_media_view", "impressions"], ["page_post_engagements", "engagements"], ["page_views_total", "page_views"]]) {
        try { await daily(metric, (d, v) => put("Facebook", monthKey(d), key, v)); } catch (e) { notes.push(`${p.name} ${metric}: ${(e as Error).message}`); }
      }
      try {
        const cur = await gj(`${G}/${p.id}?fields=followers_count&${t}`);
        const monthEnd: Record<string, number> = {};
        try { await daily("page_follows", (d, v) => { monthEnd[monthKey(d)] = v; }); } catch { /* past month ends are optional */ }
        for (const [m, v] of Object.entries(monthEnd)) if (m !== monthKey(now.getTime())) put("Facebook", m, "followers", v);
        put("Facebook", monthKey(now.getTime()), "followers", Number(cur.followers_count) || 0);
      } catch (e) { notes.push(`${p.name} followers: ${(e as Error).message}`); }
      try {
        let next: string | null = `${G}/${p.id}/published_posts?fields=created_time&since=${sec(startMs)}&limit=100&${t}`;
        while (next) { const b = await gj(next); for (const x of b.data ?? []) put("Facebook", monthKey(new Date(x.created_time).getTime()), "posts", 1); next = b.paging?.next ?? null; }
      } catch (e) { notes.push(`${p.name} posts: ${(e as Error).message}`); }

      // ---- Instagram (linked business account) ----
      if (!p.ig?.id) continue;
      const ig = p.ig.id;
      for (let i = 0; i < 12; i++) {
        const mStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1), mEnd = Math.min(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1), now.getTime());
        const mid = Math.min(mStart + 15 * 864e5, mEnd);
        for (const [a, b] of [[mStart, mid], [mid, mEnd]]) {   // Instagram allows at most 30 days per request
          if (b <= a) continue;
          try {
            const r = await gj(`${G}/${ig}/insights?metric=views,total_interactions,profile_links_taps&metric_type=total_value&period=day&since=${sec(a)}&until=${sec(b)}&${t}`);
            for (const s of r.data ?? []) { const key = s.name === "views" ? "impressions" : s.name === "total_interactions" ? "engagements" : "link_clicks"; put("Instagram", monthKey(mStart), key, Number(s.total_value?.value) || 0); }
          } catch (e) { if (i < 2) notes.push(`Instagram ${p.ig.username}: ${(e as Error).message}`); }
        }
      }
      try {
        const cur = await gj(`${G}/${ig}?fields=followers_count&${t}`);
        put("Instagram", monthKey(now.getTime()), "followers", Number(cur.followers_count) || 0);
        let next: string | null = `${G}/${ig}/media?fields=timestamp&limit=100&${t}`;
        while (next) {
          const b = await gj(next); let old = false;
          for (const x of b.data ?? []) { const ms = new Date(x.timestamp).getTime(); if (ms < startMs) { old = true; continue; } put("Instagram", monthKey(ms), "posts", 1); }
          next = old ? null : b.paging?.next ?? null;
        }
      } catch (e) { notes.push(`Instagram ${p.ig.username}: ${(e as Error).message}`); }
    }

    // Keep hand-uploaded months from before connecting; Meta owns the rest.
    const since = S.meta_since ?? monthKey(Date.now());
    const { data: existing } = await db.from("metric_values").select("period,metric,dimension,updated_by").eq("source", "social").eq("brand", "All").in("dimension", ["Facebook", "Instagram"]).gte("period", monthKey(startMs));
    const manual = new Set((existing ?? []).filter((r: any) => r.updated_by !== "meta api").map((r: any) => `${r.dimension}|${r.period}|${r.metric}`));
    const rows: any[] = [];
    for (const pl of ["Facebook", "Instagram"]) for (const [period, vals] of Object.entries(V[pl])) for (const [metric, value] of Object.entries(vals)) {
      if (period < since && manual.has(`${pl}|${period}|${metric}`)) continue;
      rows.push({ period, stream: "communications", source: "social", brand: "All", metric, dimension: pl, value, updated_by: "meta api", updated_at: new Date().toISOString() });
    }
    if (rows.length) { const { error } = await db.from("metric_values").upsert(rows, { onConflict: "period,source,brand,metric,dimension" }); if (error) throw new Error(error.message); }

    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_written: rows.length, note: [`${pages.length} Page(s), ${pages.filter((p) => p.ig).length} Instagram; ${rows.length} numbers written`, ...notes.slice(0, 4)].join(" | ").slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ ok: true, written: rows.length, notes });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
