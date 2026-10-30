// pheedloop-sync: copies every PheedLoop event's registration count into the dashboard tables.
// Runs hourly from pg_cron (and on demand). For each event it upserts `events` (name, dates, capacity;
// targets and last year's code set in the monthly template are left alone) and writes this month's
// row in `event_snapshots`. Last month's row is never touched again, so it keeps the month-end count.
// Revenue comes from the registrations (orders) endpoint. No attendee details are stored: only totals.
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
// Money totals from the registrations (orders) endpoint. Cancelled registrations are left out.
async function moneyFor(code: string) {
  const regs = await allPages(`/events/${code}/registrations/`);
  const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : 0);
  const live = regs.filter((r: any) => !r.canceled);
  const sum = (k: string, rows = live) => Math.round(rows.reduce((a: number, r: any) => a + n(r[k]), 0) * 100) / 100;
  const cats: Record<string, number> = {};
  for (const r of live) { const c = String(r.registration_category?.name ?? r.registration_category ?? "n/a").slice(0, 40); cats[c] = (cats[c] ?? 0) + 1; }
  const sub = sum("sub_total"), tax = sum("tax_total"), due = sum("amount_due");
  // Revenue = what registrants have been charged, tax included, less anything still owing. This matches the
  // revenue figures the team reported by hand (e.g. CCIF Montréal 2026: $112,504.74).
  const revenue = Math.round((sub + tax - due) * 100) / 100;
  // Payment status per order (one order can cover several people):
  //   paid = completed and charged, nothing owing; free = completed at no charge (speakers, comps, free tickets);
  //   owing = completed but money still due (e.g. pay by invoice); incomplete = started but never finished.
  const st = { paid: 0, free: 0, owing: 0, incomplete: 0, owingAmount: 0 };
  for (const r of live) {
    const due = n(r.amount_due), charged = n(r.sub_total) + n(r.tax_total);
    if (!r.registration_complete) st.incomplete++;
    else if (due > 0.005) { st.owing++; st.owingAmount += due; }
    else if (charged > 0.005) st.paid++;
    else st.free++;
  }
  st.owingAmount = Math.round(st.owingAmount * 100) / 100;
  // Average ticket price: each PheedLoop purchase on a completed order is one ticket (a group order of 9 is
  // 9 tickets; a golf foursome sold as one item is one ticket). Sponsorship categories are left out, as are
  // no-charge tickets. Amounts are before tax, after discounts, less any refund.
  const tk = { sold: 0, revenue: 0, comp: 0, sponsor: 0, sponsorComp: 0 };
  for (const r of live) {
    if (!r.registration_complete) continue;
    const n_ = Array.isArray(r.purchases) ? r.purchases.length : 0;
    if (!n_) continue;
    const sub = n(r.sub_total), gross = sub + n(r.tax_total), refunded = n(r.refund_total);
    const net = gross > 0 ? sub * Math.max(0, 1 - refunded / gross) : 0;
    if (SPONSOR_CAT.test(String(r.registration_category?.name ?? ""))) { tk.sponsor += n_; if (net <= 0.005) tk.sponsorComp += n_; continue; }
    if (net > 0.005) { tk.sold += n_; tk.revenue += net; } else tk.comp += n_;
  }
  tk.revenue = Math.round(tk.revenue * 100) / 100;
  return { revenue, status: st, tickets: tk, orders: regs.length, cancelled: regs.length - live.length, complete: live.filter((r: any) => r.registration_complete).length, sub_total: sub, tax_total: tax, payment_total: sum("payment_total"), refund_total: sum("refund_total", regs), amount_due: due, by_category: cats };
}
// Registration categories that are sponsorship (English and French), left out of the average ticket price.
const SPONSOR_CAT = /sponsor|commandit|supporter|partenaire|partner|exhibit|exposant/i;
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
    // Events held since Jan 1 last year get their payment status and ticket details filled in once (only those columns change).
    const { data: withStatus } = await db.from("event_snapshots").select("event_code").not("orders", "is", null).not("tickets_sponsor_comp", "is", null);
    const hasStatus = new Set((withStatus ?? []).map((r: any) => r.event_code));
    let statusFilled = 0;
    let written = 0, counted = 0, backfilled = 0;
    const kept: string[] = [];
    for (const e of events) {
      const code = String(e.code ?? e.event_code ?? "").trim();
      const start = day(e.date ?? e.start_date ?? e.starts_at);
      const end = day(e.end_date ?? e.ends_at) ?? start;
      if (!code || !start) continue;
      if (/\btest(ing)?\b/i.test(String(e.event_name ?? e.name ?? ""))) continue; // skip PheedLoop test events
      const old = (end ?? start) < cutoff;
      if (old && have.has(code) && !hasStatus.has(code) && (end ?? start) >= backfillFrom) {
        try {
          const m = await moneyFor(code), liveOrders = m.orders - m.cancelled;
          if (liveOrders > 0) {
            const { data: rows } = await db.from("event_snapshots").select("period").eq("event_code", code).order("period", { ascending: false }).limit(1);
            if (rows?.length) { await db.from("event_snapshots").update({ orders: liveOrders, orders_paid: m.status.paid, orders_free: m.status.free, orders_owing: m.status.owing, orders_incomplete: m.status.incomplete, amount_owing: m.status.owingAmount, tickets_sold: m.tickets.sold, ticket_revenue: m.tickets.revenue, tickets_comp: m.tickets.comp, tickets_sponsor: m.tickets.sponsor, tickets_sponsor_comp: m.tickets.sponsorComp }).eq("event_code", code).eq("period", rows[0].period); statusFilled++; }
          }
        } catch { /* status is optional */ }
        continue;
      }
      if (old && ((end ?? start) < backfillFrom || have.has(code))) continue;

      let regs = num(e.total_registration_count);
      if (regs == null) { regs = (await allPages(`/events/${code}/attendees/`)).length; counted++; }
      let attendance: number | null = null;
      if (start <= started.toISOString().slice(0, 10)) {
        try { const a = await pl(`/events/${code}/attendance/`); attendance = Array.isArray(a?.checked_in) ? a.checked_in.length : null; } catch { /* attendance is optional */ }
      }

      let revenue: number | null = null, status: any = null, tickets: any = null, liveOrders = 0;
      try { const m = await moneyFor(code); if (m.revenue > 0) revenue = m.revenue; status = m.status; tickets = m.tickets; liveOrders = m.orders - m.cancelled; } catch { /* revenue is optional */ }

      const ev: Record<string, unknown> = { code, name: String(e.event_name ?? e.name ?? code).trim(), start_date: start, end_date: end };
      const cap = num(e.attendee_registration_capacity);
      if (cap != null && cap > 0) ev.capacity = cap;
      const { error: e1 } = await db.from("events").upsert(ev, { onConflict: "code" });
      if (e1) throw new Error(`events ${code}: ${e1.message}`);

      const endDay = end ?? start;
      const snap: Record<string, unknown> = { event_code: code, period: old ? `${endDay.slice(0, 7)}-01` : period, registrations: regs };
      if (attendance != null && attendance > 0) snap.attendance = attendance;
      if (revenue != null) snap.revenue = revenue;
      if (status && liveOrders > 0) Object.assign(snap, { orders: liveOrders, orders_paid: status.paid, orders_free: status.free, orders_owing: status.owing, orders_incomplete: status.incomplete, amount_owing: status.owingAmount });
      if (tickets && liveOrders > 0) Object.assign(snap, { tickets_sold: tickets.sold, ticket_revenue: tickets.revenue, tickets_comp: tickets.comp, tickets_sponsor: tickets.sponsor, tickets_sponsor_comp: tickets.sponsorComp });
      const { error: e2 } = await db.from("event_snapshots").upsert(snap, { onConflict: "event_code,period" });
      if (e2) throw new Error(`snapshot ${code}: ${e2.message}`);
      written++; kept.push(code); if (old) backfilled++;
    }
    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_seen: events.length, events_written: written, note: [counted ? `${counted} counted from attendee lists` : "", backfilled ? `${backfilled} past events added` : "", statusFilled ? `payment and ticket details filled for ${statusFilled} past events` : ""].filter(Boolean).join("; ") || null });
    await db.from("sync_log").insert(log);
    return json({ ok: true, period, events_seen: events.length, events_written: written, codes: kept });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
