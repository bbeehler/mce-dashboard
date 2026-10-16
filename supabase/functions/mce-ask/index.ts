// mce-ask: answers questions about the MCE dashboard data with Claude.
//
//   POST {action:"status"}                                   -> {ready, key, passcode} (no secrets returned)
//   POST {action:"check", passcode}                          -> {ok:true} if the passcode is right
//   POST {action:"ask", passcode, question, month, view, history:[{q,a}]}
//
// Monthly brief (upload passcode, MCE_UPLOAD_PASSCODE):
//   POST {action:"brief_generate", passcode, period}               -> Claude writes a draft brief for the month
//   POST {action:"brief_get", passcode, period?}                    -> the brief (draft or approved) and the list of months
//   POST {action:"brief_save", passcode, period, subject, body_md}  -> save edits to the draft
//   POST {action:"brief_approve", passcode, period, subject, body_md} -> approve; the approved feed then emails Emily
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

async function uploadOk(given: unknown) {
  const real = Deno.env.get("MCE_UPLOAD_PASSCODE");
  if (!real || typeof given !== "string" || !given) return false;
  const [a, b] = await Promise.all([sha(given), sha(real)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const isPeriod = (p: unknown) => typeof p === "string" && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(p);
const monthName = (p: string) => new Date(p + "T12:00:00Z").toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });

const BRIEF_SYSTEM = `You write the monthly MCE brief for AIA Canada (Automotive Industries Association of Canada; brands AIA Canada, CCIF, YPA, I-CAR Canada). The reader is the President & CEO, Emily Chung; the sender is Brian Beehler, Director of Digital Marketing, Communications and Engagement. It is read in an email in under two minutes.

Write in exactly this format (Markdown), nothing before or after:
Subject: <MCE brief, Month YYYY: a short phrase naming the main story, under 70 characters in total>

<One or two sentences: the overall story of the month.>

## What moved
- <3 to 5 bullets. Each one sentence with the number and its comparison: previous month, same month last year, or target pace.>

## Watch
- <1 to 3 bullets: risks or things going the wrong way, with numbers.>

## Next month
- <1 to 3 bullets: concrete actions or decisions the team proposes.>

Rules:
- Use only the data given. Never invent numbers. If an important source isn't uploaded for the month, say so in Watch.
- Compare like with like: when you compare two months, use exactly the same measure for both. For email, use the open rate, click rate and opt-outs per broad send from the derived monthly measures table (all email), and only mention a main-list rate if you give it for both months.
- Before writing each number, check it against the tables; round percentages to one decimal.
- Cover the month asked about; use year to date only where it explains progress against yearly targets.
- Use the team's chart notes and the sentiment notes for context on spikes and dips.
- Membership and sponsorship come live from Insightly; events from PheedLoop.
- Plain language, Canadian spelling, no jargon, no headings other than the three above, 170 to 260 words in total. Bold at most one number per bullet.`;

async function claude(key: string, system: string, messages: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, output_config: { effort: "medium" }, system, messages }),
  });
  const j = await r.json().catch(() => ({}));
  return { r, j, text: (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim() };
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
    all("events", "code,name,start_date,end_date,capacity,target_registrations,target_revenue,prior_code,merged_into,attendance_manual"),
    all("event_snapshots", "event_code,period,registrations,revenue,attendance"),
  ]);

  // Monthly tables per source: rows = metric (· dimension), columns = months.
  const months = [...new Set(metrics.map((m) => m.period.slice(0, 7)))].sort();
  const val: Record<string, number> = {};
  for (const m of metrics) val[`${m.source}|${m.metric}|${m.dimension}|${m.period.slice(0, 7)}`] = Number(m.value);
  const get = (s: string, m: string, d: string, p: string) => val[`${s}|${m}|${d}|${p}`] ?? null;
  const lines: string[] = [];
  for (const src of ["ga4", "insightly", "social", "sentiment"]) {
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

  // Net sentiment per month and what drove it.
  const { data: notes } = await db.from("month_notes").select("period,topic,note").eq("topic", "sentiment");
  const sm = months.filter((p) => get("sentiment", "sent_positive", "", p) != null);
  if (sm.length) {
    lines.push(`\n## Net sentiment (positive minus negative as a share of all mentions, -100 to +100)\nmonth | net score | what drove it`);
    for (const p of sm) {
      const a = get("sentiment", "sent_positive", "", p) ?? 0, b = get("sentiment", "sent_neutral", "", p) ?? 0, c = get("sentiment", "sent_negative", "", p) ?? 0, t = a + b + c;
      lines.push(`${p} | ${t ? Math.round(((a - c) / t) * 100) : ""} | ${(notes ?? []).find((n: any) => n.period.slice(0, 7) === p)?.note ?? ""}`);
    }
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
    lines.push(`${e.name} | ${alias[e.code] ?? ""} | ${e.start_date}${e.end_date && e.end_date !== e.start_date ? "–" + e.end_date : ""} | ${e.capacity ?? ""} | ${e.target_registrations ?? ""} | ${e.target_revenue ?? ""} | ${e.prior_code ?? ""} | ${ss.map((s) => `${s.period.slice(0, 7)}:${s.registrations}`).join(", ")} | ${rev ? Math.round(Number(rev.revenue)) : ""} | ${e.attendance_manual ?? (att ? att.attendance : "")}`);
  }

  if (targets.length) {
    lines.push(`\n## Yearly targets\nyear | stream | measure | target | better`);
    for (const t of targets) lines.push(`${t.year} | ${t.stream} | ${t.metric}${t.dimension ? " · " + t.dimension : ""} | ${t.target} | ${t.better}`);
  } else lines.push(`\n## Yearly targets\nNone set yet.`);

  // Membership, live from Insightly (totals only).
  try {
    const { data: last } = await db.from("member_snap").select("as_of,year").order("as_of", { ascending: false }).limit(1).maybeSingle();
    if (last) {
      const snap = await all("member_snap", "metric,dimension,value", (q) => q.eq("as_of", last.as_of));
      const mon = await all("member_monthly", "period,metric,value", (q) => q.order("period"));
      const v = (m: string) => snap.find((r: any) => r.metric === m && !r.dimension)?.value ?? "";
      lines.push(`\n## Membership, live from Insightly as of ${last.as_of} (membership year ${last.year}; member = last membership year ${last.year} or later; 2050 = lifetime/complimentary, mostly Industry Engagement Network affiliates)`);
      lines.push(`members ${v("members")} (lifetime ${v("lifetime")}) | renewed ${v("renewed")} | new ${v("new")} | returning ${v("returning")} | ${last.year - 1} members not renewed ${v("not_renewed")} (of which resigned/non-renewed ${v("not_renewed_resigned")}) | renewal rate ${pc(Number(v("renewal_rate")))} | dues before tax ${v("dues")} | paid incl. tax ${v("paid")} | already renewed for next year ${v("renewed_next")}`);
      const mix = snap.filter((r: any) => r.metric === "mix").map((r: any) => `${r.dimension}=${r.value}`);
      lines.push(`member mix: ${mix.join("; ")}`);
      lines.push(`monthly flows (payments and dues_paid are the current renewal cycle by month of each member's latest payment; joined by AIAC Joined Date; resigned by resignation date)\nmonth | payments | dues_paid | joined | resigned`);
      const ps = [...new Set(mon.map((r: any) => r.period.slice(0, 7)))].sort();
      const mv = (p: string, m: string) => mon.find((r: any) => r.period.slice(0, 7) === p && r.metric === m)?.value ?? "";
      for (const p of ps) lines.push(`${p} | ${mv(p, "payments")} | ${mv(p, "dues_paid")} | ${mv(p, "joined")} | ${mv(p, "resigned")}`);
    }
  } catch { /* membership is optional */ }

  // Sponsorship totals from Insightly, and the team's notes on the charts.
  try {
    const sp = await all("sponsorship_totals", "year,program,level,deals,invoiced,paid_deals,paid", (q) => q.gte("year", new Date().getUTCFullYear() - 2).order("year"));
    if (sp.length) {
      lines.push(`\n## Sponsorship (Insightly Sponsorship records, by sponsorship year; CCIF combines both forums; program "AIA Canada" = annual corporate partners such as Maple Leaf and Gold)\nyear | program | level | sponsorships | invoiced | paid invoices | paid amount`);
      for (const r of sp) lines.push(`${r.year} | ${r.program} | ${r.level} | ${r.deals} | ${Math.round(Number(r.invoiced))} | ${r.paid_deals} | ${Math.round(Number(r.paid))}`);
    }
    const cn = await all("month_notes", "period,topic,note", (q) => q.like("topic", "chart:%").order("period"));
    if (cn.length) {
      lines.push(`\n## Team notes on the charts (context for spikes and dips)\nmonth | applies to | note`);
      for (const n of cn) lines.push(`${n.period.slice(0, 7)} | ${n.topic.slice(6)} | ${n.note}`);
    }
  } catch { /* optional */ }

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
- Targets are yearly; totals are paced evenly across the year.
- Membership: renewals cluster November to March because that is when invoices and reminders go out. When relating marketing activity to membership, describe timing and overlap, not proven cause, and say that campaign tracking links would be needed to attribute members to campaigns.`;

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, h);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }

  const key = Deno.env.get("ANTHROPIC_API_KEY");

  // ---------- monthly brief (upload passcode) ----------
  if (typeof body.action === "string" && body.action.startsWith("brief_")) {
    if (!(await uploadOk(body.passcode))) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "That passcode isn't right." }, 401, h); }
    const { period } = body;
    if (body.action === "brief_get") {
      const { data: list } = await db.from("briefs").select("period,status,subject,generated_at,approved_at").order("period", { ascending: false }).limit(24);
      const want = isPeriod(period) ? period : list?.[0]?.period;
      const { data: brief } = want ? await db.from("briefs").select("*").eq("period", want).maybeSingle() : { data: null };
      return json({ list: list ?? [], brief }, 200, h);
    }
    if (!isPeriod(period)) return json({ error: "Choose the month." }, 400, h);
    if (body.action === "brief_save" || body.action === "brief_approve") {
      const subject = typeof body.subject === "string" ? body.subject.trim() : "", text = typeof body.body_md === "string" ? body.body_md.trim() : "";
      if (!subject || subject.length > 150 || !text || text.length > 6000) return json({ error: "The subject or text is empty or too long." }, 400, h);
      const now = new Date().toISOString();
      const upd: Record<string, unknown> = { subject, body_md: text, edited_at: now };
      if (body.action === "brief_approve") Object.assign(upd, { status: "approved", approved_at: now });
      const { data, error } = await db.from("briefs").update(upd).eq("period", period).select("period,status,approved_at").maybeSingle();
      if (error) return json({ error: `Saving the brief failed: ${error.message}` }, 500, h);
      if (!data) return json({ error: "There's no brief for that month yet. Write one first." }, 404, h);
      return json({ ok: true, brief: data }, 200, h);
    }
    if (body.action === "brief_generate") {
      if (!key) return json({ error: "The Claude API key isn't set up (ANTHROPIC_API_KEY)." }, 503, h);
      const { count } = await db.from("ask_log").select("id", { count: "exact", head: true }).gte("asked_at", new Date(Date.now() - 864e5).toISOString());
      if ((count ?? 0) >= DAILY_CAP) return json({ error: "The daily limit for Claude has been reached. Try again tomorrow." }, 429, h);
      const log: Record<string, unknown> = { question: `[monthly brief] ${period.slice(0, 7)}` };
      try {
        const brief = await buildBrief();
        const { r, j, text } = await claude(key, BRIEF_SYSTEM, [{ role: "user", content: `<data>\n${brief}\n</data>\n\nToday is ${new Date().toISOString().slice(0, 10)}. Write the brief for ${monthName(period)} (month ${period.slice(0, 7)}).` }]);
        const inTok = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0);
        Object.assign(log, { ok: r.ok && !!text, input_tokens: inTok || null, output_tokens: j.usage?.output_tokens ?? null, note: r.ok ? (text ? null : "empty brief") : String(j?.error?.message ?? r.status).slice(0, 300) });
        await db.from("ask_log").insert(log);
        if (!r.ok || !text) return json({ error: r.ok ? "Claude didn't return a brief. Try again." : `Claude couldn't write the brief (${String(j?.error?.message ?? r.status).slice(0, 160)}).` }, 502, h);
        const m = text.match(/^\s*Subject:\s*(.+)$/im);
        const subject = (m ? m[1] : `MCE brief, ${monthName(period)}`).trim().slice(0, 150);
        const body_md = (m ? text.replace(m[0], "") : text).trim();
        const { data: old } = await db.from("briefs").select("version").eq("period", period).maybeSingle();
        const row = { period, status: "draft", subject, body_md, generated_at: new Date().toISOString(), edited_at: null, approved_at: null, version: (old?.version ?? 0) + 1, input_tokens: inTok || null, output_tokens: j.usage?.output_tokens ?? null };
        const { error } = await db.from("briefs").upsert(row, { onConflict: "period" });
        if (error) return json({ error: `Saving the brief failed: ${error.message}` }, 500, h);
        return json({ ok: true, brief: row }, 200, h);
      } catch (err) {
        Object.assign(log, { ok: false, note: String((err as Error).message ?? err).slice(0, 300) });
        await db.from("ask_log").insert(log);
        return json({ error: "Something went wrong preparing the data. Try again in a minute." }, 500, h);
      }
    }
    return json({ error: "Unknown action." }, 400, h);
  }

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
      // Thinking tokens count toward max_tokens, so leave plenty of room for the written answer.
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, output_config: { effort: "medium" }, system: SYSTEM, messages }),
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
    const inTok = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0);
    Object.assign(log, { ok: !!answer, input_tokens: inTok || null, output_tokens: j.usage?.output_tokens ?? null, note: answer ? null : `empty answer (stop: ${j.stop_reason})` });
    await db.from("ask_log").insert(log);
    if (!answer) return json({ error: "Claude ran out of room before writing an answer. Try asking a narrower question." }, 502, h);
    return json({ answer }, 200, h);
  } catch (err) {
    Object.assign(log, { ok: false, note: String((err as Error).message ?? err).slice(0, 300) });
    await db.from("ask_log").insert(log);
    return json({ error: "Something went wrong preparing the data. Try again in a minute." }, 500, h);
  }
});
