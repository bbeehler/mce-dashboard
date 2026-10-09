// pheedloop-sync: copies every PheedLoop event's registration count into the dashboard tables.
// Runs hourly from pg_cron (and on demand). For each event it upserts `events` (name, dates, capacity;
// targets and last year's code set in the monthly template are left alone) and writes this month's
// row in `event_snapshots`. Last month's row is never touched again, so it keeps the month-end count.
// No attendee details are stored: only totals.
import { createClient } from "jsr:@supabase/supabase-js@2";

// Read on every run so newly added or changed secrets take effect without a redeploy.
let KEY = "", SECRET = "", ORG = "", BASE = "";
function loadKeys() {
  KEY = (Deno.env.get("PHEEDLOOP_API_KEY") ?? "").trim();
  SECRET = (Deno.env.get("PHEEDLOOP_API_SECRET") ?? "").trim();
  ORG = (Deno.env.get("PHEEDLOOP_ORG") ?? "").trim();
  BASE = `https://api.pheedloop.com/api/v3/organization/${encodeURIComponent(ORG)}`;
  return ["PHEEDLOOP_API_KEY", "PHEEDLOOP_API_SECRET", "PHEEDLOOP_ORG"].filter((n, i) => ![KEY, SECRET, ORG][i]);
}
const MIN_GAP_MS = 5 * 60 * 1000;          // ignore calls within 5 minutes of the last sync
const LOOKBACK_DAYS = 45;                   // keep updating events that ended recently (attendance)
// Older events (back to Jan 1 last year) are copied once, with their final counts filed under the month
// they ended, so the dashboard can show events held year to date and compare with last year.

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

async function pl(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, { headers: { "X-API-KEY": KEY, "X-API-SECRET": SECRET, Accept: "application/json" } });
  if (!r.ok) throw new Error(`PheedLoop ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const listOf = (b: any) => (Array.isArray(b) ? b : b?.results ?? b?.data ?? b?.events ?? b?.attendees ?? []);
async function allPages(path: string) {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const body = await pl(path, { page: String(page), page_size: "500" });
    const items = listOf(body);
    out.push(...items);
    const hasNext = Array.isArray(body) ? items.length === 500 : !!(body?.next ?? body?.links?.next ?? (body?.total_pages && page < body.total_pages));
    if (!hasNext || !items.length) break;
  }
  return out;
}
const day = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : typeof n === "string" && n.trim() !== "" && Number.isFinite(+n) ? +n : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" } });
  const missing = loadKeys();
  if (missing.length) return json({ error: `Missing Supabase secrets: ${missing.join(", ")}` }, 500);

  const { data: last } = await db.from("sync_log").select("started_at,ok").eq("source", "pheedloop").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true, reason: "synced less than 5 minutes ago", last: last.started_at });

  const started = new Date();
  const period = `${started.getUTCFullYear()}-${String(started.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const cutoff = new Date(started.getTime() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const log: Record<string, unknown> = { source: "pheedloop", started_at: started.toISOString() };
  try {
    const events = await allPages("/events/");
    const backfillFrom = `${started.getUTCFullYear() - 1}-01-01`;
    const { data: known } = await db.from("events").select("code");
    const have = new Set((known ?? []).map((r: any) => r.code));
    let written = 0, counted = 0, backfilled = 0;
    const kept: string[] = [];
    for (const e of events) {
      const code = String(e.code ?? e.event_code ?? "").trim();
      const start = day(e.date ?? e.start_date ?? e.starts_at);
      const end = day(e.end_date ?? e.ends_at) ?? start;
      if (!code || !start) continue;
      if (/\btest(ing)?\b/i.test(String(e.event_name ?? e.name ?? ""))) continue; // skip PheedLoop test events
      const old = (end ?? start) < cutoff;
      if (old && ((end ?? start) < backfillFrom || have.has(code))) continue;

      let regs = num(e.total_registration_count);
      if (regs == null) { regs = (await allPages(`/events/${code}/attendees/`)).length; counted++; }
      let attendance: number | null = null;
      if (start <= started.toISOString().slice(0, 10)) {
        try { const a = await pl(`/events/${code}/attendance/`); attendance = Array.isArray(a?.checked_in) ? a.checked_in.length : null; } catch { /* attendance is optional */ }
      }

      const ev: Record<string, unknown> = { code, name: String(e.event_name ?? e.name ?? code).trim(), start_date: start, end_date: end };
      const cap = num(e.attendee_registration_capacity);
      if (cap != null && cap > 0) ev.capacity = cap;
      const { error: e1 } = await db.from("events").upsert(ev, { onConflict: "code" });
      if (e1) throw new Error(`events ${code}: ${e1.message}`);

      const endDay = end ?? start;
      const snap: Record<string, unknown> = { event_code: code, period: old ? `${endDay.slice(0, 7)}-01` : period, registrations: regs };
      if (attendance != null && attendance > 0) snap.attendance = attendance;
      const { error: e2 } = await db.from("event_snapshots").upsert(snap, { onConflict: "event_code,period" });
      if (e2) throw new Error(`snapshot ${code}: ${e2.message}`);
      written++; kept.push(code); if (old) backfilled++;
    }
    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_seen: events.length, events_written: written, note: [counted ? `${counted} counted from attendee lists` : "", backfilled ? `${backfilled} past events added` : ""].filter(Boolean).join("; ") || null });
    await db.from("sync_log").insert(log);
    return json({ ok: true, period, events_seen: events.length, events_written: written, codes: kept });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
