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
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h,
  });
}

function getBearer(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function ownerOk(request, env) {
  const ownerToken = env.CONSIA_OWNER_TOKEN || env.OWNER_TOKEN || "";
  if (!ownerToken) return false;
  const xOwner = (request.headers.get("x-owner-token") || "").trim();
  const bearer = getBearer(request);
  return xOwner === ownerToken || bearer === ownerToken;
}

function apiOk(request, env) {
  const apiKey = env.API_KEY || "";
  if (!apiKey) return true;
  const bearer = getBearer(request);
  return bearer === apiKey || ownerOk(request, env);
}

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();

      if (url.pathname.endsWith("/ping")) {
        return withCors(
          json({
            ok: true,
            route: "/meet/ping",
            service: "CONSIA",
            status: "pong",
            ts: new Date().toISOString(),
          })
        );
      }

      if (upgrade !== "websocket") {
        return withCors(json({ ok: false, error: "Expected WebSocket" }, 400));
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      this.sessions.add(server);

      server.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "[binary]";
        const payload = JSON.stringify({
          ok: true,
          type: "CONSIA_WS",
          message: text,
          ts: new Date().toISOString(),
        });

        for (const ws of this.sessions) {
          try {
            ws.send(payload);
          } catch {
            this.sessions.delete(ws);
          }
        }
      });

      const cleanup = () => this.sessions.delete(server);
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    } catch (err) {
      return withCors(
        json(
          {
            ok: false,
            error: "ws_exception",
            detail: String(err && err.message ? err.message : err),
          },
          500
        )
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/") {
        return withCors(
          new Response("CONSIA API ACTIVE", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        );
      }

      if (url.pathname === "/health") {
        return withCors(
          json({
            ok: true,
            service: "consia-api",
            status: "healthy",
            ts: new Date().toISOString(),
            env: "prod",
          })
        );
      }

      if (url.pathname === "/meet/ping") {
        return withCors(
          json({
            ok: true,
            route: "/meet/ping",
            service: "CONSIA",
            status: "pong",
            ts: new Date().toISOString(),
          })
        );
      }

      if (url.pathname === "/owner/ping") {
        if (!ownerOk(request, env)) {
          return withCors(json({ ok: false, error: "unauthorized" }, 401));
        }
        return withCors(
          json({ ok: true, owner: true, service: "CONSIA", status: "secure" })
        );
      }

      if (url.pathname === "/ask") {
        if (request.method === "GET") {
          return withCors(
            json({
              ok: true,
              route: "/ask",
              method: "GET",
              message: "Use POST /ask with JSON body { message: '...' }",
            })
          );
        }

        if (request.method !== "POST") {
          return withCors(json({ ok: false, error: "method_not_allowed" }, 405));
        }

        if (!apiOk(request, env)) {
          return withCors(json({ ok: false, error: "unauthorized" }, 401));
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return withCors(json({ ok: false, error: "invalid_json" }, 400));
        }

        const message = (body?.message ?? "").toString().trim();
        if (!message) {
          return withCors(json({ ok: false, error: "message_required" }, 400));
        }

        return withCors(
          json({
            ok: true,
            route: "/ask",
            status: "ready",
            reply: `CONSIA recibió: ${message}`,
            ts: new Date().toISOString(),
          })
        );
      }

      if (url.pathname === "/ws") {
        if (!env.MEETING_DO || typeof env.MEETING_DO.idFromName !== "function") {
          return withCors(json({ ok: false, error: "MEETING_DO binding missing" }, 500));
        }
        const id = env.MEETING_DO.idFromName("global");
        const stub = env.MEETING_DO.get(id);
        return stub.fetch(request);
      }

      return withCors(json({ ok: false, error: "Not found", path: url.pathname }, 404));
    } catch (err) {
      return withCors(
        json(
          {
            ok: false,
            error: "worker_exception",
            detail: String(err && err.message ? err.message : err),
          },
          500
        )
      );
    }
  },
};
