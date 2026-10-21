// mce-upload: saves a month of MCE dashboard numbers when the request carries the upload passcode.
//
//   POST {action:"check", passcode}                      -> {ok:true} if the passcode is right
//   POST {action:"history", passcode}                    -> last 12 uploads
//   POST {action:"save", passcode, period, metrics, events, targets, filename}
//   POST {action:"targets", passcode, year, targets}        -> set or clear yearly targets
//   POST {action:"attendance", passcode, items:[{code, attendance}]} -> set or clear event attendance
//   POST {action:"sentiment", passcode, period, positive, neutral, negative, note} -> monthly sentiment
//   POST {action:"note", passcode, period, topic:"chart:<stream>", note|null}       -> note shown on the dashboard charts
//
// The passcode lives only in the MCE_UPLOAD_PASSCODE secret. Writes use the service role,
// so the public site never holds a key that can change data.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const STREAMS = new Set(["marketing", "communications", "engagement", "membership"]);
const SOURCES = new Set(["ga4", "insightly", "social", "pheedloop", "sentiment"]);

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

  // Targets entered on the upload page: {year, targets:[{stream,source,metric,dimension,better,target|null}]}; null clears a target.
  if (body.action === "targets") {
    const { year, targets } = body;
    if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Array.isArray(targets) || targets.length > 100) return json({ error: "The targets are in the wrong format." }, 400, h);
    const bad = targets.some((t: any) => !STREAMS.has(t?.stream) || !str(t?.source, 40) || !str(t?.metric, 80) || typeof (t?.dimension ?? "") !== "string" || !["higher", "lower"].includes(t?.better) || !(t.target === null || (typeof t.target === "number" && Number.isFinite(t.target) && t.target >= 0)));
    if (bad) return json({ error: "One of the targets isn't valid." }, 400, h);
    const set = targets.filter((t: any) => t.target !== null).map((t: any) => ({ year, stream: t.stream, source: t.source, brand: "All", metric: t.metric, dimension: t.dimension ?? "", target: t.target, better: t.better }));
    if (set.length) {
      const { error } = await db.from("targets").upsert(set, { onConflict: "year,stream,source,brand,metric,dimension" });
      if (error) return json({ error: `Saving the targets failed: ${error.message}` }, 500, h);
    }
    for (const t of targets.filter((t: any) => t.target === null)) {
      const { error } = await db.from("targets").delete().match({ year, stream: t.stream, source: t.source, brand: "All", metric: t.metric, dimension: t.dimension ?? "" });
      if (error) return json({ error: `Clearing a target failed: ${error.message}` }, 500, h);
    }
    return json({ ok: true, saved: targets.length }, 200, h);
  }

  // Attendance entered on the upload page: {items:[{code, attendance|null}]}; null clears the entered number.
  if (body.action === "attendance") {
    const items = body.items;
    if (!Array.isArray(items) || !items.length || items.length > 200) return json({ error: "The attendance list is in the wrong format." }, 400, h);
    if (items.some((i: any) => !str(i?.code, 40) || !(i.attendance === null || (Number.isInteger(i.attendance) && i.attendance >= 0 && i.attendance < 1000000)))) return json({ error: "Attendance must be a whole number." }, 400, h);
    for (const i of items) {
      const { data: row } = await db.from("events").select("code,merged_into").eq("code", i.code.trim()).maybeSingle();
      if (!row) return json({ error: `Event ${i.code} wasn't found.` }, 400, h);
      const { error } = await db.from("events").update({ attendance_manual: i.attendance }).eq("code", row.merged_into ?? row.code);
      if (error) return json({ error: `Saving attendance for ${i.code} failed: ${error.message}` }, 500, h);
    }
    return json({ ok: true, saved: items.length }, 200, h);
  }

  // Monthly sentiment: {period, positive, neutral, negative, note}. Counts or percentages both work, since the
  // dashboard only uses their proportions. All three blank (null) clears the month.
  if (body.action === "sentiment") {
    const { period, positive, neutral, negative, note } = body;
    if (!isPeriod(period)) return json({ error: "Choose the month." }, 400, h);
    const vals = [positive, neutral, negative];
    const blank = vals.every((v) => v === null);
    if (!blank && vals.some((v) => !(typeof v === "number" && Number.isFinite(v) && v >= 0))) return json({ error: "Positive, neutral and negative must all be numbers (counts or percentages)." }, 400, h);
    if (!blank && positive + neutral + negative <= 0) return json({ error: "At least one of positive, neutral or negative must be above zero." }, 400, h);
    if (note != null && (typeof note !== "string" || note.length > 1000)) return json({ error: "Keep the themes note under 1,000 characters." }, 400, h);
    const keys = ["sent_positive", "sent_neutral", "sent_negative"];
    if (blank) {
      const { error } = await db.from("metric_values").delete().eq("period", period).eq("source", "sentiment");
      if (error) return json({ error: `Clearing sentiment failed: ${error.message}` }, 500, h);
    } else {
      const rows = keys.map((k, i) => ({ period, stream: "communications", source: "sentiment", brand: "All", metric: k, dimension: "", value: vals[i], updated_by: "upload page" }));
      const { error } = await db.from("metric_values").upsert(rows, { onConflict: "period,source,brand,metric,dimension" });
      if (error) return json({ error: `Saving sentiment failed: ${error.message}` }, 500, h);
    }
    const text = typeof note === "string" ? note.trim() : "";
    const { error: ne } = text && !blank
      ? await db.from("month_notes").upsert({ period, topic: "sentiment", note: text, updated_at: new Date().toISOString() }, { onConflict: "period,topic" })
      : await db.from("month_notes").delete().eq("period", period).eq("topic", "sentiment");
    if (ne) return json({ error: `Saving the themes note failed: ${ne.message}` }, 500, h);
    return json({ ok: true }, 200, h);
  }

  // Sentiment counts come from the media monitoring tool (sentiment-sync); only the "what drove it" note is typed.
  if (body.action === "sentiment_note") {
    const { period, note } = body;
    if (!isPeriod(period)) return json({ error: "Choose the month." }, 400, h);
    if (note != null && (typeof note !== "string" || note.length > 1000)) return json({ error: "Keep the note under 1,000 characters." }, 400, h);
    const text = typeof note === "string" ? note.trim() : "";
    const { error } = text
      ? await db.from("month_notes").upsert({ period, topic: "sentiment", note: text, updated_at: new Date().toISOString() }, { onConflict: "period,topic" })
      : await db.from("month_notes").delete().eq("period", period).eq("topic", "sentiment");
    if (error) return json({ error: `Saving the note failed: ${error.message}` }, 500, h);
    return json({ ok: true }, 200, h);
  }

  // Chart notes: {period, topic:"chart:<stream>", note|null}. Shown as markers on the dashboard charts; null removes it.
  if (body.action === "note") {
    const { period, topic, note } = body;
    if (!isPeriod(period)) return json({ error: "Choose the month." }, 400, h);
    if (!["chart:all", "chart:marketing", "chart:communications", "chart:engagement", "chart:membership"].includes(topic)) return json({ error: "Choose which charts the note shows on." }, 400, h);
    if (note != null && (typeof note !== "string" || !note.trim() || note.length > 200)) return json({ error: "Keep the note under 200 characters." }, 400, h);
    const { error } = note
      ? await db.from("month_notes").upsert({ period, topic, note: note.trim(), updated_at: new Date().toISOString() }, { onConflict: "period,topic" })
      : await db.from("month_notes").delete().eq("period", period).eq("topic", topic);
    if (error) return json({ error: `Saving the note failed: ${error.message}` }, 500, h);
    return json({ ok: true }, 200, h);
  }

  if (body.action !== "save") return json({ error: "Unknown action." }, 400, h);

  // ---- validate ----
  const { period, metrics = [], events = [], targets = [], filename = null } = body;
  const problems: string[] = [];
  if (!isPeriod(period)) problems.push("The reporting month is missing or not valid.");
  if (!Array.isArray(metrics) || !Array.isArray(events) || !Array.isArray(targets)) problems.push("The upload is in the wrong format.");
  if (Array.isArray(targets) && targets.length > 100) problems.push("The upload has too many targets.");
  if (metrics.length > 2000 || events.length > 200) problems.push("The upload has too many rows.");
  metrics.forEach((m: any, i: number) => {
    if (!STREAMS.has(m?.stream) || !SOURCES.has(m?.source) || !str(m?.metric, 80) || typeof m?.value !== "number" || !Number.isFinite(m.value) || m.value < 0) problems.push(`Number ${i + 1} isn't valid.`);
  });
  events.forEach((e: any, i: number) => {
    if (!str(e?.code, 40) || (e?.name != null && !str(e?.name)) || !isDate(e?.start_date) || !isDate(e?.end_date)) problems.push(`Event row ${i + 1} needs a valid event code and dates.`);
    for (const k of ["capacity", "target_registrations", "target_revenue", "registrations", "revenue", "attendance"]) if (!isNum(e?.[k])) problems.push(`Event row ${i + 1}: ${k.replace(/_/g, " ")} isn't a number.`);
  });
  if (Array.isArray(targets)) targets.forEach((t: any, i: number) => {
    if (!Number.isInteger(t?.year) || t.year < 2020 || t.year > 2100 || !STREAMS.has(t?.stream) || !str(t?.source, 40) || !str(t?.metric, 80) || typeof t?.target !== "number" || !Number.isFinite(t.target) || t.target < 0 || !["higher", "lower"].includes(t?.better)) problems.push(`Target ${i + 1} isn't valid.`);
  });
  if (problems.length) return json({ error: problems.slice(0, 10).join(" ") }, 400, h);

  // ---- save ----
  // Once LinkedIn is connected, its numbers come from the LinkedIn sync, so uploaded LinkedIn rows are skipped
  // from the connection month on.
  let skippedLinkedIn = 0;
  const { data: li } = await db.from("app_settings").select("key,value").in("key", ["linkedin_access_token", "linkedin_since"]);
  const liOn = (li ?? []).some((r: any) => r.key === "linkedin_access_token"), liSince = (li ?? []).find((r: any) => r.key === "linkedin_since")?.value;
  if (liOn && liSince && period >= liSince) {
    const before = metrics.length;
    for (let i = metrics.length - 1; i >= 0; i--) if (metrics[i].source === "social" && metrics[i].dimension === "LinkedIn") metrics.splice(i, 1);
    skippedLinkedIn = before - metrics.length;
  }
  // Same for Facebook and Instagram once the Pages are connected. Meta no longer reports link clicks for a whole
  // Page, so the Facebook link clicks row from the template is still saved.
  let skippedMeta = 0;
  const { data: mt } = await db.from("app_settings").select("key,value").in("key", ["meta_pages", "meta_since"]);
  const mtOn = (mt ?? []).some((r: any) => r.key === "meta_pages"), mtSince = (mt ?? []).find((r: any) => r.key === "meta_since")?.value;
  if (mtOn && mtSince && period >= mtSince) {
    const before = metrics.length;
    for (let i = metrics.length - 1; i >= 0; i--) if (metrics[i].source === "social" && (metrics[i].dimension === "Instagram" || (metrics[i].dimension === "Facebook" && metrics[i].metric !== "link_clicks"))) metrics.splice(i, 1);
    skippedMeta = before - metrics.length;
  }
  // Sentiment comes from the media monitoring tool, so any sentiment rows in a file are ignored.
  for (let i = metrics.length - 1; i >= 0; i--) if (metrics[i].source === "sentiment") metrics.splice(i, 1);
  if (metrics.length) {
    const rows = metrics.map((m: any) => ({ period, stream: m.stream, source: m.source, brand: "All", metric: m.metric, dimension: typeof m.dimension === "string" ? m.dimension : "", value: m.value, updated_by: "upload page" }));
    const { error } = await db.from("metric_values").upsert(rows, { onConflict: "period,source,brand,metric,dimension" });
    if (error) return json({ error: `Saving the numbers failed: ${error.message}` }, 500, h);
  }
  if (targets.length) {
    const rows = targets.map((t: any) => ({ year: t.year, stream: t.stream, source: t.source, brand: "All", metric: t.metric, dimension: typeof t.dimension === "string" ? t.dimension : "", target: t.target, better: t.better }));
    const { error } = await db.from("targets").upsert(rows, { onConflict: "year,stream,source,brand,metric,dimension" });
    if (error) return json({ error: `Saving the targets failed: ${error.message}` }, 500, h);
  }
  for (const e of events) {
    // A hand-typed code (e.g. CN2026) may be linked to its PheedLoop event; save to that event instead.
    const typed = e.code.trim();
    const { data: alias } = await db.from("events").select("merged_into").eq("code", typed).maybeSingle();
    const code = alias?.merged_into ?? typed;
    const fields: Record<string, unknown> = {};
    // Name and dates of a PheedLoop event come from PheedLoop, so a linked code only updates targets and history.
    const keys = alias?.merged_into ? ["capacity", "target_registrations", "target_revenue", "prior_code"] : ["name", "start_date", "end_date", "capacity", "target_registrations", "target_revenue", "prior_code"];
    for (const k of keys) if (e[k] != null && e[k] !== "") fields[k] = typeof e[k] === "string" ? e[k].trim() : e[k];
    const { data: existing } = await db.from("events").select("code").eq("code", code).maybeSingle();
    if (existing) {
      if (Object.keys(fields).length) {
        const { error } = await db.from("events").update(fields).eq("code", code);
        if (error) return json({ error: `Saving event ${code} failed: ${error.message}` }, 500, h);
      }
    } else {
      if (!fields.name || !fields.start_date) return json({ error: `Event ${code} isn't in PheedLoop yet, so it needs a name and start date.` }, 400, h);
      const { error } = await db.from("events").insert({ code, ...fields });
      if (error) return json({ error: `Saving event ${code} failed: ${error.message}` }, 500, h);
    }
    // Registrations come from PheedLoop; only write a snapshot when the sheet provides numbers.
    if (e.registrations != null || e.revenue != null || e.attendance != null) {
      const { data: cur } = await db.from("event_snapshots").select("registrations").eq("event_code", code).eq("period", period).maybeSingle();
      const snap: Record<string, unknown> = { event_code: code, period, registrations: e.registrations ?? cur?.registrations ?? 0 };
      if (e.revenue != null) snap.revenue = e.revenue;
      if (e.attendance != null) snap.attendance = e.attendance;
      const { error } = await db.from("event_snapshots").upsert(snap, { onConflict: "event_code,period" });
      if (error) return json({ error: `Saving ${code} for this month failed: ${error.message}` }, 500, h);
    }
  }
  await db.from("uploads").insert({ period, uploaded_by: "upload page", filename: typeof filename === "string" ? filename.slice(0, 200) : null, rows_written: metrics.length + events.length + targets.length });
  return json({ ok: true, saved: metrics.length + events.length + targets.length, skipped_linkedin: skippedLinkedIn, skipped_meta: skippedMeta }, 200, h);
});
