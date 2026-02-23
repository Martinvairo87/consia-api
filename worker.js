export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // HEALTH
    if (url.pathname === "/health") {
      return new Response("CONSIA VOICE OK");
    }

    // REALTIME ROOM WS
    if (url.pathname.startsWith("/realtime/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const roomName = url.pathname.split("/")[2] || "global";
      const id = env.MEETING_DO.idFromName(roomName);
      const stub = env.MEETING_DO.get(id);

      ctx.waitUntil(stub.fetch(request, { webSocket: server }));

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // VOICE TOKEN (Realtime AI session)
    if (url.pathname === "/voice/token") {
      const token = crypto.randomUUID();

      return Response.json({
        ok: true,
        token,
        voice: "alloy",
        realtime: true
      });
    }

    return new Response("CONSIA API OK");
  }
};

//////////////////////////////////////////////////////////////////
// DURABLE OBJECT — ROOMS + PRESENCE + AUDIO STREAM
//////////////////////////////////////////////////////////////////

export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();

    const id = crypto.randomUUID();
    this.sessions.set(id, server);

    server.send(JSON.stringify({
      type: "system",
      text: "Connected to CONSIA Voice Room"
    }));

    server.addEventListener("message", evt => {
      for (const [sid, sock] of this.sessions) {
        if (sock !== server) {
          sock.send(evt.data);
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
