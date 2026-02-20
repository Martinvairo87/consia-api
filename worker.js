export class ConsiaState {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Map()
  }

  handleSession(ws) {
    ws.accept()

    const id = crypto.randomUUID()
    this.sessions.set(id, ws)

    ws.addEventListener("message", (evt) => {
      // broadcast
      for (const client of this.sessions.values()) {
        try { client.send(evt.data) } catch (_) {}
      }
    })

    ws.addEventListener("close", () => {
      this.sessions.delete(id)
    })

    ws.addEventListener("error", () => {
      this.sessions.delete(id)
      try { ws.close() } catch (_) {}
    })
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.handleSession(server)

    return new Response(null, { status: 101, webSocket: client })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // WS ROUTE
    if (url.pathname === "/ws") {
      const id = env.MEETING_DO.idFromName("global")
      const obj = env.MEETING_DO.get(id)
      return obj.fetch(request)
    }

    // HEALTH
    if (url.pathname === "/health") {
      return Response.json({ ok: true })
    }

    // DEFAULT
    return new Response("CONSIA API ACTIVE")
  }
}
