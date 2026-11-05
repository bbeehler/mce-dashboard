// event-report: builds an attendee report for one event and matches every attendee to Insightly.
//
//   POST {action:"build", passcode, event_code, source:"pheedloop"}                 -> pull attendees from PheedLoop
//   POST {action:"build", passcode, event_code, source:"upload", filename, rows:[…]} -> rows from an uploaded attendee report
//        rows: {first_name,last_name,email,title,company,province,reg_category,checked_in}
//   POST {action:"get", passcode, event_code}   -> the full report (people included)
//   POST {action:"delete", passcode, event_code}
//
// "build" and "delete" need the upload passcode (MCE_UPLOAD_PASSCODE). "get" accepts the upload passcode or the
// Ask-the-data passcode (MCE_ASK_PASSCODE). People are stored in event_attendees, which the browser can't read;
// only totals go to event_reports, which the public dashboard reads.
//
// Matching, in order: the attendee's email is an Insightly contact -> that contact's organisation; the email's
// company domain matches organisations (contacts' domains, website, organisation email); the company name matches
// an organisation name; a close company name (marked "possible"). Member = Last Membership Year >= the event year
// (2050 = lifetime / IEN affiliate). A non-member location whose head office is a member counts as a member.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const IBASE = "https://api.na1.insightly.com/v3.1";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = (o: string) => ({ "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" });
const json = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });

async function sha(s: string) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function same(given: unknown, real?: string) {
  if (!real || typeof given !== "string" || !given) return false;
  const [a, b] = await Promise.all([sha(given), sha(real)]); let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
}
const isUpload = (p: unknown) => same(p, Deno.env.get("MCE_UPLOAD_PASSCODE"));
// Maintenance token: lets a scheduled database job rebuild a report. Only works while a token is stored in
// app_settings (service role only); normally there is none.
async function testToken(t: unknown) { if (typeof t !== "string" || t.length < 20) return false; const { data } = await db.from("app_settings").select("value").eq("key", "event_report_test_token").maybeSingle(); return !!data?.value && data.value === t; }
const canView = async (p: unknown) => (await isUpload(p)) || (await same(p, Deno.env.get("MCE_ASK_PASSCODE")));

// ---------- text helpers ----------
const GENERIC = new Set("gmail.com hotmail.com hotmail.ca outlook.com live.com live.ca msn.com yahoo.com yahoo.ca icloud.com me.com mac.com aol.com protonmail.com proton.me sympatico.ca bell.net videotron.ca videotron.qc.ca rogers.com shaw.ca telus.net cogeco.ca cogeco.net eastlink.ca sasktel.net mts.net xplornet.com bellnet.ca globetrotter.net cgocable.ca b2b2c.ca oricom.ca derytele.com axion.ca xittel.ca live.fr sogetel.net tlb.sympatico.ca qc.aira.com outlook.fr hotmail.fr yahoo.fr outlook.fr gmx.com mail.com".split(" "));
const LEGAL = new Set("inc incorporated ltd ltee limited limitee corp corporation co company llc lp llp plc the cie compagnie enr ulc gp".split(" "));
const deaccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normName = (s: unknown) => deaccent(String(s ?? "").toLowerCase()).replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !LEGAL.has(w)).join(" ").trim();
const domainOf = (e: unknown) => { const m = String(e ?? "").trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/); return m ? m[1] : ""; };
const webDomain = (w: unknown) => { const s = String(w ?? "").trim().toLowerCase(); if (!s) return ""; try { return new URL(s.includes("//") ? s : "http://" + s).hostname.replace(/^www\./, ""); } catch { return ""; } };
const clean = (v: unknown, n = 200) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };

const PROV: Record<string, string> = { alberta: "AB", "british columbia": "BC", "colombie britannique": "BC", manitoba: "MB", "new brunswick": "NB", "nouveau brunswick": "NB", newfoundland: "NL", "newfoundland and labrador": "NL", "nova scotia": "NS", "nouvelle ecosse": "NS", ontario: "ON", "prince edward island": "PE", quebec: "QC", saskatchewan: "SK", yukon: "YT", "northwest territories": "NT", nunavut: "NU" };
const CA = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK", "YT", "NT", "NU"]);
function province(raw: unknown, country?: unknown) {
  const s = deaccent(String(raw ?? "").trim()); if (!s || s === "-" || /^n\/?a$/i.test(s)) return /united states|usa|^us$/i.test(String(country ?? "")) ? "United States" : null;
  const u = s.toUpperCase().replace(/\./g, ""); if (CA.has(u)) return u;
  const p = PROV[s.toLowerCase().replace(/-/g, " ")]; if (p) return p;
  if (/united states|usa|^us$/i.test(String(country ?? "")) || /^[A-Z]{2}$/.test(u)) return "United States";
  return /canada|^ca$/i.test(String(country ?? "")) ? null : "Outside Canada";
}
const TYPES = ["Automotive Service Provider", "Association", "Major Retailers", "Manufacturer", "Manufacturers' Agent", "Rebuilder", "Strategic Business Partners", "Warehouse Distributor", "Wholesaler", "Education Institution", "Media", "Other", "Industry Engagement Network affiliate", "Allied"];
const tidyType = (s: string) => { const t = s.trim(); if (!t || t === "#N/A") return ""; return TYPES.find((c) => c.toLowerCase() === t.toLowerCase()) ?? t; };

// ---------- Insightly ----------
async function insightly() {
  const key = (Deno.env.get("INSIGHTLY_API_KEY") ?? "").trim();
  if (!key) throw new Error("The Insightly key isn't set up.");
  let auth = "";
  for (const a of ["Basic " + btoa(key + ":"), "Basic " + btoa(key)]) { const r = await fetch(`${IBASE}/Instance`, { headers: { Authorization: a } }); if (r.ok) { auth = a; break; } }
  if (!auth) throw new Error("Insightly did not accept the API key.");
  const page = async (path: string) => { const out: any[] = []; for (let skip = 0; skip < 100000; skip += 500) { const r = await fetch(`${IBASE}/${path}?top=500&skip=${skip}`, { headers: { Authorization: auth } }); if (!r.ok) throw new Error(`Insightly ${r.status} on ${path}`); const b = await r.json(); out.push(...b); if (b.length < 500) break; } return out; };
  const [orgs, contacts] = await Promise.all([page("Organisations"), page("Contacts")]);
  return { orgs, contacts };
}

type Org = { id: number; name: string; norm: string; lmy: number; type: string; sector: string; segment: string; wd: string; icar: string; province: string; companyId: string; parentId: string };

function buildIndex(orgs: any[], contacts: any[]) {
  const cf = (o: any, n: string) => { const c = (o.CUSTOMFIELDS ?? []).find((x: any) => x.FIELD_NAME === n); const v = c?.FIELD_VALUE; return v == null || v === "" ? "" : Array.isArray(v) ? v.join(";") : String(v); };
  const byId = new Map<number, Org>(), byName = new Map<string, Org[]>(), byDomain = new Map<string, Map<number, number>>(), byCompanyId = new Map<string, Org>();
  const addDom = (d: string, id: number, w = 1) => { if (!d || GENERIC.has(d)) return; const m = byDomain.get(d) ?? new Map(); m.set(id, (m.get(id) ?? 0) + w); byDomain.set(d, m); };
  for (const o of orgs) {
    const icarRec = cf(o, "ICAR_Recognition__c"), icarCust = cf(o, "ICAR_Customer__c");
    const org: Org = {
      id: o.ORGANISATION_ID, name: String(o.ORGANISATION_NAME ?? "").trim(), norm: normName(o.ORGANISATION_NAME),
      lmy: Math.trunc(Number(cf(o, "Last_Membership_Year__c")) || 0), type: tidyType(cf(o, "Industry_Category__c")),
      sector: cf(o, "Industry_Segment__c").split(";").map((s) => s.trim()).filter(Boolean).join(", "), segment: cf(o, "Segment_Marketing__c"),
      wd: cf(o, "WD_Affiliation_new__c") || cf(o, "WD_Affiliation__c"), icar: icarRec && !/^(none|no|n\/a)$/i.test(icarRec) ? icarRec : (/^(true|yes|1)$/i.test(icarCust) ? "I-CAR customer" : ""),
      province: String(o.ADDRESS_BILLING_STATE ?? ""), companyId: cf(o, "Company_ID__c"), parentId: cf(o, "Parent_ID__c"),
    };
    byId.set(org.id, org);
    if (org.norm) { const l = byName.get(org.norm) ?? []; l.push(org); byName.set(org.norm, l); }
    if (org.companyId) byCompanyId.set(org.companyId, org);
    addDom(webDomain(o.WEBSITE), org.id, 3); addDom(domainOf(cf(o, "Email_Address__c")), org.id, 3);
    for (const d of o.EMAILDOMAINS ?? []) addDom(String(d?.EMAIL_DOMAIN ?? d ?? "").toLowerCase(), org.id, 3);
  }
  const byEmail = new Map<string, number>();
  for (const c of contacts) {
    const e = String(c.EMAIL_ADDRESS ?? "").trim().toLowerCase(), oid = c.ORGANISATION_ID;
    if (!e || !oid || !byId.has(oid)) continue;
    byEmail.set(e, oid); addDom(domainOf(e), oid, 1);
  }
  return { byId, byName, byDomain, byEmail, byCompanyId };
}

// Words that say "main record" rather than a location.
const HQ = new Set("canada head office corporate network group siege social bureau chef national".split(" "));
// Share of words two normalised names have in common (0..1).
function sim(a: string, b: string) { if (!a || !b) return 0; if (a === b) return 1; const A = new Set(a.split(" ")), B = new Set(b.split(" ")); let k = 0; for (const w of A) if (B.has(w)) k++; return k / Math.min(A.size, B.size) * (k / Math.max(A.size, B.size)) ** 0.5; }
function matcher(ix: ReturnType<typeof buildIndex>, year: number) {
  const isMember = (o?: Org) => !!o && o.lmy >= year;
  const parentOf = (o: Org) => (o.parentId ? ix.byCompanyId.get(o.parentId) : undefined);
  const pick = (cands: Org[]) => cands.slice().sort((a, b) => Number(isMember(b)) - Number(isMember(a)) || b.lmy - a.lmy || Number(!b.parentId) - Number(!a.parentId))[0];
  const names = [...ix.byName.keys()].filter((n) => n.length >= 5);
  return (a: { email: string | null; company: string | null }) => {
    let org: Org | undefined, method = "", conf = "high";
    const e = (a.email ?? "").toLowerCase(), d = domainOf(e), n = normName(a.company);
    if (e && ix.byEmail.has(e)) { org = ix.byId.get(ix.byEmail.get(e)!); method = "Contact in Insightly"; }
    // Email domain: fine when the domain belongs to one company. Franchise networks (ProColor, Fix Auto…) share one
    // domain across many locations, so there the company name decides, and without a name match it is only "possible".
    let shared: Org | undefined, franchise = false;
    if (!org && d && ix.byDomain.has(d)) {
      const cands = [...ix.byDomain.get(d)!.entries()].map(([id, w]) => ({ o: ix.byId.get(id)!, w })).sort((x, y) => y.w - x.w);
      const total = cands.reduce((a, c) => a + c.w, 0);
      // In a franchise network every location shares the brand words ("fix auto", "procolor"), so compare only the
      // words that tell locations apart. A bare brand name ("NAPA", "CARSTAR") goes to the network's main record.
      const brand = new Set<string>();
      if (cands.length > 2) { const f: Record<string, number> = {}; for (const c of cands) for (const w of new Set(c.o.norm.split(" "))) f[w] = (f[w] ?? 0) + 1; for (const [w, k] of Object.entries(f)) if (k / cands.length >= 0.4) brand.add(w); }
      const strip = (x: string) => x.split(" ").filter((w) => w && !brand.has(w) && !HQ.has(w)).join(" ");
      const nn = strip(n);
      let close: { o: Org; w: number }[] = [];
      if (n && !nn && brand.size) close = cands.filter((c) => !strip(c.o.norm));
      else if (nn) close = cands.filter((c) => sim(strip(c.o.norm), nn) >= 0.5);
      if (close.length) { org = close.sort((x, y) => sim(strip(y.o.norm), nn) - sim(strip(x.o.norm), nn) || Number(isMember(y.o)) - Number(isMember(x.o)) || y.w - x.w)[0].o; method = "Email domain and name"; }
      else if (cands.length <= 2 || (!brand.size && cands[0].w / total >= 0.7)) { org = cands[0].o; method = "Email domain"; if (n && !sim(org.norm, n)) conf = "possible"; }
      else { const main = cands.filter((c) => !strip(c.o.norm)).map((c) => c.o); if (main.length) shared = pick(main); else franchise = true; }
    }
    if (!org && n && ix.byName.has(n)) { org = pick(ix.byName.get(n)!); method = "Company name"; }
    if (!org && n.length >= 5) {
      const hit = names.filter((k) => (n.startsWith(k + " ") || k.startsWith(n + " "))).sort((x, y) => y.length - x.length)[0];
      if (hit) { org = pick(ix.byName.get(hit)!); method = "Similar company name"; conf = "possible"; }
    }
    if (!org && shared) { org = shared; method = "Shared email domain"; conf = "possible"; }
    if (!org) return { org: null, method: franchise ? "Franchise location not in Insightly" : "", conf: "", status: "Not in Insightly", via: null as string | null };
    let status = "", via: string | null = null, last = org.lmy;
    if (isMember(org)) status = "Member";
    else { const p = parentOf(org); if (isMember(p)) { status = "Member"; via = p!.name; last = p!.lmy; } }
    if (!status) status = last >= 2000 ? "Lapsed member" : "Not a member";
    return { org, method, conf, status, via, last };
  };
}

// ---------- attendees ----------
async function fromPheedLoop(code: string) {
  const KEY = (Deno.env.get("PHEEDLOOP_API_KEY") ?? "").trim(), SECRET = (Deno.env.get("PHEEDLOOP_API_SECRET") ?? "").trim(), ORG = (Deno.env.get("PHEEDLOOP_ORG") ?? "").trim();
  const ROOT = `https://api.pheedloop.com/api/v3/organization/${encodeURIComponent(ORG)}/events/${code}`;
  const H = { "X-API-KEY": KEY, "X-API-SECRET": SECRET, Accept: "application/json" };
  const all = async (p: string) => { const out: any[] = []; for (let pg = 1; pg < 50; pg++) { const r = await fetch(`${ROOT}/${p}/?page=${pg}&page_size=500`, { headers: H }); if (!r.ok) throw new Error(`PheedLoop ${r.status} on ${p}`); const b = await r.json(); const l = Array.isArray(b) ? b : b.results ?? []; out.push(...l); if (!b.next || !l.length) break; } return out; };
  const [att, regs] = await Promise.all([all("attendees"), all("registrations").catch(() => [])]);
  const catByReg = new Map<string, string>(); for (const r of regs) if (r.code) catByReg.set(r.code, String(r.registration_category?.name ?? ""));
  const catByEmail = new Map<string, string>(); for (const r of regs) if (r.email && !r.canceled) catByEmail.set(String(r.email).toLowerCase(), String(r.registration_category?.name ?? ""));
  return att.map((a: any) => ({
    first_name: a.first_name, last_name: a.last_name, email: a.email, title: a.title, company: a.organization,
    province: province(a.address_state, a.address_country), checked_in: a.is_checked_in === true,
    reg_category: catByReg.get(a.metadata?.registration_code ?? "") || catByEmail.get(String(a.email ?? "").toLowerCase()) || null,
  }));
}

function totals(rows: any[]) {
  const T: any = { attendees: rows.length, checked_in: 0, status: {}, status_checked: {}, type: {}, type_members: {}, sector: {}, sector_members: {}, province: {}, category: {}, method: {}, possible: 0, companies: 0, member_companies: 0, other_companies: 0, generic_email: 0 };
  const inc = (o: any, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const companies = new Map<string, string>();
  for (const r of rows) {
    if (r.checked_in) T.checked_in++;
    inc(T.status, r.member_status); if (r.checked_in) inc(T.status_checked, r.member_status);
    const type = r.business_type || (r.org_id ? "Not recorded" : "Unknown (not in Insightly)");
    inc(T.type, type); if (r.member_status === "Member") inc(T.type_members, type);
    for (const s of (r.sector ? r.sector.split(", ") : [r.org_id ? "Not recorded" : "Unknown (not in Insightly)"])) { inc(T.sector, s); if (r.member_status === "Member") inc(T.sector_members, s); }
    inc(T.province, r.province || "Not given"); inc(T.category, r.reg_category || "Not given");
    inc(T.method, r.match_method || "No match"); if (r.match_confidence === "possible") T.possible++;
    if (GENERIC.has(domainOf(r.email))) T.generic_email++;
    const key = r.org_id ? `o${r.org_id}` : normName(r.company); if (key) companies.set(key, r.member_status);
  }
  T.companies = companies.size; for (const s of companies.values()) s === "Member" ? T.member_companies++ : T.other_companies++;
  return T;
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  let body: any; try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }
  const code = typeof body.event_code === "string" ? body.event_code.trim() : "";
  const slow = () => new Promise((r) => setTimeout(r, 800));

  if (body.action === "get") {
    if (!(await canView(body.passcode))) { await slow(); return json({ error: "That passcode isn't right." }, 401, h); }
    if (!code) return json({ error: "Choose an event." }, 400, h);
    const { data: report } = await db.from("event_reports").select("*").eq("event_code", code).maybeSingle();
    if (!report) return json({ error: "There's no attendee report for that event yet." }, 404, h);
    const { data: people, error } = await db.from("event_attendees").select("*").eq("event_code", code).order("idx");
    if (error) return json({ error: error.message }, 500, h);
    return json({ report, people }, 200, h);
  }
  if (body.action === "check") return json({ ok: await canView(body.passcode) }, 200, h);

  if (!(await isUpload(body.passcode)) && !(await testToken(body.test_token))) { await slow(); return json({ error: "That passcode isn't right." }, 401, h); }
  if (!code) return json({ error: "Choose an event." }, 400, h);
  const { data: ev } = await db.from("events").select("code,name,start_date").eq("code", code).maybeSingle();
  if (!ev) return json({ error: "That event wasn't found." }, 404, h);

  if (body.action === "delete") { await db.from("event_reports").delete().eq("event_code", code); return json({ ok: true }, 200, h); }
  if (body.action !== "build") return json({ error: "Unknown action." }, 400, h);

  try {
    let src: any[];
    if (body.source === "pheedloop") src = await fromPheedLoop(code);
    else {
      if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 5000) return json({ error: "The file has no attendee rows (or more than 5,000)." }, 400, h);
      src = body.rows.map((r: any) => ({ ...r, province: province(r.province, r.country) }));
    }
    if (!src.length) return json({ error: "PheedLoop has no attendees for this event yet." }, 400, h);
    const year = +String(ev.start_date).slice(0, 4);
    const { orgs, contacts } = await insightly();
    const match = matcher(buildIndex(orgs, contacts), year);
    const rows = src.map((a: any, i: number) => {
      const email = clean(a.email, 200)?.toLowerCase() ?? null, company = clean(a.company);
      const m: any = match({ email, company });
      return {
        event_code: code, idx: i, first_name: clean(a.first_name, 80), last_name: clean(a.last_name, 80), email, title: clean(a.title), company,
        province: a.province || (m.org ? province(m.org.province) : null), reg_category: clean(a.reg_category, 120), checked_in: a.checked_in == null ? null : !!a.checked_in,
        org_id: m.org?.id ?? null, org_name: m.org?.name ?? null, match_method: m.method || null, match_confidence: m.conf || null,
        member_status: m.status, member_last_year: m.org ? (m.last || null) : null, via_parent: m.via,
        business_type: m.org?.type || null, sector: m.org?.sector || null, segment: m.org?.segment || null, wd_affiliation: m.org?.wd || null, icar: m.org?.icar || null,
      };
    });
    const T = totals(rows);
    const { error: e1 } = await db.from("event_reports").upsert({ event_code: code, source: body.source === "pheedloop" ? "pheedloop" : "upload", filename: clean(body.filename), member_year: year, totals: T, built_at: new Date().toISOString() }, { onConflict: "event_code" });
    if (e1) throw new Error(e1.message);
    await db.from("event_attendees").delete().eq("event_code", code);
    for (let i = 0; i < rows.length; i += 500) { const { error } = await db.from("event_attendees").insert(rows.slice(i, i + 500)); if (error) throw new Error(error.message); }
    return json({ ok: true, attendees: rows.length, members: T.status["Member"] ?? 0, matched: rows.filter((r) => r.org_id).length }, 200, h);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 502, h);
  }
});
