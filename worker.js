/**
 * CONSIA API — worker.js (PRO Integrated)
 *
 * Requiere:
 *  - Durable Object binding: CONSIA_STATE  -> class ConsiaState
 *  - Secrets:
 *      - CONSIA_OWNER_TOKEN   (o OWNER_TOKEN)
 *      - OPENAI_API_KEY       (o API_KEY)
 *      - OPENAI_MODEL         (opcional, default "gpt-4.1-mini")
 *  - KV (opcional, si ya lo tenés):
 *      - AUDIT_KV, VAULT_KV, SESSIONS_KV, PRESENCE_KV, GLOBAL_STATE_KV
 *
 * Rutas:
 *  - GET  /health
 *  - GET  /ping
 *  - GET  /owner/ping (Owner)
 *  - POST /ask         { "message": "hola" }
 *  - GET  /ws          (WebSocket simple)
 *  - GET  /meet/ping
 *  - GET  /meet/ws/:room  (WebSocket por room via Durable Object)
 */

const DEFAULT_MODEL = "gpt-4.1-mini";

/* ---------------- helpers ---------------- */

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

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin === "null" ? "*" : origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, x-consia-device, x-consia-session, x-owner-token",
    "access-control-allow-credentials": "true",
    "cache-control": "no-store",
    "vary": "origin",
  };
}

function withCors(request, resp) {
  const h = new Headers(resp.headers);
  const c = corsHeaders(request);
  for (const [k, v] of Object.entries(c)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function bearer(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function ownerTokenFromRequest(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("token") || "").trim();
  const h = (request.headers.get("x-owner-token") || "").trim();
  const b = bearer(request);
  return q || h || b;
}

function ownerOk(request, env) {
  const expected = (env.CONSIA_OWNER_TOKEN || env.OWNER_TOKEN || "").trim();
  if (!expected) return false;
  const got = ownerTokenFromRequest(request);
  return got && got === expected;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function audit(env, event) {
  // best-effort (no rompe nada si no existe AUDIT_KV)
  try {
    if (!env.AUDIT_KV) return;
    const id = crypto.randomUUID();
    await env.AUDIT_KV.put(
      `audit:${Date.now()}:${id}`,
      JSON.stringify(event),
      { expirationTtl: 60 * 60 * 24 * 7 } // 7 días
    );
  } catch {}
}

/* ---------------- OpenAI call (Responses API) ---------------- */

async function callOpenAI(env, message) {
  const apiKey = (env.OPENAI_API_KEY || env.API_KEY || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      error: "missing_openai_api_key",
      detail: "Set OPENAI_API_KEY (secret) in Worker",
      upstream_status: null,
      upstream: "responses",
      raw: null,
    };
  }

  const model = (env.OPENAI_MODEL || DEFAULT_MODEL).trim();

  const payload = {
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: String(message || "") }],
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      error:
        raw?.error?.message ||
        `upstream_error_${res.status}`,
      detail: null,
      upstream_status: res.status,
      upstream: "responses",
      raw,
    };
  }

  // extrae texto de salida
  let text = "";
  try {
    const out = raw.output || [];
    for (const item of out) {
      const content = item.content || [];
      for (const c of content) {
        if (c.type === "output_text") text += c.text || "";
      }
    }
  } catch {}

  return { ok: true, model, text: text || "", raw };
}

/* ---------------- WebSocket simple (/ws) ---------------- */

function wsUpgradeEcho(request) {
  const upgrade = request.headers.get("Upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return json({ ok: false, error: "expected_websocket" }, 426);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();
  server.send(JSON.stringify({ ok: true, service: "CONSIA", ws: "connected" }));

  server.addEventListener("message", (evt) => {
    try {
      server.send(JSON.stringify({ ok: true, echo: evt.data }));
    } catch {
      try { server.close(1011, "error"); } catch {}
    }
  });

  server.addEventListener("close", () => {
    try { server.close(); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

/* ---------------- Durable Object (rooms) ---------------- */

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set(); // sockets de este room
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /__room/status
    if (path.endsWith("/__room/status")) {
      return json({
        ok: true,
        durable_object: "ConsiaState",
        sockets: this.sockets.size,
        ts: new Date().toISOString(),
      });
    }

    // WS endpoint dentro del DO: /__room/ws
    if (path.endsWith("/__room/ws")) {
      const upgrade = request.headers.get("Upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "expected_websocket" }, 426);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      this.sockets.add(server);
      server.send(
        JSON.stringify({
          ok: true,
          room: this.state.id.toString(),
          role: "room",
          sockets: this.sockets.size,
        })
      );

      server.addEventListener("message", (evt) => {
        // broadcast a todos en el room
        for (const ws of this.sockets) {
          try {
            ws.send(
              JSON.stringify({
                ok: true,
                room: this.state.id.toString(),
                message: evt.data,
              })
            );
          } catch {}
        }
      });

      const cleanup = () => {
        this.sockets.delete(server);
        try { server.close(); } catch {}
      };

      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, error: "not_found", path }, 404);
  }
}

/* ---------------- main router ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // OPTIONS (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // health / ping
    if (request.method === "GET" && path === "/health") {
      return withCors(
        request,
        json({
          ok: true,
          service: "consia-api",
          status: "healthy",
          ts: new Date().toISOString(),
          env: env.ENV || "prod",
        })
      );
    }

    if (request.method === "GET" && path === "/ping") {
      return withCors(
        request,
        json({
          ok: true,
          route: "/ping",
          service: "CONSIA",
          status: "pong",
          ts: new Date().toISOString(),
        })
      );
    }

    // owner ping
    if (request.method === "GET" && path === "/owner/ping") {
      if (!ownerOk(request, env)) {
        return withCors(request, json({ ok: false, error: "unauthorized" }, 401));
      }
      return withCors(
        request,
        json({ ok: true, owner: true, service: "CONSIA", status: "secure" })
      );
    }

    // ask
    if (path === "/ask") {
      if (request.method === "GET") {
        return withCors(
          request,
          json({
            ok: true,
            route: "/ask",
            method: "GET",
            message: "Use POST /ask with JSON body { message: '...' }",
          })
        );
      }

      if (request.method !== "POST") {
        return withCors(request, json({ ok: false, error: "method_not_allowed" }, 405));
      }

      const body = await readJson(request);
      if (!body || typeof body.message !== "string") {
        return withCors(request, json({ ok: false, error: "invalid_json" }, 400));
      }

      const device = request.headers.get("x-consia-device") || null;
      const session = request.headers.get("x-consia-session") || null;

      ctx.waitUntil(
        audit(env, {
          type: "ask",
          ts: Date.now(),
          device,
          session,
          len: body.message.length,
        })
      );

      const out = await callOpenAI(env, body.message);
      const status = out.ok ? 200 : (out.upstream_status || 502);

      return withCors(
        request,
        json(
          {
            ok: out.ok,
            route: "/ask",
            model: out.model || null,
            text: out.text || null,
            error: out.ok ? null : out.error,
            detail: out.detail || null,
            upstream_status: out.upstream_status || null,
            upstream: out.upstream || null,
            raw: out.ok ? null : out.raw,
          },
          status
        )
      );
    }

    // WS (simple)
    if (request.method === "GET" && path === "/ws") {
      return withCors(request, wsUpgradeEcho(request));
    }

    // meet ping (verifica DO)
    if (request.method === "GET" && path === "/meet/ping") {
      try {
        const id = env.CONSIA_STATE.idFromName("consia:global");
        const stub = env.CONSIA_STATE.get(id);
        const statusResp = await stub.fetch("https://do.local/__room/status");
        const statusJson = await statusResp.json().catch(() => null);

        return withCors(
          request,
          json({
            ok: true,
            route: "/meet/ping",
            service: "CONSIA",
            durable_object: statusJson || { ok: true },
            ts: new Date().toISOString(),
          })
        );
      } catch (e) {
        return withCors(
          request,
          json(
            {
              ok: false,
              route: "/meet/ping",
              error: "durable_object_not_ready",
              detail: String(e?.message || e),
            },
            502
          )
        );
      }
    }

    // meet ws room: /meet/ws/:room
    if (request.method === "GET" && path.startsWith("/meet/ws/")) {
      const parts = path.split("/").filter(Boolean); // ["meet","ws",":room"]
      const room = parts[2] || "global";

      const upgrade = request.headers.get("Upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return withCors(request, json({ ok: false, error: "expected_websocket" }, 426));
      }

      try {
        const id = env.CONSIA_STATE.idFromName(`consia:room:${room}`);
        const stub = env.CONSIA_STATE.get(id);
        // proxy WS hacia el DO
        const resp = await stub.fetch("https://do.local/__room/ws", request);
        return resp; // ya viene con 101
      } catch (e) {
        return withCors(
          request,
          json({ ok: false, error: "ws_room_failed", detail: String(e?.message || e) }, 502)
        );
      }
    }

    // default
    return withCors(request, json({ ok: false, error: "Not found", path }, 404));
  },
};
