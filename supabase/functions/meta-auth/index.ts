// meta-auth: connects the dashboard to AIA Canada's Facebook Pages and linked Instagram accounts (read-only reporting).
//
//   POST {action:"start", passcode}   -> {url} Facebook sign-in link (upload passcode required)
//   POST {action:"status", passcode}  -> connected Pages and Instagram accounts, last sync
//   GET  ?code=…&state=…              -> Facebook sends the person back here; Page tokens are stored
//
// Secrets: META_APP_ID, META_APP_SECRET (and META_CONFIG_ID if the app uses Facebook Login for Business
// configurations). Page tokens obtained from a long-lived user token don't expire; they're kept in app_settings
// (service role only) and never returned to the browser.
import { createClient } from "jsr:@supabase/supabase-js@2";

const G = "https://graph.facebook.com/v25.0";
const SELF = "https://cyeirmvdstdhcbuyghvv.supabase.co/functions/v1/meta-auth";
const BACK = "https://bbeehler.github.io/mce-dashboard/upload.html";
const SCOPES = "pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,business_management";
const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = (o: string) => ({ "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" });
const json = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${BACK}?${q}#metaCard` } });

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
const gj = async (url: string) => { const r = await fetch(url); const b = await r.json().catch(() => ({})); if (!r.ok || b.error) throw new Error(String(b.error?.message ?? `Facebook answered ${r.status}`).slice(0, 200)); return b; };

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const id = (Deno.env.get("META_APP_ID") ?? "").trim(), secret = (Deno.env.get("META_APP_SECRET") ?? "").trim(), config = (Deno.env.get("META_CONFIG_ID") ?? "").trim();

  // ---- Facebook sends the person back here ----
  if (req.method === "GET") {
    if (u.searchParams.get("error")) return back(`meta=error&msg=${encodeURIComponent(u.searchParams.get("error_description") ?? u.searchParams.get("error_reason") ?? u.searchParams.get("error") ?? "")}`);
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (!code || !state) return new Response("Not found", { status: 404 });
    const s = await getS(["meta_oauth_state", "meta_since"]);
    const [want, at] = String(s.meta_oauth_state ?? "").split("|");
    if (!want || want !== state || Date.now() - Number(at) > 15 * 60 * 1000) return back("meta=error&msg=" + encodeURIComponent("The sign-in link expired. Start again from the Upload data page."));
    try {
      const short = await gj(`${G}/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: SELF, code })}`);
      const long = await gj(`${G}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`);
      // Page tokens from a long-lived user token don't expire.
      const pages: any[] = [];
      let next: string | null = `${G}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100", access_token: long.access_token })}`;
      while (next) { const b = await gj(next); pages.push(...(b.data ?? [])); next = b.paging?.next ?? null; }
      if (!pages.length) return back("meta=error&msg=" + encodeURIComponent("No Facebook Pages were shared. Connect again and tick the AIA Canada Pages."));
      const keep = pages.map((p) => ({ id: p.id, name: p.name, token: p.access_token, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null }));
      await setS({ meta_oauth_state: null, meta_pages: JSON.stringify(keep), meta_connected_at: new Date().toISOString(), meta_since: s.meta_since ?? new Date().toISOString().slice(0, 7) + "-01" });
      try { await fetch(SELF.replace("meta-auth", "meta-sync"), { method: "POST" }); } catch { /* the daily run will catch up */ }
      return back("meta=connected");
    } catch (e) { return back("meta=error&msg=" + encodeURIComponent(String((e as Error).message))); }
  }

  // ---- calls from the Upload data page ----
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  let body: any; try { body = await req.json(); } catch { return json({ error: "The request wasn't readable." }, 400, h); }
  if (!(await passcodeOk(body.passcode))) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "That passcode isn't right." }, 401, h); }
  if (!id || !secret) return json({ error: "The Meta app keys aren't set in Supabase (META_APP_ID and META_APP_SECRET)." }, 503, h);

  if (body.action === "start") {
    const state = crypto.randomUUID().replace(/-/g, "");
    await setS({ meta_oauth_state: `${state}|${Date.now()}` });
    const p: Record<string, string> = { client_id: id, redirect_uri: SELF, state, response_type: "code" };
    if (config) p.config_id = config; else p.scope = SCOPES;
    return json({ url: `https://www.facebook.com/v25.0/dialog/oauth?${new URLSearchParams(p)}` }, 200, h);
  }
  if (body.action === "status") {
    const s = await getS(["meta_pages", "meta_connected_at", "meta_since"]);
    const pages = s.meta_pages ? JSON.parse(s.meta_pages).map((p: any) => ({ name: p.name, ig: p.ig?.username ?? null })) : [];
    const { data: last } = await db.from("sync_log").select("started_at,finished_at,ok,note").eq("source", "meta").order("started_at", { ascending: false }).limit(1).maybeSingle();
    return json({ connected: pages.length > 0, pages, connected_at: s.meta_connected_at ?? null, since: s.meta_since ?? null, last }, 200, h);
  }
  return json({ error: "Unknown action." }, 400, h);
});
