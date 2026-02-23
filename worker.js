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
