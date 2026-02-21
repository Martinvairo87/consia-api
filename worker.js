// CONSIA API — WORKER DEFINITIVO TOP 1

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
    try {

      const url = new URL(request.url)

      // ROOT
      if (url.pathname === "/") {
        return new Response("CONSIA API ACTIVE", {
          headers: { "content-type": "text/plain" }
        })
      }

      // ASK ENDPOINT
      if (url.pathname === "/ask") {
        return new Response(JSON.stringify({
          status: "ok",
          message: "CONSIA AI READY"
        }), {
          headers: { "content-type": "application/json" }
        })
      }

      // WS ROUTE
      if (url.pathname === "/ws") {
        const id = env.MEETING_DO.idFromName("global")
        const obj = env.MEETING_DO.get(id)
        return obj.fetch(request)
      }

      // MEET PING
      if (url.pathname === "/meet/ping") {
        return new Response(JSON.stringify({
          meet: "active",
          realtime: "ok"
        }), {
          headers: { "content-type": "application/json" }
        })
      }

      return new Response("Not Found", { status: 404 })

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Worker Exception",
          detail: err.message
        }),
        { status: 500 }
      )
    }
  }
}
