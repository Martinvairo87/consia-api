export class ConsiaState {
  constructor(state, env) {
    this.state = state
    this.sessions = new Map()
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.handleSession(server)

    return new Response(null, {
      status: 101,
      webSocket: client
    })
  }

  handleSession(ws) {
    ws.accept()

    ws.addEventListener("message", event => {
      const msg = event.data

      ws.send(JSON.stringify({
        type: "CONSIA_WS",
        message: msg
      }))
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // ROOT
    if (url.pathname === "/") {
      return new Response("CONSIA API ACTIVE")
    }

    // MEET PING
    if (url.pathname === "/meet/ping") {
      return Response.json({
        status: "ok",
        service: "CONSIA MEET",
        realtime: true
      })
    }

    // WS ROUTE
    if (url.pathname === "/ws") {
      const id = env.MEETING_DO.idFromName("global")
      const obj = env.MEETING_DO.get(id)
      return obj.fetch(request)
    }

    return new Response("Not Found", { status: 404 })
  }
}
