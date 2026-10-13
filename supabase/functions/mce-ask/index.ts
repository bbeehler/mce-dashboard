// mce-ask: answers questions about the MCE dashboard data with Claude.
//
//   POST {action:"status"}                                   -> {ready, key, passcode} (no secrets returned)
//   POST {action:"check", passcode}                          -> {ok:true} if the passcode is right
//   POST {action:"ask", passcode, question, month, view, history:[{q,a}]}
//
// Secrets: ANTHROPIC_API_KEY (Claude API) and MCE_ASK_PASSCODE (the question box passcode).
// The function reads the dashboard tables with the service role, builds a compact data brief,
// and sends it with the question to Claude. Every question is logged in ask_log (question,
// success, token counts) and capped per day to keep cost predictable.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const MODEL = "claude-sonnet-5-5";
const DAILY_CAP = 150;
const EBLAST_URL = "https://bbeehler.github.io/eblast-calendar/data.json";

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
  const real = Deno.env.get("MCE_ASK_PASSCODE");
  if (!real || typeof given !== "string" || !given) return false;
  const [a, b] = await Promise.all([sha(given), sha(real)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function all(table: string, select: string, filter?: (q: any) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const pc = (n: number | null) => (n == null ? "" : `${r1(n * 100)}%`);

// ---------- the data brief ----------
async function buildBrief() {
  const since = `${new Date().getUTCFullYear() - 1}-01-01`;
  const [metrics, targets, events, snaps] = await Promise.all([
    all("metric_values", "period,source,metric,dimension,value", (q) => q.eq("brand", "All").gte("period", since).not("metric", "like", "%_ytd")),
    all("targets", "year,stream,source,metric,dimension,target,better"),
    all("events", "code,name,start_date,end_date,capacity,target_registrations,target_revenue,prior_code,merged_into"),
    all("event_snapshots", "event_code,period,registrations,revenue,attendance"),
  ]);

  // Monthly tables per source: rows = metric (· dimension), columns = months.
  const months = [...new Set(metrics.map((m) => m.period.slice(0, 7)))].sort();
  const val: Record<string, number> = {};
  for (const m of metrics) val[`${m.source}|${m.metric}|${m.dimension}|${m.period.slice(0, 7)}`] = Number(m.value);
  const get = (s: string, m: string, d: string, p: string) => val[`${s}|${m}|${d}|${p}`] ?? null;
  const lines: string[] = [];
  for (const src of ["ga4", "insightly", "social"]) {
    const keys = [...new Set(metrics.filter((m) => m.source === src).map((m) => `${m.metric}|${m.dimension}`))].sort();
    const used = months.filter((p) => keys.some((k) => get(src, k.split("|")[0], k.split("|")[1], p) != null));
    if (!keys.length) continue;
    lines.push(`\n## ${src} (monthly totals)\nmeasure | ${used.join(" | ")}`);
    for (const k of keys) {
      const [m, d] = k.split("|");
      lines.push(`${m}${d ? " · " + d : ""} | ${used.map((p) => get(src, m, d, p) ?? "").join(" | ")}`);
    }
  }

  // Derived monthly rates, so answers don't need arithmetic.
  lines.push(`\n## Derived monthly measures\nmonth | engaged rate | org-social share of sessions | key events per 1k engaged | open rate | click rate | opt-outs per broad send | broad sends | flag`);
  for (const p of months) {
    const s = get("ga4", "sessions", "", p), en = get("ga4", "engaged_sessions", "", p), ke = get("ga4", "key_events", "", p), os = get("ga4", "sessions", "Organic Social", p);
    const dl = get("insightly", "delivered", "", p), op = get("insightly", "unique_opens", "", p), cl = get("insightly", "unique_clicks", "", p);
    const bs = get("insightly", "broad_sends_main_list", "", p), oo = get("insightly", "opt_outs_main_list", "", p);
    const share = s && os != null ? os / s : null, er = s && en != null ? en / s : null;
    const flag = share != null && er != null && share > 0.5 && er < 0.25 ? "low-quality traffic spike" : "";
    lines.push(`${p} | ${pc(er)} | ${pc(share)} | ${en && ke != null ? r1((ke / en) * 1000) : ""} | ${dl && op != null ? pc(op / dl) : ""} | ${dl && cl != null ? pc(cl / dl) : ""} | ${bs && oo != null ? r1(oo / bs) : ""} | ${bs ?? ""} | ${flag}`);
  }

  // Events: PheedLoop events with targets, short codes and month-end registration history.
  const alias: Record<string, string> = {};
  for (const e of events) if (e.merged_into) alias[e.merged_into] = alias[e.merged_into] ?? e.code;
  const real = events.filter((e) => !e.merged_into && !/\btest(ing)?\b/i.test(e.name ?? ""));
  lines.push(`\n## Events (registrations from PheedLoop; month-end snapshots)\nname | short code | start | capacity | target regs | target revenue | last year's code | registrations by month-end | latest revenue | attendance`);
  for (const e of real.sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    const ss = snaps.filter((s) => s.event_code === e.code).sort((a, b) => a.period.localeCompare(b.period));
    const rev = [...ss].reverse().find((s) => s.revenue != null && Number(s.revenue) > 0);
    const att = [...ss].reverse().find((s) => s.attendance != null);
    lines.push(`${e.name} | ${alias[e.code] ?? ""} | ${e.start_date}${e.end_date && e.end_date !== e.start_date ? "–" + e.end_date : ""} | ${e.capacity ?? ""} | ${e.target_registrations ?? ""} | ${e.target_revenue ?? ""} | ${e.prior_code ?? ""} | ${ss.map((s) => `${s.period.slice(0, 7)}:${s.registrations}`).join(", ")} | ${rev ? Math.round(Number(rev.revenue)) : ""} | ${att ? att.attendance : ""}`);
  }

  if (targets.length) {
    lines.push(`\n## Yearly targets\nyear | stream | measure | target | better`);
    for (const t of targets) lines.push(`${t.year} | ${t.stream} | ${t.metric}${t.dimension ? " · " + t.dimension : ""} | ${t.target} | ${t.better}`);
  } else lines.push(`\n## Yearly targets\nNone set yet.`);

  // Send plan from the eBlast calendar (next 8 weeks).
  try {
    const r = await fetch(EBLAST_URL, { headers: { "cache-control": "no-cache" } });
    if (r.ok) {
      const d = await r.json();
      const today = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 56 * 864e5).toISOString().slice(0, 10);
      const up = (d.sends ?? []).filter((s: any) => s.d >= today && s.d <= end && s.s !== "X");
      lines.push(`\n## eBlast send plan, next 8 weeks (from Wrike; broad = to 1,000+ on the main list)\ndate | title | broad`);
      for (const s of up) lines.push(`${s.d} | ${s.t} | ${s.b ? "yes" : "no"}`);
    }
  } catch { /* send plan is optional */ }
  return lines.join("\n");
}

const SYSTEM = `You are the analyst behind AIA Canada's MCE Executive Dashboard (Marketing, Communications and Engagement). AIA Canada is the Automotive Industries Association of Canada; its brands are AIA Canada, CCIF, YPA and I-CAR Canada. The people asking are its president and the MarComms team. Help them make decisions from the data below.

How to answer:
- Lead with the answer or recommendation in one or two sentences, then the evidence (specific numbers and months from the data), then any caveat. Keep it under about 250 words unless asked for more.
- Use only the data provided. If something isn't in it (a missing month, a breakdown that isn't uploaded, causes the data can't show), say so plainly and suggest what data would answer it. Never invent numbers.
- Do arithmetic carefully; prefer the derived measures table where it has the figure.
- Use plain language, Canadian spelling, short paragraphs or short bullet lists. No tables unless asked. No headings.

House rules the team works by:
- Website: judge traffic by engaged sessions and key events, not raw sessions. Months flagged "low-quality traffic spike" (mostly Organic Social, under 25% engaged) are likely boosted posts or bots.
- Email: the 2026 send audit sets about 9 broad emails a month per member on the main list, at most 2 broad sends a week, never two the same day, reminder series stopping at 3, and one partner email a month. Opt-outs per broad send is the fatigue signal.
- Events: compare registrations with target and, where linked, with last year's event at the same number of months out.
- Targets are yearly; totals are paced evenly across the year.`;

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, h);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (body.action === "status") return json({ ready: !!key && !!Deno.env.get("MCE_ASK_PASSCODE"), key: !!key, passcode: !!Deno.env.get("MCE_ASK_PASSCODE") }, 200, h);
  if (!key || !Deno.env.get("MCE_ASK_PASSCODE")) return json({ error: "Questions aren't switched on yet (a Supabase secret is missing)." }, 503, h);

  if (!(await passcodeOk(body.passcode))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: "That passcode isn't right." }, 401, h);
  }
  if (body.action === "check") return json({ ok: true }, 200, h);
  if (body.action !== "ask") return json({ error: "Unknown action." }, 400, h);

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 1000) return json({ error: "Ask a question of up to 1,000 characters." }, 400, h);
  const { count } = await db.from("ask_log").select("id", { count: "exact", head: true }).gte("asked_at", new Date(Date.now() - 864e5).toISOString());
  if ((count ?? 0) >= DAILY_CAP) return json({ error: `The daily limit of ${DAILY_CAP} questions has been reached. Try again tomorrow.` }, 429, h);

  const log: Record<string, unknown> = { question: question.slice(0, 1000) };
  try {
    const brief = await buildBrief();
    const view = `The person is looking at ${typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : "the latest month"} in the ${body.view === "ytd" ? "year-to-date" : "monthly"} view. Today is ${new Date().toISOString().slice(0, 10)}.`;
    const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
    const messages: any[] = [];
    history.forEach((t: any, i: number) => {
      const q = typeof t?.q === "string" ? t.q.slice(0, 1000) : "", a = typeof t?.a === "string" ? t.a.slice(0, 4000) : "";
      if (q && a) messages.push({ role: "user", content: i === 0 ? [{ type: "text", text: `<data>\n${brief}\n</data>`, cache_control: { type: "ephemeral" } }, { type: "text", text: `${view}\n\n${q}` }] : q }, { role: "assistant", content: a });
    });
    if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: `<data>\n${brief}\n</data>`, cache_control: { type: "ephemeral" } }, { type: "text", text: `${view}\n\n${question}` }] });
    else messages.push({ role: "user", content: question });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error?.message ?? `status ${r.status}`;
      Object.assign(log, { ok: false, note: msg.slice(0, 300) });
      await db.from("ask_log").insert(log);
      const friendly = r.status === 401 ? "The Claude API key isn't valid. Check the ANTHROPIC_API_KEY secret in Supabase."
        : r.status === 429 ? "Claude is busy or the API spending limit was reached. Try again in a minute."
        : r.status === 400 && /credit|balance|billing/i.test(msg) ? "The Claude API account needs credit. Add billing in the Claude Console."
        : `Claude couldn't answer (${msg.slice(0, 160)}).`;
      return json({ error: friendly }, 502, h);
    }
    const answer = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    Object.assign(log, { ok: true, input_tokens: j.usage?.input_tokens ?? null, output_tokens: j.usage?.output_tokens ?? null });
    await db.from("ask_log").insert(log);
    return json({ answer }, 200, h);
  } catch (err) {
    Object.assign(log, { ok: false, note: String((err as Error).message ?? err).slice(0, 300) });
    await db.from("ask_log").insert(log);
    return json({ error: "Something went wrong preparing the data. Try again in a minute." }, 500, h);
  }
});
