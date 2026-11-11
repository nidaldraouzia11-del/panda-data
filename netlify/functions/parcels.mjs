// Live ZR Express → PANDA follow-up list. Secrets live in Netlify env vars:
// ZR_API_KEY, ZR_TENANT, SITE_PIN
const BASE = "https://api.zrexpress.app/api/v1";
const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "").trim();
let cache = { at: 0, data: null };

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_-]+/g, " ").trim();
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
const pick = (o, paths) => { for (const p of paths) { const v = get(o, p); if (v !== undefined && v !== null && v !== "") return v; } return undefined; };
const label = (v) => (v && typeof v === "object" ? pick(v, ["name", "description", "label", "title", "code"]) : v);

async function zr(path, body) {
  const r = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "X-Api-Key": env("ZR_API_KEY"), "X-Tenant": env("ZR_TENANT"), "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`ZR ${path} ${r.status}`);
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

function shape(p) {
  const state = label(pick(p, ["state", "currentState", "lastState"])) || "";
  const situation = label(pick(p, ["situation", "lastSituation", "currentSituation", "state.situation", "deliveryAttempt.situation"])) || "";
  const products = pick(p, ["orderedProducts", "products", "items"]);
  const prodText = Array.isArray(products) && products.length
    ? products.map((x) => `${pick(x, ["productName", "name", "product.name", "description"]) ?? ""}${(x.quantity ?? 1) > 1 ? " × " + x.quantity : ""}`).join(" | ")
    : pick(p, ["description", "productsDescription", "content"]) || "";
  const wil = pick(p, ["deliveryAddress.city", "address.city", "customer.address.city", "cityTerritory.name", "wilaya"]) || "";
  const wilCode = pick(p, ["deliveryAddress.cityCode", "deliveryAddress.cityTerritoryCode", "wilayaCode"]);
  return {
    tracking: pick(p, ["trackingNumber", "tracking"]) || "",
    name: pick(p, ["customer.name", "customer.fullName", "recipient.name", "customerName", "receiverName"]) || "",
    phone: String(pick(p, ["customer.phone.number1", "customer.phoneNumber", "customer.phone", "phone.number1", "customerPhone", "recipient.phone"]) || ""),
    wilaya: (wilCode ? String(wilCode).padStart(2, "0") + " " : "") + wil,
    commune: pick(p, ["deliveryAddress.district", "address.district", "customer.address.district", "districtTerritory.name", "commune"]) || "",
    deliveryType: pick(p, ["deliveryType"]) || "home",
    amount: Number(pick(p, ["amount", "totalAmount", "codAmount", "price", "productsPrice"]) || 0),
    products: String(prodText).replace(/👑[^|]*\|?\s*/g, "").trim(),
    vip: /vip/i.test(String(prodText)),
    state, situation,
    createdAt: pick(p, ["createdAt"]) || null,
    lastUpdate: pick(p, ["lastStateUpdateAt", "updatedAt", "lastModifiedAt"]) || null,
  };
}

function group(x) {
  const s = norm(x.situation), st = norm(x.state);
  const done = /livr|encaiss|recouvr|retour|returned|delivered|annule par|rembours/.test(st);
  if (done) return null;
  if (/repond pas\s*3|no answer\s*3/.test(s)) return "r3";
  if (/repond pas\s*2|no answer\s*2/.test(s)) return "r2";
  if (/repond pas\s*1|repond pas|no answer/.test(s)) return "r1";
  if (/annul/.test(s)) return "cancel";
  if (/erron|adresse|address|report|rendez vous|injoignable|ferme/.test(s)) return "fix";
  if (/attente du client|waiting/.test(s)) return "wait";
  if (/confirme au bureau|confirmed/.test(st) && x.deliveryType === "home" && x.lastUpdate && Date.now() - new Date(x.lastUpdate) > 864e5) {
    x.situation = "في المكتب دون خروج للتوصيل منذ أكثر من 24 ساعة"; return "fix";
  }
  return null;
}

export default async (req) => {
  const url = new URL(req.url);
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  if (!env("ZR_API_KEY") || !env("ZR_TENANT") || !env("SITE_PIN")) return json({ error: "not_configured" }, 503);

  // Structure check without any personal data: key names only.
  if (url.searchParams.get("debug") === "keys") {
    try {
      const res = await zr("/parcels/search", { pageNumber: 1, pageSize: 3, orderBy: ["createdAt desc"] });
      const walk = (o, pre = "") => o && typeof o === "object" && !Array.isArray(o)
        ? Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [pre + k + "[]", ...(v[0] && typeof v[0] === "object" ? walk(v[0], pre + k + "[].") : [])] : v && typeof v === "object" ? [pre + k, ...walk(v, pre + k + ".")] : [pre + k + ":" + typeof v])
        : [];
      return json({ ok: true, top: Object.keys(res), keys: res.items?.[0] ? walk(res.items[0]) : [] });
    } catch (e) { return json({ ok: false, error: String(e.message) }, 502); }
  }

  if (url.searchParams.get("debug") === "states") {
    const rows = await fetchRecent(5);
    const c = {}; for (const p of rows) { const k = (p.state?.name || "") + " | " + (p.state?.description || ""); c[k] = (c[k] || 0) + 1; }
    return json(c);
  }
  if (url.searchParams.get("debug") === "history") {
    const rows = await fetchRecent(5);
    const p = rows.find((x) => /bureau|livraison/i.test(x.state?.description || x.state?.name || ""));
    if (!p) return json({ none: true });
    const h = await zr(`/parcels/${p.id}/state-history`);
    const arr = Array.isArray(h) ? h : h.items || h.history || [];
    const walk = (o, pre = "") => o && typeof o === "object" && !Array.isArray(o)
      ? Object.entries(o).flatMap(([k, v]) => v && typeof v === "object" && !Array.isArray(v) ? [pre + k, ...walk(v, pre + k + ".")] : [pre + k + ":" + (typeof v === "string" && /situation|name|description|reason|comment/i.test(k) ? JSON.stringify(v).slice(0, 60) : typeof v)])
      : [];
    return json({ type: Array.isArray(h) ? "array" : Object.keys(h), n: arr.length, last: walk(arr[arr.length - 1]), first: walk(arr[0]) });
  }

  if (req.headers.get("x-pin") !== env("SITE_PIN")) return json({ error: "bad_pin" }, 401);
  try {
    if (!cache.data || Date.now() - cache.at > 60e3) {
      const rows = (await fetchRecent()).map(shape);
      const parcels = [];
      for (const x of rows) { const g = group(x); if (g) parcels.push({ group: g, ...x, products: x.products + (x.vip ? " (VIP)" : "") }); }
      cache = { at: Date.now(), data: { updatedAt: new Date().toISOString(), parcels } };
    }
    return json(cache.data);
  } catch (e) {
    if (cache.data) return json({ ...cache.data, stale: true });
    return json({ error: "zr_unreachable", detail: String(e.message) }, 502);
  }
};

export const config = { path: "/api/parcels" };
