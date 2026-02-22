// CONSIA API — worker.js (PRO FINAL)
// Binding DO exacto requerido: CONSIA_STATE -> clase Durable Object "consia-api_ConsiaState"
// Secrets soportados:
// - CONSIA_OWNER_TOKEN (o OWNER_TOKEN)
// - DEVICE_TOKEN (opcional, para /ws)
// - API_KEY (o OPENAI_API_KEY) para /ask
// - CONSIA_MODEL / OPENAI_MODEL (opcional)

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, x-consia-device, x-consia-session, x-owner-token",
    "cache-control": "no-store",
  };
}

function withCors(resp) {
  const h = new Headers(resp.headers);
  const c = corsHeaders();
  for (const [k, v] of Object.entries(c)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function getBearer(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function getOwnerTokenFromRequest(request) {
  const url = new URL(request.url);
  return (
    (request.headers.get("x-owner-token") || "").trim() ||
    getBearer(request) ||
    (url.searchParams.get("token") || "").trim()
  );
}

function ownerOk(request, env) {
  const expected =
    (env.CONSIA_OWNER_TOKEN || env.OWNER_TOKEN || "").trim();
  if (!expected) return false;
  const got = getOwnerTokenFromRequest(request);
  return !!got && got === expected;
}

function deviceOk(request, env) {
  const allowWsOpen = String(env.CONSIA_ALLOW_WS || "").toLowerCase() === "true";
  if (allowWsOpen) return true;

  const expected = (env.DEVICE_TOKEN || env.CONSIA_DEVICE_TOKEN || "").trim();
  if (!expected) return true; // si no configuraste DEVICE_TOKEN, deja probar /ws

  const url = new URL(request.url);
  const got =
    (request.headers.get("x-consia-device") || "").trim() ||
    (request.headers.get("x-consia-session") || "").trim() ||
    getBearer(request) ||
    (url.searchParams.get("device_token") || "").trim();

  return !!got && got === expected;
}

async function safeReadJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function extractResponseText(upstream) {
  if (!upstream) return "";
  if (typeof upstream.output_text === "string" && upstream.output_text.trim()) {
    return upstream.output_text.trim();
  }
  // Fallback parse
  const out = upstream.output;
  if (Array.isArray(out)) {
    const chunks = [];
    for (const item of out) {
      if (!item) continue;
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;
          if (typeof c.text === "string") chunks.push(c.text);
          if (typeof c.output_text === "string") chunks.push(c.output_text);
        }
      }
      if (typeof item.text === "string") chunks.push(item.text);
    }
    const text = chunks.join("\n").trim();
    if (text) return text;
  }
  return "";
}

async function callResponsesApi(apiKey, payload) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  let raw = null;
  try {
    raw = await res.json();
  } catch {
    raw = null;
  }

  return { res, raw };
}

async function handleAsk(request, env) {
  if (request.method === "GET") {
    return json({
      ok: true,
      route: "/ask",
      method: "GET",
      message: "Use POST /ask with JSON body { \"message\": \"...\" }",
    });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const body = await safeReadJson(request);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const message = String(body.message || body.input || "").trim();
  if (!message) {
    return json({ ok: false, error: "missing_message" }, 400);
  }

  const apiKey = String(env.API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: "missing_openai_api_key",
        detail: "Set secret API_KEY (or OPENAI_API_KEY) with a real OpenAI API key.",
      },
      500
    );
  }

  // Detecta clave incorrecta tipo "consia_..."
  if (apiKey.toLowerCase().startsWith("consia_")) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: "invalid_openai_api_key",
        detail: "API_KEY must be a real OpenAI key (starts with sk-...).",
      },
      500
    );
  }

  const preferredModel = String(env.CONSIA_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const fallbackModel = "gpt-4.1-mini";

  const basePayload = {
    model: preferredModel,
    input: message,
    // Si querés, podés definir CONSIA_SYSTEM en secrets
    ...(env.CONSIA_SYSTEM ? { instructions: String(env.CONSIA_SYSTEM) } : {}),
  };

  let { res, raw } = await callResponsesApi(apiKey, basePayload);

  // Fallback de modelo si el configurado no existe para esa cuenta
  if (!res.ok && raw?.error?.code === "model_not_found" && preferredModel !== fallbackModel) {
    ({ res, raw } = await callResponsesApi(apiKey, { ...basePayload, model: fallbackModel }));
  }

  if (!res.ok) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: raw?.error?.message || "upstream_error",
        detail: null,
        upstream_status: res.status,
        upstream: "responses",
        raw,
      },
      502
    );
  }

  const text = extractResponseText(raw);

  return json({
    ok: true,
    route: "/ask",
    model: raw?.model || preferredModel,
    output: text || "",
    raw_id: raw?.id || null,
    created: raw?.created_at || null,
  });
}

async function handleOwnerPing(request, env) {
  if (!ownerOk(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return json({ ok: true, owner: true, service: "CONSIA", status: "secure" });
}

async function handleOwnerDiag(request, env) {
  if (!ownerOk(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const doBound = !!env.CONSIA_STATE && typeof env.CONSIA_STATE.idFromName === "function";
  const hasOpenAI = !!(env.API_KEY || env.OPENAI_API_KEY);
  const hasOwner = !!(env.CONSIA_OWNER_TOKEN || env.OWNER_TOKEN);
  const hasDevice = !!(env.DEVICE_TOKEN || env.CONSIA_DEVICE_TOKEN);

  let doPing = null;
  if (doBound) {
    try {
      const id = env.CONSIA_STATE.idFromName("global");
      const stub = env.CONSIA_STATE.get(id);
      const r = await stub.fetch("https://do.internal/ping");
      doPing = await r.json();
    } catch (e) {
      doPing = { ok: false, error: String(e) };
    }
  }

  return json({
    ok: true,
    route: "/owner/diag",
    bindings: { CONSIA_STATE: doBound },
    secrets: {
      ownerToken: hasOwner,
      deviceToken: hasDevice,
      openaiApiKey: hasOpenAI,
    },
    model: String(env.CONSIA_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini"),
    do_ping: doPing,
  });
}

async function handleWs(request, env) {
  const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
  if (upgrade !== "websocket") {
    return json({ ok: false, error: "expected_websocket_upgrade" }, 426);
  }

  if (!deviceOk(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const ns = env.CONSIA_STATE;
  if (!ns || typeof ns.idFromName !== "function") {
    return json(
      {
        ok: false,
        error: "do_binding_missing",
        detail: "Binding DO exacto: CONSIA_STATE -> consia-api_ConsiaState",
      },
      500
    );
  }

  try {
    const id = ns.idFromName("global");
    const stub = ns.get(id);
    return await stub.fetch(request);
  } catch (e) {
    return json(
      {
        ok: false,
        error: "do_binding_error",
        detail: String(e),
        hint: "Verificá binding DO exacto: CONSIA_STATE -> consia-api_ConsiaState",
      },
      500
    );
  }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  // Health / root
  if (path === "/" || path === "/health" || path === "/ping") {
    return json({
      ok: true,
      service: "consia-api",
      status: "healthy",
      ts: new Date().toISOString(),
      env: "prod",
    });
  }

  // Owner
  if (path === "/owner/ping") return handleOwnerPing(request, env);
  if (path === "/owner/diag") return handleOwnerDiag(request, env);

  // Ask
  if (path === "/ask") return handleAsk(request, env);

  // WS
  if (path === "/ws") return handleWs(request, env);

  return json({ ok: false, error: "Not found", path }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const resp = await route(request, env, ctx);

      // No tocar handshakes WS (status 101)
      if (resp && resp.status === 101) return resp;

      return withCors(resp);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return withCors(
        json(
          {
            ok: false,
            error: "worker_exception",
            detail: msg,
          },
          500
        )
      );
    }
  },
};

// Durable Object: CONSIA real-time hub (echo/broadcast simple)
export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return json({
        ok: true,
        do: "ConsiaState",
        status: "alive",
        sockets: this.state.getWebSockets().length,
        ts: new Date().toISOString(),
      });
    }

    if (url.pathname === "/ws") {
      const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
      if (upgrade !== "websocket") {
        return json({ ok: false, error: "expected_websocket_upgrade" }, 426);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.state.acceptWebSocket(server);

      // Mensaje inicial
      try {
        server.send(
          JSON.stringify({
            ok: true,
            type: "welcome",
            service: "CONSIA_WS",
            sockets: this.state.getWebSockets().length,
            ts: new Date().toISOString(),
          })
        );
      } catch {}

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, error: "Not found", path: url.pathname }, 404);
  }

  webSocketMessage(ws, message) {
    let text = "";
    try {
      if (typeof message === "string") text = message;
      else text = new TextDecoder().decode(message);
    } catch {
      text = "";
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }

    const packet = JSON.stringify({
      ok: true,
      type: "message",
      ts: new Date().toISOString(),
      payload: parsed,
      sockets: this.state.getWebSockets().length,
    });

    for (const sock of this.state.getWebSockets()) {
      try {
        sock.send(packet);
      } catch {}
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  webSocketError(ws, error) {
    try {
      ws.send(
        JSON.stringify({
          ok: false,
          type: "ws_error",
          error: String(error),
        })
      );
    } catch {}
  }
}
