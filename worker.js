export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-consia-device, x-consia-session, x-owner-token",
  "cache-control": "no-store",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function text(data, status = 200, extraHeaders = {}) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function isOwner(request, env) {
  const auth = request.headers.get("authorization") || "";
  const xOwner = request.headers.get("x-owner-token") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const q = new URL(request.url).searchParams.get("t") || "";

  const provided = bearer || xOwner || q;
  return !!(env.OWNER_TOKEN && provided && provided === env.OWNER_TOKEN);
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Root / health
  if (pathname === "/" || pathname === "/health" || pathname === "/ping") {
    return json({
      ok: true,
      service: "consia-api",
      status: "healthy",
      ts: new Date().toISOString(),
      env: env.ENVIRONMENT || "prod",
    });
  }

  // Owner ping
  if (pathname === "/owner/ping") {
    if (!isOwner(request, env)) {
      return json(
        { ok: false, error: "Unauthorized", route: "/owner/ping" },
        401
      );
    }
    return json({ ok: true, owner: true, service: "CONSIA", status: "secure" });
  }

  // Durable Object ping (verifica binding + clase)
  if (pathname === "/meet/ping") {
    try {
      const id = env.MEETING_DO.idFromName("consia-global");
      const stub = env.MEETING_DO.get(id);
      const res = await stub.fetch("https://do/ping");
      const data = await res.json();
      return json({
        ok: true,
        route: "/meet/ping",
        durable_object: data,
      });
    } catch (e) {
      return json(
        {
          ok: false,
          route: "/meet/ping",
          error: e?.message || "DO ping failed",
        },
        500
      );
    }
  }

  // Durable Object room ping (opcional)
  if (pathname.startsWith("/meet/room/") && pathname.endsWith("/ping")) {
    const room = pathname.split("/")[3] || "default";
    try {
      const id = env.MEETING_DO.idFromName(room);
      const stub = env.MEETING_DO.get(id);
      const res = await stub.fetch("https://do/ping");
      const data = await res.json();
      return json({
        ok: true,
        route: pathname,
        room,
        durable_object: data,
      });
    } catch (e) {
      return json({ ok: false, room, error: e?.message || "DO ping failed" }, 500);
    }
  }

  // WebSocket directo (worker-level)
  if (pathname === "/ws") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ ok: false, error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.send(
      JSON.stringify({
        ok: true,
        type: "connected",
        service: "consia-api",
        ts: new Date().toISOString(),
      })
    );

    const interval = setInterval(() => {
      try {
        server.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {
        clearInterval(interval);
      }
    }, 15000);

    server.addEventListener("message", (evt) => {
      try {
        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          payload = { text: String(evt.data) };
        }

        // Echo base / placeholder realtime pipeline
        server.send(
          JSON.stringify({
            type: "ack",
            ok: true,
            received: payload,
            ts: Date.now(),
          })
        );
      } catch (e) {
        try {
          server.send(JSON.stringify({ type: "error", error: e?.message || "ws error" }));
        } catch {}
      }
    });

    const closeAll = () => {
      clearInterval(interval);
      try {
        server.close(1000, "bye");
      } catch {}
    };

    server.addEventListener("close", closeAll);
    server.addEventListener("error", closeAll);

    return new Response(null, { status: 101, webSocket: client });
  }

  // WebSocket room via Durable Object (recomendado para realtime rooms)
  if (pathname.startsWith("/meet/ws/")) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ ok: false, error: "Expected WebSocket upgrade" }, 426);
    }

    const room = pathname.split("/").pop() || "default";
    const id = env.MEETING_DO.idFromName(room);
    const stub = env.MEETING_DO.get(id);

    // Reenvía la upgrade request al DO
    return stub.fetch("https://do/ws?room=" + encodeURIComponent(room), {
      headers: request.headers,
    });
  }

  // Ask (OpenAI Responses API)
  if (pathname === "/ask" && request.method === "POST") {
    return handleAsk(request, env);
  }

  return json({ ok: false, error: "Not found", path: pathname }, 404);
}

async function handleAsk(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: "Missing OPENAI_API_KEY secret",
      },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, route: "/ask", error: "Invalid JSON body" }, 400);
  }

  const message =
    typeof body?.message === "string"
      ? body.message
      : Array.isArray(body?.input)
      ? body.input.join("\n")
      : "";

  if (!message) {
    return json(
      { ok: false, route: "/ask", error: "Missing 'message' in body" },
      400
    );
  }

  const model = body?.model || env.OPENAI_MODEL || "gpt-4.1-mini";
  const systemPrompt =
    body?.system ||
    "You are CONSIA, a premium AI assistant. Be concise, useful, and accurate.";

  const upstreamPayload = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    ],
  };

  let upstreamRes;
  let raw;
  try {
    upstreamRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(upstreamPayload),
    });

    raw = await upstreamRes.json();
  } catch (e) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: e?.message || "Upstream request failed",
      },
      502
    );
  }

  if (!upstreamRes.ok) {
    return json(
      {
        ok: false,
        route: "/ask",
        error: raw?.error?.message || "Upstream error",
        detail: raw?.error || null,
        upstream_status: upstreamRes.status,
        upstream: "responses",
        raw,
      },
      upstreamRes.status
    );
  }

  const answer =
    raw?.output_text ||
    extractTextFromResponses(raw) ||
    "OK";

  return json({
    ok: true,
    route: "/ask",
    model,
    output: answer,
    raw_id: raw?.id || null,
  });
}

function extractTextFromResponses(raw) {
  try {
    // fallback robusto
    if (Array.isArray(raw?.output)) {
      const chunks = [];
      for (const item of raw.output) {
        if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (typeof c?.text === "string") chunks.push(c.text);
          }
        }
      }
      return chunks.join("\n").trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Durable Object room / state
 */
export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    this.room = null;
    this.createdAt = Date.now();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ping") {
      return json({
        ok: true,
        durable_object: "ConsiaState",
        room: this.room || "unassigned",
        sockets: this.sockets.size,
        ts: new Date().toISOString(),
      });
    }

    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ ok: false, error: "Expected WebSocket upgrade" }, 426);
      }

      this.room = url.searchParams.get("room") || this.room || "default";

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      this.sockets.add(server);

      server.send(
        JSON.stringify({
          type: "room_connected",
          ok: true,
          room: this.room,
          sockets: this.sockets.size,
          ts: Date.now(),
        })
      );

      const onMessage = (evt) => {
        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          payload = { text: String(evt.data) };
        }

        const packet = JSON.stringify({
          type: "room_message",
          room: this.room,
          payload,
          ts: Date.now(),
        });

        for (const ws of this.sockets) {
          try {
            ws.send(packet);
          } catch {}
        }
      };

      const onClose = () => {
        this.sockets.delete(server);
        try {
          server.close(1000, "closed");
        } catch {}
      };

      server.addEventListener("message", onMessage);
      server.addEventListener("close", onClose);
      server.addEventListener("error", onClose);

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, error: "DO route not found", path }, 404);
  }
}
