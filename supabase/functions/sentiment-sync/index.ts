// sentiment-sync: reads the media monitoring tool's mentions (separate Supabase project, read-only) and stores
// monthly sentiment in metric_values (source "sentiment"), replacing the numbers typed in on the Upload page.
// Runs daily from pg_cron.
//
//   Counted: mentions published that month, leaving out those triaged as noise. Mixed counts as neutral.
//   dimension ""            sent_positive, sent_neutral, sent_negative, sent_mentions, sent_score_avg
//   dimension <brand>       sent_positive, sent_neutral, sent_negative  (AIA Canada, YPA, CCIF, I-CAR Canada)
//   metric sent_theme       dimension <theme>, value = mentions that month
//
// Secret: SENTIMENT_SUPABASE_KEY (the monitoring project's secret key; read only, never sent to the browser).
import { createClient } from "jsr:@supabase/supabase-js@2";

const SRC = "https://xtirppxnvbwrwdjvmzuf.supabase.co/rest/v1";
const BRANDS = ["AIA Canada", "YPA", "CCIF", "I-CAR Canada"];
const MONTHS_BACK = 12;
const MIN_GAP_MS = 10 * 60 * 1000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round(n * 1000) / 1000;

Deno.serve(async () => {
  const key = (Deno.env.get("SENTIMENT_SUPABASE_KEY") ?? "").trim();
  if (!key) return json({ skipped: true, reason: "SENTIMENT_SUPABASE_KEY isn't set" });
  const { data: last } = await db.from("sync_log").select("started_at,ok").eq("source", "sentiment").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true });
  const log: Record<string, unknown> = { source: "sentiment", started_at: new Date().toISOString() };
  try {
    const now = new Date(), from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_BACK - 1), 1)).toISOString().slice(0, 10);
    const H: Record<string, string> = { apikey: key, Accept: "application/json" };
    if (key.startsWith("eyJ")) H.Authorization = `Bearer ${key}`;   // legacy service_role key
    const rows: any[] = [];
    for (let off = 0; off < 100000; off += 1000) {
      const r = await fetch(`${SRC}/mentions?select=date_published,sentiment_category,sentiment_score,brands_affected,theme&status=neq.noise&date_published=gte.${from}&order=date_published&limit=1000&offset=${off}`, { headers: H });
      if (!r.ok) throw new Error(`Monitoring tool answered ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const b = await r.json(); rows.push(...b); if (b.length < 1000) break;
    }

    const M: Record<string, any> = {};
    const blank = () => ({ pos: 0, neu: 0, neg: 0, n: 0, score: 0, scored: 0, brand: Object.fromEntries(BRANDS.map((b) => [b, { pos: 0, neu: 0, neg: 0 }])), theme: {} as Record<string, number> });
    for (const x of rows) {
      if (!x.date_published) continue;
      const m = String(x.date_published).slice(0, 7) + "-01", o = (M[m] ??= blank());
      const k = x.sentiment_category === "Positive" ? "pos" : x.sentiment_category === "Negative" ? "neg" : "neu";
      o[k]++; o.n++;
      if (x.sentiment_score != null && Number.isFinite(+x.sentiment_score)) { o.score += +x.sentiment_score; o.scored++; }
      for (const b of x.brands_affected ?? []) if (o.brand[b]) o.brand[b][k]++;
      const t = String(x.theme ?? "").trim(); if (t) o.theme[t] = (o.theme[t] ?? 0) + 1;
    }

    const out: any[] = [], at = new Date().toISOString();
    const row = (period: string, metric: string, value: number, dimension = "") => out.push({ period, stream: "communications", source: "sentiment", brand: "All", metric, dimension, value, updated_by: "monitoring tool", updated_at: at });
    for (const [m, o] of Object.entries(M)) {
      row(m, "sent_positive", o.pos); row(m, "sent_neutral", o.neu); row(m, "sent_negative", o.neg); row(m, "sent_mentions", o.n);
      if (o.scored) row(m, "sent_score_avg", r2(o.score / o.scored));
      for (const b of BRANDS) { const s = o.brand[b]; row(m, "sent_positive", s.pos, b); row(m, "sent_neutral", s.neu, b); row(m, "sent_negative", s.neg, b); }
      for (const [t, c] of Object.entries(o.theme)) row(m, "sent_theme", c as number, t.slice(0, 80));
    }
    // Replace whatever was there for these months (hand-entered numbers and old theme rows) with the tool's.
    const months = Object.keys(M);
    if (months.length) {
      const { error: de } = await db.from("metric_values").delete().eq("source", "sentiment").in("period", months);
      if (de) throw new Error(de.message);
      const { error } = await db.from("metric_values").insert(out);
      if (error) throw new Error(error.message);
    }
    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_seen: rows.length, events_written: out.length, note: `${rows.length} mentions (noise left out) across ${months.length} month(s)` });
    await db.from("sync_log").insert(log);
    return json({ ok: true, mentions: rows.length, months, written: out.length });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
