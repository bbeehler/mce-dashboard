// One-time discovery run: learns PheedLoop's API shape for this account.
// Writes data/_probe/*.json with endpoint names, status codes, field names and counts.
// It never writes attendee values (names, emails, etc.). Event-level values are kept only for
// fields like name, code, dates and status so events can be matched to the dashboard.
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.PHEEDLOOP_API_KEY, SECRET = process.env.PHEEDLOOP_API_SECRET, ORG = process.env.PHEEDLOOP_ORG;
const OUT = "data/_probe";
await mkdir(OUT, { recursive: true });
const report = { ran: new Date().toISOString(), secrets: { PHEEDLOOP_API_KEY: !!KEY, PHEEDLOOP_API_SECRET: !!SECRET, PHEEDLOOP_ORG: !!ORG }, docs: {}, calls: [] };

/* 1. Public API reference (Postman-published docs) */
try {
  const html = await (await fetch("https://develop.pheedloop.com/")).text();
  await writeFile(`${OUT}/docs-page.html`, html);
  const owner = (html.match(/"ownerId"\s*:\s*"?(\d+)/) || [])[1];
  const pub = (html.match(/"publishedId"\s*:\s*"([^"]+)"/) || html.match(/"collectionId"\s*:\s*"([^"]+)"/) || [])[1];
  report.docs = { htmlBytes: html.length, ownerId: owner || null, publishedId: pub || null };
  if (owner && pub) {
    const r = await fetch(`https://documenter.gw.postman.com/api/collections/${owner}/${pub}?segregateAuth=true&versionTag=latest`);
    report.docs.collectionStatus = r.status;
    if (r.ok) {
      const col = await r.json();
      const flat = [];
      const walk = (items, path = []) => (items || []).forEach(it => {
        if (it.item) walk(it.item, [...path, it.name]);
        else flat.push({ folder: path.join(" / "), name: it.name, method: it.request?.method, url: typeof it.request?.url === "string" ? it.request.url : it.request?.url?.raw, description: (it.request?.description || "").slice(0, 400) });
      });
      walk(col.item);
      report.docs.endpoints = flat.length;
      await writeFile(`${OUT}/pheedloop-endpoints.json`, JSON.stringify(flat, null, 1));
    }
  }
} catch (e) { report.docs.error = String(e.message || e); }

/* 2. Authenticated calls: field names and counts only */
const SAFE_VALUE = /^(id|code|event_code|name|title|event_name|start|end|start_date|end_date|starts_at|ends_at|date|status|timezone|currency|is_live|published|type|ticket_type|category|count|total|price|amount)$/i;
function shape(v, depth = 0, keepValues = false) {
  if (Array.isArray(v)) return { type: "array", length: v.length, item: v.length ? shape(v[0], depth + 1, keepValues) : null };
  if (v && typeof v === "object") {
    if (depth > 4) return { type: "object" };
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = (keepValues && SAFE_VALUE.test(k) && (typeof x !== "object" || x === null)) ? { type: typeof x, value: x } : shape(x, depth + 1, keepValues);
    return { type: "object", keys: o };
  }
  return { type: v === null ? "null" : typeof v };
}
async function call(label, url, keepValues = false) {
  try {
    const r = await fetch(url, { headers: { "X-API-KEY": KEY || "", "X-API-SECRET": SECRET || "", Accept: "application/json" } });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {}
    const entry = { label, path: url.replace(ORG || "\u0000", "{ORG}"), status: r.status, version: r.headers.get("pheedloop-api-version"), shape: body ? shape(body, 0, keepValues) : { type: "non-json", bytes: text.length, start: text.slice(0, 120) } };
    report.calls.push(entry); return { status: r.status, body };
  } catch (e) { report.calls.push({ label, path: url, error: String(e.message || e) }); return {}; }
}
if (KEY && SECRET && ORG) {
  const base = `https://api.pheedloop.com/api/v3/organization/${ORG}`;
  await call("validateauth", `${base}/validateauth/`);
  const ev = await call("events", `${base}/events/`, true);
  const list = Array.isArray(ev.body) ? ev.body : ev.body?.results || ev.body?.data || ev.body?.events || [];
  const first = list.find(Boolean);
  const code = first && (first.code || first.event_code || first.id);
  if (code) {
    for (const p of ["attendees", "registrations", "tickets", "ticket-types", "orders", "transactions", "sales"]) {
      await call(p, `${base}/events/${code}/${p}/`);
      await call(p + " (event root)", `https://api.pheedloop.com/api/v3/events/${code}/${p}/`);
    }
  }
}
await writeFile(`${OUT}/pheedloop-probe.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ secrets: report.secrets, docs: { ...report.docs }, calls: report.calls.map(c => `${c.status} ${c.label}`) }, null, 1));
