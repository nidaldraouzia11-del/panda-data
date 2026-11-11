// Live ZR Express → PANDA follow-up list.
// Netlify env vars: ZR_API_KEY, ZR_TENANT, SITE_PIN
const BASE = "https://api.zrexpress.app/api/v1";
const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "").trim();
const ACTIVE = new Set(["confirme_au_bureau", "sortie_en_livraison", "en_livraison"]);
let cache = { at: 0, data: null };
const hist = new Map(); // parcelId -> { at, sit, hub }

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_-]+/g, " ").trim();

async function zr(path, body) {
  const r = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "X-Api-Key": env("ZR_API_KEY"), "X-Tenant": env("ZR_TENANT"), "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`ZR ${r.status}`);
  return r.json();
}

async function fetchRecent(days = 15) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const res = await zr("/parcels/search", {
      pageNumber: page, pageSize: 500, orderBy: ["createdAt desc"],
      advancedFilter: { logic: "and", filters: [{ field: "createdAt", operator: "gte", value: since }] },
    });
    items.push(...(res.items || []));
    if (!res.hasNext) break;
  }
  return items;
}

// Latest meaningful situation + current hub, from the state history.
async function situationOf(p) {
  const c = hist.get(p.id);
  if (c && Date.now() - c.at < 150e3 && c.stamp === p.lastStateUpdateAt) return c;
  const h = await zr(`/parcels/${p.id}/state-history`);
  const list = (Array.isArray(h) ? h : h.items || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const cur = [...list].reverse().find((e) => e.newState?.name === p.state?.name) || list[list.length - 1] || {};
  const sits = (cur.situations || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((s) => s.situationName || s.situationDescription || "").filter((n) => n && !/appel telephonique/.test(norm(n)));
  const out = { at: Date.now(), stamp: p.lastStateUpdateAt, sit: sits[sits.length - 1] || "", hub: cur.location?.hubName || "" };
  hist.set(p.id, out);
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out;
}

function group(state, sit, x) {
  const s = norm(sit);
  if (/repond pas\s*3/.test(s)) return "r3";
  if (/repond pas\s*2/.test(s)) return "r2";
  if (/repond pas/.test(s)) return "r1";
  if (/annul/.test(s)) return "cancel";
  if (/attente du client/.test(s)) return "wait";
  if (s) return "fix"; // erronée, reporté, rendez-vous, injoignable, fermé…
  if (state === "confirme_au_bureau" && x.deliveryType === "home" && Date.now() - new Date(x.lastStateUpdateAt) > 864e5) return "fix";
  return null;
}

async function build() {
  const rows = (await fetchRecent()).filter((p) => ACTIVE.has(p.state?.name));
  const sits = await pool(rows, 10, situationOf);
  const parcels = [];
  rows.forEach((p, i) => {
    const info = sits[i] || { sit: "", hub: "" };
    const g = group(p.state?.name, info.sit, p);
    if (!g) return;
    const stuck = !info.sit && g === "fix";
    const prod = String(p.productsDescription || p.description || "");
    const code = p.deliveryAddress?.cityTerritoryCode;
    parcels.push({
      group: g,
      tracking: p.trackingNumber || "",
      name: p.customer?.name || "",
      phone: p.customer?.phone?.number1 || "",
      wilaya: (code ? String(code).padStart(2, "0") + " " : "") + (p.deliveryAddress?.city || ""),
      commune: p.deliveryAddress?.district || "",
      deliveryType: p.deliveryType || "home",
      amount: Number(p.amount || 0),
      products: prod.replace(/👑[^|,\n]*(\|\s*)?/g, "").replace(/\s+/g, " ").trim() + (/vip/i.test(prod) ? " (VIP)" : ""),
      situation: stuck ? "في المكتب دون خروج للتوصيل منذ أكثر من 24 ساعة" : info.sit,
      state: p.state?.description || "",
      hub: info.hub,
      lastUpdate: p.lastStateUpdateAt,
    });
  });
  return { updatedAt: new Date().toISOString(), parcels };
}

export default async (req) => {
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  if (!env("ZR_API_KEY") || !env("ZR_TENANT") || !env("SITE_PIN")) return json({ error: "not_configured" }, 503);
  if (req.headers.get("x-pin") !== env("SITE_PIN")) return json({ error: "bad_pin" }, 401);
  try {
    if (!cache.data || Date.now() - cache.at > 60e3) cache = { at: Date.now(), data: await build() };
    return json(cache.data);
  } catch (e) {
    if (cache.data) return json({ ...cache.data, stale: true });
    return json({ error: "zr_unreachable" }, 502);
  }
};

export const config = { path: "/api/parcels" };
