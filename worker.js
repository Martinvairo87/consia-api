const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const PLAN_LIMITS = {
  FREE: { requests: 300, voiceSessions: 5, ttsChars: 4000, aiCalls: 50, wsRooms: 1 },
  PRO: { requests: 5000, voiceSessions: 200, ttsChars: 150000, aiCalls: 2000, wsRooms: 10 },
  BUSINESS: { requests: 25000, voiceSessions: 1500, ttsChars: 1000000, aiCalls: 10000, wsRooms: 100 },
  ENTERPRISE: { requests: 1000000, voiceSessions: 100000, ttsChars: 10000000, aiCalls: 1000000, wsRooms: 1000 },
};

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowList = (env.CORS_ALLOWLIST || "https://consia.world,https://www.consia.world,http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  let allowOrigin = "*";
  if (origin && allowList.includes(origin)) allowOrigin = origin;

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-owner-token, x-consia-user, x-consia-plan, x-consia-device, x-consia-session",
    "access-control-expose-headers": "x-consia-plan,x-consia-remaining,x-consia-soft-lock",
    "access-control-max-age": "86400",
    ...(allowOrigin !== "*" ? { "access-control-allow-credentials": "true" } : {}),
  };
}

function withCors(res, request, env) {
  const headers = new Headers(res.headers);
  const cors = getCorsHeaders(request, env);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function text(data, status = 200, extraHeaders = {}) {
  return new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders } });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function sha256(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getConsiaUserId(request) {
  const explicit = request.headers.get("x-consia-user");
  if (explicit) return explicit.trim();

  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return `bearer:${token.slice(0, 24)}`;
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ua = request.headers.get("user-agent") || "unknown";
  return `anon:${(await sha256(`${ip}|${ua}`)).slice(0, 24)}`;
}

function getPlan(request) {
  const raw = (request.headers.get("x-consia-plan") || "FREE").toUpperCase();
  return PLAN_LIMITS[raw] ? raw : "FREE";
}

async function kvGetJson(kv, key, fallback) {
  if (!kv) return fallback;
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function kvPutJson(kv, key, value, opts = {}) {
  if (!kv) return;
  await kv.put(key, JSON.stringify(value), opts);
}

async function appendAudit(env, event, payload = {}) {
  if (!env.AUDIT_KV) return;
  const key = `audit:${dayKey()}`;
  const current = await kvGetJson(env.AUDIT_KV, key, []);
  current.push({ ts: new Date().toISOString(), event, payload });
  if (current.length > 200) current.splice(0, current.length - 200);
  await kvPutJson(env.AUDIT_KV, key, current, { expirationTtl: 60 * 60 * 24 * 30 });
}

async function trackGlobalMetric(env, metric, delta = 1) {
  if (!env.GLOBAL_STATE_KV) return;
  const key = `metrics:${dayKey()}`;
  const m = await kvGetJson(env.GLOBAL_STATE_KV, key, {
    requests: 0,
    aiCalls: 0,
    voiceSessions: 0,
    ttsChars: 0,
    wsMessages: 0,
    wsConnections: 0,
    errors: 0,
    budgetUnits: 0,
    lastUpdated: null,
  });
  m[metric] = (m[metric] || 0) + delta;
  m.lastUpdated = new Date().toISOString();
  await kvPutJson(env.GLOBAL_STATE_KV, key, m, { expirationTtl: 60 * 60 * 24 * 90 });
}

async function trackUserUsage(env, userId, patch = {}) {
  if (!env.SESSIONS_KV) return { plan: "FREE", usage: {}, limits: PLAN_LIMITS.FREE };

  const key = `usage:${dayKey()}:${userId}`;
  const usage = await kvGetJson(env.SESSIONS_KV, key, {
    requests: 0,
    aiCalls: 0,
    voiceSessions: 0,
    ttsChars: 0,
    wsRooms: 0,
    updatedAt: null,
  });

  for (const [k, v] of Object.entries(patch)) {
    usage[k] = (usage[k] || 0) + v;
  }
  usage.updatedAt = new Date().toISOString();
  await kvPutJson(env.SESSIONS_KV, key, usage, { expirationTtl: 60 * 60 * 24 * 7 });

  const planState = await kvGetJson(env.SESSIONS_KV, `plan:${userId}`, null);
  const plan = (planState?.plan || "FREE").toUpperCase();
  return { plan: PLAN_LIMITS[plan] ? plan : "FREE", usage };
}

async function getUserPlanState(env, userId, headerPlan) {
  const saved = await kvGetJson(env.SESSIONS_KV, `plan:${userId}`, null);
  const plan = PLAN_LIMITS[(saved?.plan || headerPlan || "FREE").toUpperCase()] ? (saved?.plan || headerPlan || "FREE").toUpperCase() : "FREE";
  return { plan, source: saved ? "billing" : "header" };
}

async function enforceLimits(request, env, routeType, patch) {
  const userId = await getConsiaUserId(request);
  const headerPlan = getPlan(request);
  const planState = await getUserPlanState(env, userId, headerPlan);
  const limits = PLAN_LIMITS[planState.plan] || PLAN_LIMITS.FREE;

  const usageKey = `usage:${dayKey()}:${userId}`;
  const currentUsage = await kvGetJson(env.SESSIONS_KV, usageKey, {
    requests: 0,
    aiCalls: 0,
    voiceSessions: 0,
    ttsChars: 0,
    wsRooms: 0,
  });

  const next = { ...currentUsage };
  for (const [k, v] of Object.entries(patch || {})) next[k] = (next[k] || 0) + v;

  let violated = null;
  if ((next.requests || 0) > limits.requests) violated = "requests";
  if ((next.aiCalls || 0) > limits.aiCalls) violated = "aiCalls";
  if ((next.voiceSessions || 0) > limits.voiceSessions) violated = "voiceSessions";
  if ((next.ttsChars || 0) > limits.ttsChars) violated = "ttsChars";
  if ((next.wsRooms || 0) > limits.wsRooms) violated = "wsRooms";

  const globalBudgetLimit = Number(env.MAX_DAILY_BUDGET_UNITS || 0);
  if (globalBudgetLimit > 0 && env.GLOBAL_STATE_KV) {
    const gm = await kvGetJson(env.GLOBAL_STATE_KV, `metrics:${dayKey()}`, { budgetUnits: 0 });
    const projected = (gm.budgetUnits || 0) + (patch?.budgetUnits || 0);
    if (projected > globalBudgetLimit) violated = violated || "globalBudget";
  }

  if (violated) {
    await appendAudit(env, "soft_lock", { userId, plan: planState.plan, routeType, violated });
    const res = json(
      {
        ok: false,
        code: "LIMIT_REACHED",
        softLock: true,
        violated,
        plan: planState.plan,
        message: "Soft-lock activo: lÃ­mite alcanzado. Upgrade o esperar renovaciÃ³n diaria.",
      },
      429,
      {
        "x-consia-soft-lock": "1",
        "x-consia-plan": planState.plan,
      }
    );
    return { blocked: true, response: withCors(res, request, env) };
  }

  await trackUserUsage(env, userId, patch);
  if (patch?.requests) await trackGlobalMetric(env, "requests", patch.requests);
  if (patch?.aiCalls) await trackGlobalMetric(env, "aiCalls", patch.aiCalls);
  if (patch?.voiceSessions) await trackGlobalMetric(env, "voiceSessions", patch.voiceSessions);
  if (patch?.ttsChars) await trackGlobalMetric(env, "ttsChars", patch.ttsChars);
  if (patch?.wsRooms) await trackGlobalMetric(env, "wsConnections", patch.wsRooms);
  if (patch?.budgetUnits) await trackGlobalMetric(env, "budgetUnits", patch.budgetUnits);

  return { blocked: false, userId, plan: planState.plan, limits };
}

function requireOwner(request, env) {
  const token = request.headers.get("x-owner-token") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!(env.OWNER_TOKEN && token && token === env.OWNER_TOKEN);
}

async function proxyOpenAIRealtimeSession(request, env) {
  const body = await safeJson(request);
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: "OPENAI_API_KEY missing" }, 500);

  const model = body.model || env.REALTIME_MODEL || "gpt-4o-realtime-preview";
  const voice = body.voice || env.REALTIME_VOICE || "verse";

  const upstream = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      voice,
      modalities: ["audio", "text"],
      instructions:
        body.instructions ||
        env.REALTIME_INSTRUCTIONS ||
        "Sos CONSIA. Respuestas claras, directas, premium, Ãºtiles y breves. EspaÃ±ol por defecto.",
      input_audio_transcription: { model: env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe" },
      turn_detection: body.turn_detection || { type: "server_vad" },
    }),
  });

  const txt = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(txt);
  } catch {
    payload = { raw: txt };
  }

  if (!upstream.ok) {
    await appendAudit(env, "voice_session_error", { status: upstream.status, payload });
    return json({ ok: false, upstreamStatus: upstream.status, error: payload }, upstream.status);
  }

  await appendAudit(env, "voice_session_ok", { model, voice });
  return json({ ok: true, ...payload }, 200, { "cache-control": "no-store" });
}

async function proxyTTS(request, env) {
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: "OPENAI_API_KEY missing" }, 500);
  const body = await safeJson(request);
  const textInput = `${body.text || body.input || ""}`.trim();
  if (!textInput) return json({ ok: false, error: "text requerido" }, 400);

  const format = (body.format || body.response_format || "mp3").toLowerCase();
  const model = body.model || env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = body.voice || env.TTS_VOICE || "alloy";

  const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: textInput,
      response_format: format,
    }),
  });

  if (!upstream.ok) {
    const errTxt = await upstream.text();
    await appendAudit(env, "tts_error", { status: upstream.status, errTxt });
    return json({ ok: false, upstreamStatus: upstream.status, error: errTxt }, upstream.status);
  }

  const ct = format === "wav" ? "audio/wav" : format === "aac" ? "audio/aac" : "audio/mpeg";
  await appendAudit(env, "tts_ok", { chars: textInput.length, format, voice });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store",
      "x-consia-voice": voice,
      "x-consia-format": format,
    },
  });
}

async function proxyAsk(request, env) {
  const body = await safeJson(request);
  const message = (body.message || body.input || "").trim();
  if (!message) return json({ ok: false, error: "message requerido" }, 400);
  if (!env.OPENAI_API_KEY) return json({ ok: false, error: "OPENAI_API_KEY missing" }, 500);

  const model = body.model || env.CHAT_MODEL || "gpt-4o-mini";
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            env.CONSIA_SYSTEM_PROMPT ||
            "Sos CONSIA. Asistente premium, directo, Ãºtil, seguro, con foco en ejecuciÃ³n y claridad.",
        },
        { role: "user", content: message },
      ],
      temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
    }),
  });

  const txt = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(txt);
  } catch {
    payload = { raw: txt };
  }

  if (!upstream.ok) {
    await appendAudit(env, "ask_error", { status: upstream.status, payload });
    return json({ ok: false, upstreamStatus: upstream.status, error: payload }, upstream.status);
  }

  const answer = payload?.choices?.[0]?.message?.content || "";
  await appendAudit(env, "ask_ok", { chars: message.length });
  return json({ ok: true, answer, usage: payload.usage || null, raw: payload });
}

async function handleBillingWebhook(request, env) {
  const secret = request.headers.get("x-consia-webhook-secret") || "";
  if (!env.BILLING_WEBHOOK_SECRET || secret !== env.BILLING_WEBHOOK_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await safeJson(request);
  const userId = `${body.userId || body.user_id || ""}`.trim();
  const plan = `${body.plan || "FREE"}`.toUpperCase();
  if (!userId || !PLAN_LIMITS[plan]) return json({ ok: false, error: "userId/plan invÃ¡lido" }, 400);

  await kvPutJson(env.SESSIONS_KV, `plan:${userId}`, {
    plan,
    status: body.status || "active",
    source: body.source || "webhook",
    updatedAt: new Date().toISOString(),
    meta: body.meta || null,
  });
  await appendAudit(env, "billing_plan_update", { userId, plan });
  return json({ ok: true, userId, plan });
}

async function handleAdminMetrics(request, env) {
  if (!requireOwner(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  const today = await kvGetJson(env.GLOBAL_STATE_KV, `metrics:${dayKey()}`, {});
  const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yesterday = await kvGetJson(env.GLOBAL_STATE_KV, `metrics:${yesterdayKey}`, {});
  const audits = await kvGetJson(env.AUDIT_KV, `audit:${dayKey()}`, []);

  return json({
    ok: true,
    date: dayKey(),
    today,
    yesterday,
    auditCount: audits.length,
    lastAudit: audits.slice(-20),
    config: {
      realtimeModel: env.REALTIME_MODEL || "gpt-4o-realtime-preview",
      ttsModel: env.TTS_MODEL || "gpt-4o-mini-tts",
      chatModel: env.CHAT_MODEL || "gpt-4o-mini",
      maxDailyBudgetUnits: Number(env.MAX_DAILY_BUDGET_UNITS || 0),
    },
  });
}

async function handleAdminSetPlan(request, env) {
  if (!requireOwner(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await safeJson(request);
  const userId = `${body.userId || ""}`.trim();
  const plan = `${body.plan || ""}`.toUpperCase();
  if (!userId || !PLAN_LIMITS[plan]) return json({ ok: false, error: "userId/plan invÃ¡lido" }, 400);

  await kvPutJson(env.SESSIONS_KV, `plan:${userId}`, {
    plan,
    status: "active",
    source: "owner",
    updatedAt: new Date().toISOString(),
  });
  await appendAudit(env, "owner_set_plan", { userId, plan });
  return json({ ok: true, userId, plan });
}

async function routeRealtimeWS(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ ok: false, error: "WebSocket upgrade requerido" }, 426);
  }

  const url = new URL(request.url);
  const room = url.pathname.split("/").pop() || "global";
  const id = env.MEETING_DO.idFromName(room);
  const stub = env.MEETING_DO.get(id);
  return stub.fetch("https://do/realtime/" + room, {
    headers: request.headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Base routes
      if (request.method === "GET" && path === "/") {
        return withCors(text("CONSIA CORE ACTIVE"), request, env);
      }
      if (path === "/ping") {
        return withCors(
          json({
            ok: true,
            name: "CONSIA API",
            status: "active",
            ts: new Date().toISOString(),
            ws: "/realtime/:room",
            voiceSession: "/voice/session",
            voiceToken: "/voice/token",
            tts: "/voice/tts",
          }),
          request,
          env
        );
      }
      if (path === "/health") {
        return withCors(
          json({
            ok: true,
            service: "consia-api",
            version: "top1-live",
            hasOpenAI: !!env.OPENAI_API_KEY,
            hasOwner: !!env.OWNER_TOKEN,
            doBindings: {
              CONSIA_STATE: !!env.CONSIA_STATE,
              MEETING_DO: !!env.MEETING_DO,
            },
            kvBindings: {
              AUDIT_KV: !!env.AUDIT_KV,
              GLOBAL_STATE_KV: !!env.GLOBAL_STATE_KV,
              PRESENCE_KV: !!env.PRESENCE_KV,
              SESSIONS_KV: !!env.SESSIONS_KV,
              VAULT_KV: !!env.VAULT_KV,
            },
          }),
          request,
          env
        );
      }

      // Realtime room ws
      if (path.startsWith("/realtime/")) {
        const gate = await enforceLimits(request, env, "ws", { requests: 1, wsRooms: 1, budgetUnits: 1 });
        if (gate.blocked) return gate.response;
        return withCors(await routeRealtimeWS(request, env), request, env);
      }

      // Voice realtime session token
      if (request.method === "POST" && (path === "/voice/session" || path === "/voice/token")) {
        const gate = await enforceLimits(request, env, "voiceSession", { requests: 1, voiceSessions: 1, budgetUnits: 4 });
        if (gate.blocked) return gate.response;
        const res = await proxyOpenAIRealtimeSession(request, env);
        return withCors(res, request, env);
      }

      // TTS / Avatar voice sync audio source
      if (request.method === "POST" && (path === "/voice/tts" || path === "/avatar/tts")) {
        const body = await safeJson(request.clone());
        const chars = `${body.text || body.input || ""}`.length;
        const gate = await enforceLimits(request, env, "tts", {
          requests: 1,
          ttsChars: chars,
          budgetUnits: Math.max(1, Math.ceil(chars / 300)),
        });
        if (gate.blocked) return gate.response;
        const res = await proxyTTS(request, env);
        return withCors(res, request, env);
      }

      // AI text endpoint
      if (request.method === "POST" && path === "/ask") {
        const gate = await enforceLimits(request, env, "ask", { requests: 1, aiCalls: 1, budgetUnits: 2 });
        if (gate.blocked) return gate.response;
        const res = await proxyAsk(request, env);
        return withCors(res, request, env);
      }

      // Billing webhook
      if (request.method === "POST" && path === "/billing/webhook") {
        const res = await handleBillingWebhook(request, env);
        return withCors(res, request, env);
      }

      // Admin
      if (request.method === "GET" && path === "/admin/metrics") {
        const res = await handleAdminMetrics(request, env);
        return withCors(res, request, env);
      }
      if (request.method === "POST" && path === "/admin/set-plan") {
        const res = await handleAdminSetPlan(request, env);
        return withCors(res, request, env);
      }

      // Presence snapshot
      if (request.method === "GET" && path === "/presence") {
        const room = url.searchParams.get("room") || "global";
        const presence = await kvGetJson(env.PRESENCE_KV, `presence:${room}`, { room, users: 0, updatedAt: null });
        return withCors(json({ ok: true, ...presence }), request, env);
      }

      // Vault quick save/read (Owner-Only)
      if (path === "/vault/save" && request.method === "POST") {
        if (!requireOwner(request, env)) return withCors(json({ ok: false, error: "unauthorized" }, 401), request, env);
        const body = await safeJson(request);
        const key = body.key || `vault/${dayKey()}/${Date.now()}`;
        await kvPutJson(env.VAULT_KV, key, { ...body, savedAt: new Date().toISOString() }, { expirationTtl: 60 * 60 * 24 * 3650 });
        return withCors(json({ ok: true, key }), request, env);
      }
      if (path === "/vault/get" && request.method === "GET") {
        if (!requireOwner(request, env)) return withCors(json({ ok: false, error: "unauthorized" }, 401), request, env);
        const key = url.searchParams.get("key");
        if (!key) return withCors(json({ ok: false, error: "key requerido" }, 400), request, env);
        const data = await kvGetJson(env.VAULT_KV, key, null);
        return withCors(json({ ok: true, key, data }), request, env);
      }

      return withCors(json({ ok: false, error: "Route not found", path }, 404), request, env);
    } catch (err) {
      await trackGlobalMetric(env, "errors", 1);
      await appendAudit(env, "worker_error", { path, error: String(err?.stack || err) });
      const res = json({ ok: false, error: String(err?.message || err) }, 500);
      return withCors(res, request, env);
    } finally {
      const ms = Date.now() - started;
      ctx.waitUntil(trackGlobalMetric(env, "lastResponseMs", ms));
    }
  },
};

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/get")) {
      const key = url.searchParams.get("key") || "default";
      const val = await this.state.storage.get(key);
      return json({ ok: true, key, value: val ?? null });
    }

    if (request.method === "POST" && url.pathname.endsWith("/set")) {
      const body = await safeJson(request);
      const key = body.key || "default";
      await this.state.storage.put(key, body.value ?? null);
      return json({ ok: true, key });
    }

    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      const list = await this.state.storage.list({ limit: 100 });
      const out = {};
      for (const [k, v] of list) out[k] = v;
      return json({ ok: true, data: out });
    }

    return json({ ok: false, error: "ConsiaState route not found" }, 404);
  }
}

export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.room = this.room || url.pathname.split("/").pop() || "global";

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const socketId = crypto.randomUUID();
      const user = request.headers.get("x-consia-user") || `anon-${socketId.slice(0, 8)}`;

      server.accept();
      this.sockets.set(socketId, { ws: server, user });

      await this._updatePresence();
      this._broadcast({ type: "presence", room: this.room, users: this.sockets.size });
      this._broadcast({ type: "join", room: this.room, user, socketId });

      server.addEventListener("message", async (evt) => {
        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          payload = { type: "message", text: String(evt.data) };
        }

        if (payload?.type === "ping") {
          server.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        }

        this._broadcast({
          type: payload.type || "message",
          room: this.room,
          from: user,
          socketId,
          data: payload,
          ts: Date.now(),
        });

        if (this.env?.GLOBAL_STATE_KV) {
          const key = `metrics:${dayKey()}`;
          const m = await kvGetJson(this.env.GLOBAL_STATE_KV, key, { wsMessages: 0 });
          m.wsMessages = (m.wsMessages || 0) + 1;
          m.lastUpdated = new Date().toISOString();
          await kvPutJson(this.env.GLOBAL_STATE_KV, key, m, { expirationTtl: 60 * 60 * 24 * 90 });
        }
      });

      const onClose = async () => {
        this.sockets.delete(socketId);
        await this._updatePresence();
        this._broadcast({ type: "leave", room: this.room, user, socketId });
        this._broadcast({ type: "presence", room: this.room, users: this.sockets.size });
      };

      server.addEventListener("close", onClose);
      server.addEventListener("error", onClose);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET") {
      return json({ ok: true, room: this.room, users: this.sockets.size });
    }

    return json({ ok: false, error: "MeetingRoom route not found" }, 404);
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const { ws } of this.sockets.values()) {
      try {
        ws.send(msg);
      } catch {
        // ignore dead sockets
      }
    }
  }

  async _updatePresence() {
    if (!this.env?.PRESENCE_KV) return;
    await kvPutJson(this.env.PRESENCE_KV, `presence:${this.room}`, {
      room: this.room,
      users: this.sockets.size,
      updatedAt: new Date().toISOString(),
    }, { expirationTtl: 60 * 60 * 24 * 7 });
  }
}
