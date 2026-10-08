// mce-upload: saves a month of MCE dashboard numbers when the request carries the upload passcode.
//
//   POST {action:"check", passcode}                      -> {ok:true} if the passcode is right
//   POST {action:"history", passcode}                    -> last 12 uploads
//   POST {action:"save", passcode, period, metrics, events, filename}
//
// The passcode lives only in the MCE_UPLOAD_PASSCODE secret. Writes use the service role,
// so the public site never holds a key that can change data.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const STREAMS = new Set(["marketing", "communications", "engagement"]);
const SOURCES = new Set(["ga4", "insightly", "social", "pheedloop"]);

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

async function sha(s: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function passcodeOk(given: unknown) {
  const real = Deno.env.get("MCE_UPLOAD_PASSCODE");
  if (!real || typeof given !== "string" || !given) return false;
  const [a, b] = await Promise.all([sha(given), sha(real)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const isPeriod = (p: unknown) => typeof p === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(p);
const isDate = (d: unknown) => d == null || (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
const isNum = (n: unknown) => n == null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
const str = (s: unknown, max = 200) => typeof s === "string" && s.trim().length > 0 && s.length <= max;

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, h);
  if (!Deno.env.get("MCE_UPLOAD_PASSCODE")) return json({ error: "The upload passcode hasn't been set up yet." }, 500, h);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }

  if (!(await passcodeOk(body.passcode))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json({ error: "That passcode isn't right." }, 401, h);
  }

  if (body.action === "check") return json({ ok: true }, 200, h);

  if (body.action === "history") {
    const { data, error } = await db.from("uploads").select("period,uploaded_at,filename,rows_written").order("uploaded_at", { ascending: false }).limit(12);
    return error ? json({ error: error.message }, 500, h) : json({ uploads: data }, 200, h);
  }

  if (body.action !== "save") return json({ error: "Unknown action." }, 400, h);

  // ---- validate ----
  const { period, metrics = [], events = [], filename = null } = body;
  const problems: string[] = [];
  if (!isPeriod(period)) problems.push("The reporting month is missing or not valid.");
  if (!Array.isArray(metrics) || !Array.isArray(events)) problems.push("The upload is in the wrong format.");
  if (metrics.length > 2000 || events.length > 200) problems.push("The upload has too many rows.");
  metrics.forEach((m: any, i: number) => {
    if (!STREAMS.has(m?.stream) || !SOURCES.has(m?.source) || !str(m?.metric, 80) || typeof m?.value !== "number" || !Number.isFinite(m.value) || m.value < 0) problems.push(`Number ${i + 1} isn't valid.`);
  });
  events.forEach((e: any, i: number) => {
    if (!str(e?.code, 40) || !str(e?.name) || !isDate(e?.start_date) || !e?.start_date || !isDate(e?.end_date)) problems.push(`Event row ${i + 1} needs a code, name and start date.`);
    for (const k of ["capacity", "target_registrations", "target_revenue", "registrations", "revenue", "attendance"]) if (!isNum(e?.[k])) problems.push(`Event row ${i + 1}: ${k.replace(/_/g, " ")} isn't a number.`);
    if (e?.registrations == null) problems.push(`Event row ${i + 1}: registrations to date is blank.`);
  });
  if (problems.length) return json({ error: problems.slice(0, 10).join(" ") }, 400, h);

  // ---- save ----
  if (metrics.length) {
    const rows = metrics.map((m: any) => ({ period, stream: m.stream, source: m.source, brand: "All", metric: m.metric, dimension: typeof m.dimension === "string" ? m.dimension : "", value: m.value, updated_by: "upload page" }));
    const { error } = await db.from("metric_values").upsert(rows, { onConflict: "period,source,brand,metric,dimension" });
    if (error) return json({ error: `Saving the numbers failed: ${error.message}` }, 500, h);
  }
  for (const e of events) {
    const ev: Record<string, unknown> = { code: e.code.trim(), name: e.name.trim(), start_date: e.start_date };
    for (const k of ["end_date", "capacity", "target_registrations", "target_revenue", "prior_code"]) if (e[k] != null && e[k] !== "") ev[k] = e[k];
    let { error } = await db.from("events").upsert(ev, { onConflict: "code" });
    if (error) return json({ error: `Saving event ${e.code} failed: ${error.message}` }, 500, h);
    const snap: Record<string, unknown> = { event_code: ev.code, period, registrations: e.registrations };
    if (e.revenue != null) snap.revenue = e.revenue;
    if (e.attendance != null) snap.attendance = e.attendance;
    ({ error } = await db.from("event_snapshots").upsert(snap, { onConflict: "event_code,period" }));
    if (error) return json({ error: `Saving registrations for ${e.code} failed: ${error.message}` }, 500, h);
  }
  await db.from("uploads").insert({ period, uploaded_by: "upload page", filename: typeof filename === "string" ? filename.slice(0, 200) : null, rows_written: metrics.length + events.length });
  return json({ ok: true, saved: metrics.length + events.length }, 200, h);
});
