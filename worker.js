export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("CONSIA API OK");
    }

    if (url.pathname.startsWith("/realtime/")) {
      const roomId = url.pathname.split("/")[2] || "global";
      const id = env.MEETING_DO.idFromName(roomId);
      const stub = env.MEETING_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("CONSIA CORE ACTIVE");
  }
};

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
  }
}

export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const id = crypto.randomUUID();
      this.sessions.set(id, server);

      server.accept();

      server.addEventListener("message", (event) => {
        for (const [sid, ws] of this.sessions) {
          if (sid !== id) {
            ws.send(event.data);
          }
        }
      });

      server.addEventListener("close", () => {
        this.sessions.delete(id);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("MeetingRoom Active");
  }
}
