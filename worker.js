// CONSIA API TOP1 PACK - Worker completo (Marketplace + Realtime + Voice base + Planes + Admin)
// Pegar completo en worker.js

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-consia-device, x-consia-session, x-owner-token, x-consia-plan, x-consia-cost",
  "cache-control": "no-store",
};

const DEFAULT_MODEL = "gpt-4.1-mini";

const PLAN_LIMITS = {
  FREE: { daily_requests: 100, daily_voice_sessions: 3, daily_budget_usd: 2 },
  PRO: { daily_requests: 1000, daily_voice_sessions: 25, daily_budget_usd: 25 },
  BUSINESS: { daily_requests: 5000, daily_voice_sessions: 200, daily_budget_usd: 150 },
  ENTERPRISE: { daily_requests: 50000, daily_voice_sessions: 2000, daily_budget_usd: 1000 },
};

const DEFAULT_CATALOG = [
  {
    id: "consia-flow-earbuds",
    brand: "CONSIA FLOW",
    name: "Flow AI Translator Earbuds",
    category: "Audio / Travel",
    price_usd: 89.99,
    cost_target_usd: 28.0,
    bestseller_score: 92,
    dropship_ready: true,
    variants: ["Black", "White", "Sand"],
    supplier_type: "OEM ODM Audio",
    image_prompt:
      "Ultra premium product photography, CONSIA FLOW AI translator earbuds, matte black charging case, futuristic minimal branding, studio light, hyperrealistic ecommerce 8K, white seamless background",
    description:
      "Auriculares con traducciÃ³n en vivo, llamadas y modo viaje. SKU ideal para ventas globales.",
  },
  {
    id: "consia-pulse-ring",
    brand: "CONSIA PULSE",
    name: "Pulse Sleep & Wellness Ring",
    category: "Wellness",
    price_usd: 119.99,
    cost_target_usd: 34.0,
    bestseller_score: 90,
    dropship_ready: true,
    variants: ["Black", "Titanium"],
    supplier_type: "Wearables OEM",
    image_prompt:
      "Hyperrealistic product render, smart ring wellness tracker, black titanium finish, elegant shadow, premium ecommerce photo, 8K",
    description:
      "Anillo wellness con mÃ©tricas de sueÃ±o y energÃ­a. Marca premium con packaging liviano.",
  },
  {
    id: "consia-aura-diffuser",
    brand: "CONSIA AURA",
    name: "Aura Smart Aroma Diffuser",
    category: "Home",
    price_usd: 69.99,
    cost_target_usd: 21.0,
    bestseller_score: 88,
    dropship_ready: true,
    variants: ["Obsidian", "Stone"],
    supplier_type: "Home Electronics OEM",
    image_prompt:
      "Luxury smart aroma diffuser product photo, black matte aluminum ring, soft vapor mist, warm ambient light, premium home product, hyperrealistic 8K",
    description:
      "Difusor inteligente controlado por app/voz. Gran margen y alto potencial de regalo.",
  },
  {
    id: "consia-vault-tag",
    brand: "CONSIA VAULT",
    name: "Vault Smart Luggage Tag",
    category: "Travel",
    price_usd: 39.99,
    cost_target_usd: 9.5,
    bestseller_score: 87,
    dropship_ready: true,
    variants: ["Black", "Orange", "Navy"],
    supplier_type: "Travel Accessories OEM",
    image_prompt:
      "Premium smart luggage tag with e-ink style face, black silicone strap, passport and suitcase composition, travel ecommerce photo, hyperrealistic",
    description:
      "Tag inteligente para equipaje con QR y ficha digital. Ideal para travel/airport niche.",
  },
  {
    id: "consia-move-bottle",
    brand: "CONSIA MOVE",
    name: "Move Smart Hydration Bottle",
    category: "Fitness / Lifestyle",
    price_usd: 49.99,
    cost_target_usd: 14.0,
    bestseller_score: 85,
    dropship_ready: true,
    variants: ["Black", "Steel", "Green"],
    supplier_type: "Drinkware OEM",
    image_prompt:
      "Modern smart hydration bottle product shot, matte black stainless steel, minimal CONSIA MOVE branding, sporty but premium, hyperrealistic 8K",
    description:
      "Botella con recordatorios y sensor de temperatura. Venta global evergreen.",
  },
  {
    id: "consia-home-hub-mini",
    brand: "CONSIA HOME",
    name: "Home Hub Mini",
    category: "Smart Home",
    price_usd: 129.99,
    cost_target_usd: 39.0,
    bestseller_score: 94,
    dropship_ready: false,
    variants: ["Black"],
    supplier_type: "Custom ODM IoT",
    image_prompt:
      "Premium smart home hub device, black anodized finish, soft LED ring, modern minimal product photography, 8K hyperreal",
    description:
      "Hub para conectar dispositivos del ecosistema CONSIA. Producto core de plataforma.",
  },
  {
    id: "consia-desk-dock",
    brand: "CONSIA DESK",
    name: "Desk Dock 7-in-1",
    category: "Tech Accessories",
    price_usd: 79.99,
    cost_target_usd: 22.0,
    bestseller_score: 89,
    dropship_ready: true,
    variants: ["Black", "Graphite"],
    supplier_type: "USB-C Accessories OEM",
    image_prompt:
      "Premium USB-C docking station, sleek black aluminum, desk setup aesthetic, hyperrealistic commercial product photo",
    description:
      "Dock USB-C para creators/office. Producto de alta rotaciÃ³n y ticket medio.",
  },
  {
    id: "consia-kids-lamp",
    brand: "CONSIA KIDS",
    name: "Kids Calm Light",
    category: "Kids / Home",
    price_usd: 59.99,
    cost_target_usd: 16.0,
    bestseller_score: 83,
    dropship_ready: true,
    variants: ["Moon", "Cloud"],
    supplier_type: "Lighting OEM",
    image_prompt:
      "Premium kids calm light lamp, soft-touch silicone, modern nursery aesthetic, warm ambient glow, hyperrealistic 8K",
    description:
      "Luz nocturna inteligente orientada a bienestar y rutinas.",
  }
];

const SUPPLIER_DIRECTORY = [
  { name: "Alibaba", type: "B2B Manufacturers", url: "https://www.alibaba.com", use: "OEM/ODM general global sourcing" },
  { name: "Global Sources", type: "B2B Manufacturers", url: "https://www.globalsources.com", use: "Electronics/hardware suppliers" },
  { name: "Made-in-China", type: "B2B Manufacturers", url: "https://www.made-in-china.com", use: "Industrial and consumer goods sourcing" },
  { name: "CJdropshipping", type: "Dropshipping Fulfillment", url: "https://www.cjdropshipping.com", use: "Dropship + sourcing + fulfillment" },
  { name: "DSers", type: "AliExpress Automation", url: "https://www.dsers.com", use: "AliExpress order routing" },
  { name: "Zendrop", type: "Dropshipping Fulfillment", url: "https://www.zendrop.com", use: "US-focused dropship flows" },
  { name: "Spocket", type: "Supplier Marketplace", url: "https://www.spocket.co", use: "US/EU suppliers" },
  { name: "Printful", type: "Print on Demand", url: "https://www.printful.com", use: "POD brand launch" },
  { name: "Gelato", type: "Print on Demand", url: "https://www.gelato.com", use: "Localized POD production" },
  { name: "ShipBob", type: "3PL Fulfillment", url: "https://www.shipbob.com", use: "Stocked inventory scaling" }
];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
  });
}

function text(data, status = 200, extra = {}) {
  return new Response(data, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS, ...extra },
  });
}

function parseBearer(req) {
  const a = req.headers.get("authorization") || "";
  if (a.toLowerCase().startsWith("bearer ")) return a.slice(7).trim();
  return "";
}

function getOwnerToken(req, env) {
  return (
    req.headers.get("x-owner-token") ||
    parseBearer(req) ||
    ""
  );
}

function isOwner(req, env) {
  const expected = (env.OWNER_TOKEN || "").trim();
  if (!expected) return false;
  const got = getOwnerToken(req, env).trim();
  return got && got === expected;
}

function requireOwner(req, env) {
  if (!isOwner(req, env)) {
    return json({ ok: false, error: "Unauthorized", route: new URL(req.url).pathname }, 401);
  }
  return null;
}

function getPlan(req) {
  const raw = (req.headers.get("x-consia-plan") || "FREE").toUpperCase();
  return PLAN_LIMITS[raw] ? raw : "FREE";
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function kvGetJson(kv, key, fallback = null) {
  if (!kv) return fallback;
  try {
    const v = await kv.get(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

async function kvPutJson(kv, key, value, opts = {}) {
  if (!kv) return false;
  await kv.put(key, JSON.stringify(value), opts);
  return true;
}

function memStore() {
  const g = globalThis;
  if (!g.__CONSIA_MEM__) g.__CONSIA_MEM__ = new Map();
  return g.__CONSIA_MEM__;
}

async function getStoreValue(env, key, fallback = null) {
  if (env.GLOBAL_STATE_KV) return await kvGetJson(env.GLOBAL_STATE_KV, key, fallback);
  const m = memStore();
  return m.has(key) ? m.get(key) : fallback;
}

async function setStoreValue(env, key, value) {
  if (env.GLOBAL_STATE_KV) return await kvPutJson(env.GLOBAL_STATE_KV, key, value);
  memStore().set(key, value);
  return true;
}

async function incrementCounter(env, key, delta = 1) {
  const cur = (await getStoreValue(env, key, 0)) || 0;
  const next = Number(cur) + Number(delta);
  await setStoreValue(env, key, next);
  return next;
}

async function enforcePlanAndBudget(req, env, routeName) {
  const plan = getPlan(req);
  const limits = PLAN_LIMITS[plan];
  const day = utcDayKey();
  const base = `usage:${day}:${plan}`;
  const reqCount = await incrementCounter(env, `${base}:requests`, 1);
  if (reqCount > limits.daily_requests) {
    return { blocked: true, res: json({ ok: false, error: "limit_reached", plan, route: routeName }, 429) };
  }
  const costHeader = Number(req.headers.get("x-consia-cost") || 0);
  if (costHeader > 0) {
    const budget = await incrementCounter(env, `${base}:budget_usd`, costHeader);
    if (budget > limits.daily_budget_usd) {
      return {
        blocked: true,
        res: json({ ok: false, error: "budget_cap_reached", plan, route: routeName, budget }, 429),
      };
    }
  }
  return { blocked: false, plan, limits };
}

async function getCatalog(env) {
  return (await getStoreValue(env, "market:catalog", null)) || DEFAULT_CATALOG;
}

async function saveCatalog(env, catalog) {
  await setStoreValue(env, "market:catalog", catalog);
  return catalog;
}

async function audit(env, event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  // Append-only best effort (KV list trimmed)
  const day = utcDayKey();
  const key = `audit:${day}`;
  const list = (await getStoreValue(env, key, [])) || [];
  list.push(entry);
  if (list.length > 500) list.shift();
  await setStoreValue(env, key, list);
  return entry;
}

async function openAIResponsesText(env, inputText) {
  if (!env.OPENAI_API_KEY) {
    return { ok: true, text: "CONSIA CORE ACTIVE (sin OPENAI_API_KEY en este entorno)", model: DEFAULT_MODEL };
  }
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: inputText,
      temperature: 0.6,
    }),
  });

  const raw = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ok: false,
      route: "/ask",
      error: raw?.error?.message || "OpenAI error",
      detail: null,
      upstream_status: r.status,
      upstream: "responses",
      raw,
    };
  }

  // Compat parser
  let textOut = "";
  if (typeof raw.output_text === "string") textOut = raw.output_text;
  if (!textOut && Array.isArray(raw.output)) {
    for (const item of raw.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c?.text) textOut += c.text;
          if (c?.type === "text" && c?.text) textOut += c.text;
        }
      }
    }
  }

  return {
    ok: true,
    route: "/ask",
    model,
    text: textOut || "OK",
    error: null,
    detail: null,
    upstream_status: null,
    upstream: null,
    raw: null,
  };
}

async function routeVoiceSession(req, env) {
  const plan = getPlan(req);
  const day = utcDayKey();
  const k = `usage:${day}:${plan}:voice_sessions`;
  const n = await incrementCounter(env, k, 1);
  const lim = PLAN_LIMITS[plan].daily_voice_sessions;
  if (n > lim) return json({ ok: false, error: "voice_limit_reached", plan }, 429);

  // Provider selection is declarative; actual provider keys stay server-side.
  const provider = env.VOICE_PROVIDER || "openai";
  const avatarProvider = env.AVATAR_PROVIDER || "runway_hybrid";
  const langs = ["es", "en", "pt"];
  const voices = (env.ALLOWED_VOICES || "neutral-1,neutral-2,warm-1").split(",").map(v => v.trim());

  return json({
    ok: true,
    route: "/voice/session",
    session: {
      id: crypto.randomUUID(),
      provider,
      avatar_provider: avatarProvider,
      mode: "realtime",
      ws_url: `${new URL(req.url).origin.replace(/^http/, "ws")}/ws?room=voice-main`,
      languages: langs,
      voices,
      expires_in_sec: 600,
    },
  });
}

async function routeVoiceChunk(req, env) {
  // Base endpoint to receive mic chunks from browser. Real STT upstream can be wired later.
  const contentType = req.headers.get("content-type") || "";
  const buf = await req.arrayBuffer();
  await audit(env, "voice_chunk", { bytes: buf.byteLength, contentType });
  return json({
    ok: true,
    route: "/voice/chunk",
    bytes: buf.byteLength,
    content_type: contentType,
    transcript: null,
    note: "chunk recibido (STT upstream opcional)",
  });
}

async function routeAsk(req, env) {
  const enforce = await enforcePlanAndBudget(req, env, "/ask");
  if (enforce.blocked) return enforce.res;

  const body = await req.json().catch(() => ({}));
  const message = String(body.message || body.input || "").trim();
  if (!message) return json({ ok: false, error: "Missing message", route: "/ask" }, 400);

  const result = await openAIResponsesText(env, message);
  await audit(env, "ask", { plan: getPlan(req), ok: !!result.ok });

  return json(result, result.ok ? 200 : 500);
}

async function routeMarketCatalog(req, env) {
  const catalog = await getCatalog(env);
  const q = new URL(req.url).searchParams;
  const category = (q.get("category") || "").toLowerCase();
  const dropship = q.get("dropship");
  let rows = catalog;
  if (category) rows = rows.filter((x) => String(x.category || "").toLowerCase().includes(category));
  if (dropship === "1") rows = rows.filter((x) => !!x.dropship_ready);

  return json({
    ok: true,
    route: "/market/catalog",
    count: rows.length,
    items: rows.sort((a, b) => (b.bestseller_score || 0) - (a.bestseller_score || 0)),
  });
}

async function routeMarketBootstrap(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  await saveCatalog(env, DEFAULT_CATALOG);
  await audit(env, "market_bootstrap", { count: DEFAULT_CATALOG.length });
  return json({ ok: true, route: "/owner/market/bootstrap", count: DEFAULT_CATALOG.length });
}

async function routeMarketUpsert(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  const body = await req.json().catch(() => ({}));
  if (!body?.id || !body?.name) return json({ ok: false, error: "id and name required" }, 400);
  const catalog = await getCatalog(env);
  const idx = catalog.findIndex((x) => x.id === body.id);
  const next = { ...catalog[idx] || {}, ...body };
  if (idx >= 0) catalog[idx] = next; else catalog.push(next);
  await saveCatalog(env, catalog);
  await audit(env, "market_upsert", { id: next.id });
  return json({ ok: true, route: "/owner/market/product", item: next });
}

async function routeSuppliers(req, env) {
  return json({
    ok: true,
    route: "/market/suppliers",
    items: SUPPLIER_DIRECTORY,
    note: "Directorio de proveedores para sourcing/dropshipping. VinculaciÃ³n operativa se hace por cuenta owner.",
  });
}

async function routeCheckout(req, env) {
  const enforce = await enforcePlanAndBudget(req, env, "/market/checkout");
  if (enforce.blocked) return enforce.res;
  const body = await req.json().catch(() => ({}));
  const { product_id, qty = 1, buyer = {} } = body || {};
  if (!product_id) return json({ ok: false, error: "product_id required" }, 400);
  const catalog = await getCatalog(env);
  const p = catalog.find((x) => x.id === product_id);
  if (!p) return json({ ok: false, error: "Product not found" }, 404);

  const order = {
    order_id: `ord_${Date.now()}`,
    product_id,
    qty,
    subtotal_usd: Number((p.price_usd * Number(qty)).toFixed(2)),
    status: "created",
    buyer,
    dropship_ready: !!p.dropship_ready,
    supplier_flow: p.dropship_ready ? "auto_routing_candidate" : "inventory_or_odm",
    created_at: new Date().toISOString(),
  };
  await setStoreValue(env, `order:${order.order_id}`, order);
  await audit(env, "checkout_created", { order_id: order.order_id, product_id, qty });
  return json({ ok: true, route: "/market/checkout", order });
}

async function routeDropshipDispatch(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  const body = await req.json().catch(() => ({}));
  const { order_id, supplier } = body || {};
  const order = await getStoreValue(env, `order:${order_id}`, null);
  if (!order) return json({ ok: false, error: "Order not found" }, 404);

  // SimulaciÃ³n fail-closed: no dispara terceros sin config explÃ­cita
  if (!env.DROPSHIP_AUTOMATION_ENABLED || env.DROPSHIP_AUTOMATION_ENABLED !== "true") {
    order.status = "ready_for_manual_dispatch";
    order.dispatch = { mode: "manual", supplier: supplier || null };
    await setStoreValue(env, `order:${order_id}`, order);
    await audit(env, "dropship_manual_queue", { order_id, supplier: supplier || null });
    return json({
      ok: true,
      route: "/owner/dropship/dispatch",
      dispatched: false,
      order,
      note: "Modo seguro: dispatch manual. ActivÃ¡ DROPSHIP_AUTOMATION_ENABLED=true para automatizaciÃ³n.",
    });
  }

  // AquÃ­ irÃ­an integraciones reales (CJ/DSers/Shopify/etc.)
  order.status = "dispatched";
  order.dispatch = { mode: "auto", supplier: supplier || "router_default", ts: new Date().toISOString() };
  await setStoreValue(env, `order:${order_id}`, order);
  await audit(env, "dropship_dispatched", { order_id, supplier: order.dispatch.supplier });
  return json({ ok: true, route: "/owner/dropship/dispatch", dispatched: true, order });
}

async function routePlans(req, env) {
  return json({
    ok: true,
    route: "/plans",
    plans: PLAN_LIMITS,
    billing_mode: env.BILLING_MODE || "manual|paddle|stripe",
    default_currency: "USD",
  });
}

async function routeAdminMetrics(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  const day = utcDayKey();
  const metrics = {};
  for (const plan of Object.keys(PLAN_LIMITS)) {
    metrics[plan] = {
      requests: (await getStoreValue(env, `usage:${day}:${plan}:requests`, 0)) || 0,
      budget_usd: (await getStoreValue(env, `usage:${day}:${plan}:budget_usd`, 0)) || 0,
      voice_sessions: (await getStoreValue(env, `usage:${day}:${plan}:voice_sessions`, 0)) || 0,
    };
  }
  const auditDay = (await getStoreValue(env, `audit:${day}`, [])) || [];
  return json({
    ok: true,
    route: "/admin/metrics",
    day,
    metrics,
    audit_events: auditDay.slice(-50),
    env: env.ENV || "prod",
  });
}

async function routeOwnerPing(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  return json({ ok: true, owner: true, service: "CONSIA", status: "secure" });
}

async function routeMeetPing(req, env) {
  return json({
    ok: true,
    service: "consia-api",
    status: "healthy",
    ts: new Date().toISOString(),
    env: env.ENV || "prod",
  });
}

async function routeVoiceToken(req, env) {
  // Alias Ãºtil para tests rÃ¡pidos
  return routeVoiceSession(req, env);
}

async function proxyWsToDO(request, env) {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") || "main").slice(0, 64);
  const user = (url.searchParams.get("user") || "anon").slice(0, 64);

  if (!env.CONSIA_STATE) return json({ ok: false, error: "CONSIA_STATE binding missing" }, 500);
  const id = env.CONSIA_STATE.idFromName(`room:${room}`);
  const stub = env.CONSIA_STATE.get(id);
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = "/_do/ws";
  upstreamUrl.searchParams.set("room", room);
  upstreamUrl.searchParams.set("user", user);

  return stub.fetch(upstreamUrl.toString(), request);
}

async function routeWsRoomState(req, env) {
  const authErr = requireOwner(req, env);
  if (authErr) return authErr;
  const room = new URL(req.url).searchParams.get("room") || "main";
  const id = env.CONSIA_STATE.idFromName(`room:${room}`);
  const stub = env.CONSIA_STATE.get(id);
  const r = await stub.fetch("https://do.local/state");
  return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...CORS_HEADERS } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/" && request.method === "GET") return text("CONSIA API OK");
      if (path === "/meet/ping" && request.method === "GET") return routeMeetPing(request, env);
      if (path === "/owner/ping" && request.method === "GET") return routeOwnerPing(request, env);

      if (path === "/ask" && request.method === "POST") return routeAsk(request, env);

      if (path === "/plans" && request.method === "GET") return routePlans(request, env);
      if (path === "/admin/metrics" && request.method === "GET") return routeAdminMetrics(request, env);

      if (path === "/market/catalog" && request.method === "GET") return routeMarketCatalog(request, env);
      if (path === "/market/suppliers" && request.method === "GET") return routeSuppliers(request, env);
      if (path === "/market/checkout" && request.method === "POST") return routeCheckout(request, env);

      if (path === "/owner/market/bootstrap" && request.method === "POST") return routeMarketBootstrap(request, env);
      if (path === "/owner/market/product" && request.method === "POST") return routeMarketUpsert(request, env);
      if (path === "/owner/dropship/dispatch" && request.method === "POST") return routeDropshipDispatch(request, env);
      if (path === "/owner/rooms/state" && request.method === "GET") return routeWsRoomState(request, env);

      if (path === "/voice/token" && request.method === "GET") return routeVoiceToken(request, env);
      if (path === "/voice/session" && request.method === "GET") return routeVoiceSession(request, env);
      if (path === "/voice/chunk" && request.method === "POST") return routeVoiceChunk(request, env);

      if (path === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return proxyWsToDO(request, env);
      }

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.room = "main";
    this.createdAt = Date.now();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/_do/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      const room = (url.searchParams.get("room") || "main").slice(0, 64);
      const user = (url.searchParams.get("user") || "anon").slice(0, 64);
      this.room = room;

      const socketId = crypto.randomUUID();
      this.sockets.set(socketId, { ws: server, user, joinedAt: Date.now() });

      this.broadcast({
        type: "presence",
        event: "join",
        room,
        user,
        socket_id: socketId,
        members: this.sockets.size,
        ts: new Date().toISOString(),
      });

      server.addEventListener("message", (evt) => {
        let data = evt.data;
        let payload = null;
        try {
          payload = typeof data === "string" ? JSON.parse(data) : { binary: true, bytes: data?.byteLength || 0 };
        } catch {
          payload = { text: typeof data === "string" ? data : "[binary]" };
        }

        // Ping loop + broadcast
        if (payload?.type === "ping") {
          try {
            server.send(JSON.stringify({ type: "pong", ts: Date.now(), room, members: this.sockets.size }));
          } catch {}
          return;
        }

        this.broadcast({
          type: "message",
          room,
          from: user,
          payload,
          ts: new Date().toISOString(),
        });
      });

      const cleanup = () => {
        this.sockets.delete(socketId);
        this.broadcast({
          type: "presence",
          event: "leave",
          room,
          user,
          socket_id: socketId,
          members: this.sockets.size,
          ts: new Date().toISOString(),
        });
      };

      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      // Welcome
      try {
        server.send(
          JSON.stringify({
            type: "welcome",
            room,
            user,
            socket_id: socketId,
            members: this.sockets.size,
            ts: new Date().toISOString(),
          })
        );
      } catch {}

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      const members = [];
      for (const [id, item] of this.sockets.entries()) {
        members.push({ socket_id: id, user: item.user, joinedAt: item.joinedAt });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          room: this.room,
          members_count: this.sockets.size,
          uptime_sec: Math.round((Date.now() - this.createdAt) / 1000),
          members,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ ok: false, error: "DO route not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const [id, item] of this.sockets.entries()) {
      try {
        item.ws.send(msg);
      } catch {
        this.sockets.delete(id);
      }
    }
  }
}
