// linkedin-auth: connects the dashboard to AIA Canada's LinkedIn company page (read-only reporting).
//
//   POST {action:"start", passcode}   -> {url} LinkedIn sign-in link (upload passcode required)
//   POST {action:"status", passcode}  -> connection status, token expiry, last sync
//   GET  ?code=…&state=…              -> LinkedIn sends the person back here after sign-in; tokens are stored
//
// Secrets: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, MCE_UPLOAD_PASSCODE. Tokens are kept in app_settings
// (service role only) and never returned to the browser.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SELF = "https://cyeirmvdstdhcbuyghvv.supabase.co/functions/v1/linkedin-auth";
const BACK = "https://bbeehler.github.io/mce-dashboard/upload.html";
const SCOPES = "rw_organization_admin r_organization_social";
const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = (o: string) => ({ "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" });
const json = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${BACK}?${q}#linkedinCard` } });

async function sha(s: string) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function passcodeOk(given: unknown) {
  const real = Deno.env.get("MCE_UPLOAD_PASSCODE");
  if (!real || typeof given !== "string" || !given) return false;
  const [a, b] = await Promise.all([sha(given), sha(real)]);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function getS(keys: string[]) { const { data } = await db.from("app_settings").select("key,value").in("key", keys); return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])); }
async function setS(rows: Record<string, string | null>) {
  const up = Object.entries(rows).filter(([, v]) => v != null).map(([key, value]) => ({ key, value }));
  if (up.length) await db.from("app_settings").upsert(up, { onConflict: "key" });
  const del = Object.entries(rows).filter(([, v]) => v == null).map(([k]) => k);
  if (del.length) await db.from("app_settings").delete().in("key", del);
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const id = (Deno.env.get("LINKEDIN_CLIENT_ID") ?? "").trim(), secret = (Deno.env.get("LINKEDIN_CLIENT_SECRET") ?? "").trim();

  // ---- LinkedIn sends the person back here ----
  if (req.method === "GET") {
    if (u.searchParams.get("error")) return back(`linkedin=error&msg=${encodeURIComponent(u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "")}`);
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (!code || !state) return new Response("Not found", { status: 404 });
    const s = await getS(["linkedin_oauth_state"]);
    const [want, at] = String(s.linkedin_oauth_state ?? "").split("|");
    if (!want || want !== state || Date.now() - Number(at) > 15 * 60 * 1000) return back("linkedin=error&msg=" + encodeURIComponent("The sign-in link expired. Start again from the Upload data page."));
    const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SELF, client_id: id, client_secret: secret }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) return back("linkedin=error&msg=" + encodeURIComponent(String(t.error_description ?? t.error ?? `LinkedIn answered ${r.status}`).slice(0, 200)));
    const now = Date.now(), month = new Date().toISOString().slice(0, 7) + "-01";
    const cur = await getS(["linkedin_since"]);
    await setS({
      linkedin_oauth_state: null,
      linkedin_access_token: t.access_token,
      linkedin_access_expires: new Date(now + (Number(t.expires_in) || 5184000) * 1000).toISOString(),
      linkedin_refresh_token: t.refresh_token ?? null,
      linkedin_refresh_expires: t.refresh_token ? new Date(now + (Number(t.refresh_token_expires_in) || 31536000) * 1000).toISOString() : null,
      linkedin_scope: String(t.scope ?? ""),
      linkedin_connected_at: new Date(now).toISOString(),
      linkedin_since: cur.linkedin_since ?? month,
    });
    // First sync straight away (it fills the last 12 months where nothing was uploaded).
    try { await fetch(SELF.replace("linkedin-auth", "linkedin-sync"), { method: "POST" }); } catch { /* the daily run will catch up */ }
    return back("linkedin=connected");
  }

  // ---- calls from the Upload data page ----
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  let body: any; try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }
  if (!(await passcodeOk(body.passcode))) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "That passcode isn't right." }, 401, h); }
  if (!id || !secret) return json({ error: "The LinkedIn app keys aren't set in Supabase (LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET)." }, 503, h);

  if (body.action === "start") {
    const state = crypto.randomUUID().replace(/-/g, "");
    await setS({ linkedin_oauth_state: `${state}|${Date.now()}` });
    const url = `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: SELF, state, scope: SCOPES })}`;
    return json({ url }, 200, h);
  }
  if (body.action === "status") {
    const s = await getS(["linkedin_access_expires", "linkedin_refresh_expires", "linkedin_connected_at", "linkedin_since", "linkedin_org_id", "linkedin_access_token"]);
    const { data: last } = await db.from("sync_log").select("started_at,finished_at,ok,note").eq("source", "linkedin").order("started_at", { ascending: false }).limit(1).maybeSingle();
    return json({ connected: !!s.linkedin_access_token, org: s.linkedin_org_id ?? null, connected_at: s.linkedin_connected_at ?? null, since: s.linkedin_since ?? null, access_expires: s.linkedin_access_expires ?? null, refresh_expires: s.linkedin_refresh_expires ?? null, last }, 200, h);
  }
  return json({ error: "Unknown action." }, 400, h);
});
