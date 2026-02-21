// CONSIA API — worker.js definitivo PRO (estable + DO + rutas base + /ask listo)
// Source of truth: GitHub repo consia-api (main)

const SERVICE_NAME = "consia-api";
const CORS_ORIGIN = "*";

function corsHeaders() {
  return {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, x-consia-device, x-consia-session",
    "access-control-allow-credentials": "true",
    "content-type": "application/json; charset=utf-8",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function text(data, status = 200, extraHeaders = {}) {
  return new Response(String(data), {
    status,
    headers: {
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, x-consia-device, x-consia-session",
      "content-type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

async function safeJsonParse(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getBearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

function isOwnerAuthorized(request, env) {
  const token = getBearerToken(request);
  if (!env?.OWNER_TOKEN) return true; // si no configuraste token todavía, no rompe
  return token && token === env.OWNER_TOKEN;
}

async function handleAsk(request, env) {
  if (request.method === "GET") {
    return json({
      ok: true,
      route: "/ask",
      method: "GET",
      message: "Use POST /ask with JSON body { message: '...' }",
    });
  }

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "method_not_allowed",
        allowed: ["GET", "POST", "OPTIONS"],
      },
      405
    );
  }

  const body = await safeJsonParse(request);
  if (!body || typeof body !== "object") {
    return json(
      {
        ok: false,
        error: "invalid_json",
        message: "Body must be valid JSON",
      },
      400
    );
  }

  const message = String(body.message ?? "").trim();
  if (!message) {
    return json(
      {
        ok: false,
        error: "missing_message",
        message: "Body requires { message: '...' }",
      },
      400
    );
  }

  // Owner-only opcional (si seteás OWNER_TOKEN en secrets)
  if (env?.OWNER_TOKEN && !isOwnerAuthorized(request, env)) {
    return json(
      {
        ok: false,
        error: "unauthorized",
        message: "Invalid owner token",
      },
      401
    );
  }

  // Modo estable local (sin romper si todavía no hay OpenAI configurado)
  // Si luego querés IA real, te agrego el bloque con OPENAI_API_KEY sin tocar rutas.
  return json({
    ok: true,
    route: "/ask",
    service: "CONSIA",
    mode: "stable-local",
    input: { message },
    output: {
      reply: `CONSIA recibió: ${message}`,
      note: "API estable. Endpoint listo para conectar IA real cuando quieras.",
    },
    ts: new Date().toISOString(),
  });
}

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  _broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of [...this.sessions]) {
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
        try {
          ws.close(1011, "Send failed");
        } catch {}
      }
    }
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return noContent();

      // Ping del módulo meet (funciona aunque entre al DO)
      if (url.pathname.endsWith("/meet/ping") || url.pathname.endsWith("/ping")) {
        return json({
          ok: true,
          route: "/meet/ping",
          service: "CONSIA",
          status: "pong",
          ts: new Date().toISOString(),
        });
      }

      const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return json(
          {
            ok: false,
            error: "expected_websocket",
            message: "Use WebSocket upgrade on /ws or /meet/ws",
          },
          400
        );
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sessions.add(server);

      const sessionId = crypto.randomUUID();

      // Mensaje de bienvenida
      server.send(
        JSON.stringify({
          type: "CONSIA_WS_CONNECTED",
          sessionId,
          service: "CONSIA",
          ts: new Date().toISOString(),
        })
      );

      server.addEventListener("message", (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : String(event.data);
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { text: raw };
          }

          const msgType = parsed?.type || "CONSIA_WS";
          const payload = {
            type: msgType,
            service: "CONSIA",
            sessionId,
            message: parsed?.message ?? parsed?.text ?? raw,
            ts: new Date().toISOString(),
          };

          // Echo + broadcast simple (estable)
          this._broadcast(payload);
        } catch (err) {
          try {
            server.send(
              JSON.stringify({
                type: "CONSIA_WS_ERROR",
                error: String(err?.message || err),
                ts: new Date().toISOString(),
              })
            );
          } catch {}
        }
      });

      const cleanup = () => {
        this.sessions.delete(server);
      };

      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    } catch (err) {
      return json(
        {
          ok: false,
          error: "do_exception",
          message: String(err?.message || err),
        },
        500
      );
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return noContent();

      // Ruta base (texto simple como querés)
      if (path === "/") {
        return text("CONSIA API ACTIVE", 200);
      }

      // Health
      if (path === "/health") {
        return json({
          ok: true,
          service: SERVICE_NAME,
          status: "healthy",
          ts: new Date().toISOString(),
          env: env?.ENVIRONMENT || "prod",
        });
      }

      // Ping meet (HTTP)
      if (path === "/meet/ping") {
        return json({
          ok: true,
          route: "/meet/ping",
          service: "CONSIA",
          status: "pong",
          ts: new Date().toISOString(),
        });
      }

      // WebSocket route (global room via Durable Object)
      if (path === "/ws" || path === "/meet/ws") {
        if (!env?.MEETING_DO) {
          return json(
            {
              ok: false,
              error: "missing_binding",
              message: "MEETING_DO binding is not configured",
            },
            500
          );
        }
        const id = env.MEETING_DO.idFromName("global");
        const stub = env.MEETING_DO.get(id);
        return stub.fetch(request);
      }

      // Ask endpoint
      if (path === "/ask") {
        return handleAsk(request, env);
      }

      // 404
      return json(
        {
          ok: false,
          error: "not_found",
          route: path,
          message: "Route not found",
        },
        404
      );
    } catch (err) {
      // Nunca tirar excepción sin capturar (evita Error 1101)
      return json(
        {
          ok: false,
          error: "worker_exception",
          message: String(err?.message || err),
          ts: new Date().toISOString(),
        },
        500
      );
    }
  },
};
