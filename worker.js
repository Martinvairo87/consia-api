export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: cors()
      });
    }

    // HEALTH
    if (url.pathname === "/health") {
      return json({ ok: true, realtime: true });
    }

    // CREATE / JOIN ROOM
    if (url.pathname.startsWith("/realtime/")) {
      const room = url.pathname.split("/")[2] || "global";

      const id = env.MEETING_DO.idFromName(room);
      const stub = env.MEETING_DO.get(id);

      return stub.fetch(request);
    }

    return json({ ok: true, route: "root" });
  }
};

// ================= ROOM =================

export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const id = crypto.randomUUID();

    this.sessions.set(id, server);

    server.accept();

    server.addEventListener("message", evt => {
      for (const [sid, socket] of this.sessions) {
        if (sid !== id) {
          socket.send(evt.data);
        }
      }
    });

    server.addEventListener("close", () => {
      this.sessions.delete(id);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}

// ================= UTILS =================

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      ...cors()
    }
  });
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "*"
  };
}
