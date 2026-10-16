// membership-sync: reads AIA Canada organisations from Insightly and stores membership TOTALS only
// (counts and dues). No member names or contact details are saved. Runs from pg_cron every 6 hours.
//
// Source of truth for membership is the organisation field "Last Membership Year" (Last_Membership_Year__c).
//   member of year Y      = Last Membership Year >= Y (2050 means lifetime / complimentary, counted as a member)
//   new in Y              = member of Y whose "AIAC Joined Date" is in Y
//   returning in Y        = member of Y with status "Returning" who joined before Y
//   renewed in Y          = other paying members of Y
//   not renewed           = Last Membership Year = Y-1
//   renewal rate          = renewed / (renewed + not renewed)   (lifetime members left out)
// Insightly keeps only the latest payment per organisation, so payment months are refreshed only for the current
// renewal cycle (from October of last year); earlier months are left as they were saved.
//
// The same run also totals Insightly "Sponsorship" records (custom object Sponsorship__c) by sponsorship year,
// sponsored program and level into sponsorship_totals: number of sponsorships, amount invoiced, and the part
// with an invoice paid date. Sponsor names are not stored.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://api.na1.insightly.com/v3.1";
const LIFETIME = 2049;
const MIN_GAP_MS = 30 * 60 * 1000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const PROV: Record<string, string> = { alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB", newfoundland: "NL", "newfoundland and labrador": "NL", "nova scotia": "NS", ontario: "ON", "prince edward island": "PE", quebec: "QC", "québec": "QC", saskatchewan: "SK", yukon: "YT", "northwest territories": "NT", nunavut: "NU" };
const CA = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK", "YT", "NT", "NU"]);
const US = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
const US_NAMES = new Set(["georgia", "florida", "texas", "illinois", "michigan", "ohio", "california", "new york", "indiana", "minnesota", "missouri", "new jersey", "north carolina"]);
function province(raw: string) {
  const s = raw.trim(); if (!s) return "Not recorded";
  const u = s.toUpperCase().replace(/\./g, "");
  if (CA.has(u)) return u;
  if (PROV[s.toLowerCase()]) return PROV[s.toLowerCase()];
  if (US.has(u) || US_NAMES.has(s.toLowerCase())) return "United States";
  return "Other";
}
const CANON = ["Automotive Service Provider", "Association", "Major Retailers", "Manufacturer", "Manufacturers' Agent", "Rebuilder", "Strategic Business Partners", "Warehouse Distributor", "Wholesaler", "Education Institution", "Media", "Other", "Industry Engagement Network affiliate"];
const tidy = (s: string) => { const t = s.trim(); if (!t || t === "#N/A") return "Not recorded"; return CANON.find((c) => c.toLowerCase() === t.toLowerCase()) ?? t; };

Deno.serve(async (req) => {
  const key = (Deno.env.get("INSIGHTLY_API_KEY") ?? "").trim();
  if (!key) return json({ error: "Missing Supabase secret INSIGHTLY_API_KEY" }, 500);
  const { data: last } = await db.from("sync_log").select("started_at,ok").eq("source", "insightly_members").order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.ok && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return json({ skipped: true, last: last.started_at });

  const started = new Date();
  const log: Record<string, unknown> = { source: "insightly_members", started_at: started.toISOString() };
  try {
    let auth = "";
    for (const a of ["Basic " + btoa(key + ":"), "Basic " + btoa(key)]) { const r = await fetch(`${BASE}/Instance`, { headers: { Authorization: a } }); if (r.ok) { auth = a; break; } }
    if (!auth) throw new Error("Insightly did not accept the API key");
    const orgs: any[] = [];
    for (let skip = 0; skip < 50000; skip += 500) {
      const r = await fetch(`${BASE}/Organisations?top=500&skip=${skip}`, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`Insightly ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const b = await r.json(); orgs.push(...b); if (b.length < 500) break;
    }

    const today = started.toISOString().slice(0, 10);
    const Y = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" }).format(started));
    const cf = (o: any, n: string) => { const c = (o.CUSTOMFIELDS ?? []).find((x: any) => x.FIELD_NAME === n); const v = c?.FIELD_VALUE; return v == null || v === "" ? "" : Array.isArray(v) ? v.join(";") : String(v); };
    const num = (s: string) => (s && Number.isFinite(+s) ? +s : 0);

    const S: Record<string, number> = {}; const add = (m: string, d = "", n = 1) => { const k = `${m}|${d}`; S[k] = (S[k] ?? 0) + n; };
    const M: Record<string, number> = {}; const addM = (p: string, m: string, n = 1) => { const k = `${p}|${m}`; M[k] = (M[k] ?? 0) + n; };
    const cycleStart = `${Y - 1}-10-01`;

    for (const o of orgs) {
      const lmy = Math.trunc(num(cf(o, "Last_Membership_Year__c")));
      const joined = cf(o, "First_Membership_Date__c").slice(0, 10);
      const status = cf(o, "Membership_Status__c").toLowerCase();
      const resign = cf(o, "Membership_Resignation_Date__c").slice(0, 10);
      const pay = cf(o, "Membership_payment_date__c").slice(0, 10);
      const dues = num(cf(o, "Amount_before_tax__c")), paid = num(cf(o, "Total_amount_paid__c"));

      // Monthly flows
      if (pay && pay >= cycleStart && lmy > 0) { addM(pay.slice(0, 7) + "-01", "payments"); addM(pay.slice(0, 7) + "-01", "dues_paid", dues); }
      if (joined && joined >= "2024-01-01" && lmy > 0) addM(joined.slice(0, 7) + "-01", "joined");
      if (resign && resign >= "2024-01-01") addM(resign.slice(0, 7) + "-01", "resigned");

      if (lmy === Y - 1) { add("not_renewed"); if (resign >= `${Y - 1}-01-01` || status === "resigned") add("not_renewed_resigned"); }
      if (lmy > Y && lmy < LIFETIME) { add("renewed_next"); add("dues_next", "", dues); }
      if (lmy < Y) continue;

      // Members of year Y
      const life = lmy >= LIFETIME;
      add("members");
      if (life) add("lifetime");
      else if (joined.startsWith(String(Y))) add("new");
      else if (status === "returning") add("returning");
      else add("renewed");
      if (lmy === Y) { add("dues", "", dues); add("paid", "", paid); }
      add("mix", "segment:" + (cf(o, "Segment_Marketing__c") || "Not recorded"));
      add("mix", "industry:" + tidy(cf(o, "Industry_Category__c")));
      add("mix", "province:" + province(o.ADDRESS_BILLING_STATE || cf(o, "Province__c") || ""));
      add("mix", "language:" + (cf(o, "Language_of_Preference__c") || "Not recorded"));
      const sectors = cf(o, "Industry_Segment__c"); for (const s of sectors ? sectors.split(";") : ["Not recorded"]) add("mix", "sector:" + s.trim());
      // Data quality checks
      if (cf(o, "Membership__c") !== "Active") add("dq_not_active_flag");
      if (status === "resigned" || status === "non-renewed") add("dq_status_conflict");
      if (!cf(o, "Segment_Marketing__c")) add("dq_no_segment");
      if (!life && !dues) add("dq_no_dues");
    }
    const g = (m: string, d = "") => S[`${m}|${d}`] ?? 0;
    const renewed = g("renewed"), notRen = g("not_renewed");
    S["renewal_rate|"] = renewed + notRen ? Math.round((renewed / (renewed + notRen)) * 10000) / 10000 : 0;
    for (const m of ["members", "lifetime", "new", "returning", "renewed", "not_renewed", "not_renewed_resigned", "renewed_next", "dues", "paid", "dues_next", "dq_not_active_flag", "dq_status_conflict", "dq_no_segment", "dq_no_dues"]) S[`${m}|`] ??= 0;
    S["orgs_checked|"] = orgs.length;

    // Dues for the year only ever grow during the year: once a member renews for next year, Insightly
    // overwrites the amount, so keep the highest total seen this year.
    const { data: prev } = await db.from("member_snap").select("metric,value").eq("year", Y).in("metric", ["dues", "paid"]).eq("dimension", "");
    for (const p of prev ?? []) S[`${p.metric}|`] = Math.max(S[`${p.metric}|`], Number(p.value));

    const rows = Object.entries(S).map(([k, v]) => { const [metric, dimension] = k.split("|"); return { as_of: today, year: Y, metric, dimension, value: Math.round(v * 10000) / 10000 }; });
    await db.from("member_snap").delete().eq("as_of", today);
    const { error: e1 } = await db.from("member_snap").insert(rows);
    if (e1) throw new Error(`member_snap: ${e1.message}`);

    // Monthly flows: payments only for the current cycle; joins and resignations from 2024.
    const now = new Date().toISOString();
    const mrows = Object.entries(M).map(([k, v]) => { const [period, metric] = k.split("|"); return { period, metric, value: Math.round(v * 100) / 100, updated_at: now }; });
    await db.from("member_monthly").delete().gte("period", cycleStart).in("metric", ["payments", "dues_paid"]);
    await db.from("member_monthly").delete().in("metric", ["joined", "resigned"]);
    if (mrows.length) { const { error: e2 } = await db.from("member_monthly").upsert(mrows, { onConflict: "period,metric" }); if (e2) throw new Error(`member_monthly: ${e2.message}`); }

    // ---- Sponsorships ----
    let spons = 0;
    try {
      const defs = await (await fetch(`${BASE}/CustomFields/Sponsorship__c`, { headers: { Authorization: auth } })).json();
      const fid = (...labels: string[]) => { for (const l of labels) { const d = (defs ?? []).find((x: any) => String(x.FIELD_LABEL).toLowerCase() === l.toLowerCase()); if (d) return d.FIELD_NAME as string; } return ""; };
      const F = { amt: fid("Amount Invoiced"), prog: fid("Sponsored Program"), lvl: fid("Sponsorship Level"), lvl2: fid("Level"), yr: fid("Sponsorship Year"), paid: fid("Invoice Paid Date") };
      const recs: any[] = [];
      for (let skip = 0; skip < 20000; skip += 500) {
        const r = await fetch(`${BASE}/Sponsorship__c?top=500&skip=${skip}`, { headers: { Authorization: auth } });
        if (!r.ok) throw new Error(`Sponsorship ${r.status}`);
        const b = await r.json(); recs.push(...b); if (b.length < 500) break;
      }
      const T: Record<string, { deals: number; invoiced: number; paid_deals: number; paid: number }> = {};
      for (const o of recs) {
        const yr = Math.trunc(num(cf(o, F.yr))); if (!yr) continue;
        let prog = cf(o, F.prog) || "Not recorded"; if (/autocare industry conference/i.test(prog)) prog = "CAIC";
        const lvl = (cf(o, F.lvl) || cf(o, F.lvl2) || "Not recorded").slice(0, 60);
        const amt = num(cf(o, F.amt)), isPaid = !!cf(o, F.paid);
        const k = `${yr}|${prog}|${lvl}`; const t = (T[k] ??= { deals: 0, invoiced: 0, paid_deals: 0, paid: 0 });
        t.deals++; t.invoiced += amt; if (isPaid) { t.paid_deals++; t.paid += amt; }
      }
      const srows = Object.entries(T).map(([k, t]) => { const [year, program, level] = k.split("|"); return { year: +year, program, level, deals: t.deals, invoiced: Math.round(t.invoiced * 100) / 100, paid_deals: t.paid_deals, paid: Math.round(t.paid * 100) / 100, updated_at: new Date().toISOString() }; });
      if (srows.length) {
        await db.from("sponsorship_totals").delete().gte("year", 0);
        const { error } = await db.from("sponsorship_totals").insert(srows);
        if (error) throw new Error(error.message);
      }
      spons = recs.length;
    } catch (e) { console.error("sponsorships:", e); }

    Object.assign(log, { ok: true, finished_at: new Date().toISOString(), events_seen: orgs.length, events_written: g("members"), note: `${g("members")} members for ${Y}; ${spons} sponsorships` });
    await db.from("sync_log").insert(log);
    return json({ ok: true, year: Y, members: g("members"), renewal_rate: S["renewal_rate|"], orgs: orgs.length });
  } catch (err) {
    Object.assign(log, { ok: false, finished_at: new Date().toISOString(), note: String((err as Error).message ?? err).slice(0, 500) });
    await db.from("sync_log").insert(log);
    return json({ error: log.note }, 502);
  }
});
