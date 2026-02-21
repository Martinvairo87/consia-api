// CONSIA API — PRO SECURITY LAYER
// AUTH + OWNER TOKEN + ROUTES BASE

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
      ws.send(JSON.stringify({
        type: "CONSIA_WS",
        message: event.data
      }))
    })
  }
}

// ===============================
// AUTH HELPERS
// ===============================

function unauthorized() {
  return new Response(JSON.stringify({
    ok: false,
    error: "unauthorized"
  }), { status: 401 })
}

function verifyOwner(request, env) {
  const token =
    request.headers.get("authorization") ||
    request.headers.get("x-owner-token")

  if (!token) return false

  return token.replace("Bearer ", "") === env.OWNER_TOKEN
}

// ===============================
// ROUTER
// ===============================

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // ROOT
    if (url.pathname === "/") {
      return new Response("CONSIA API ACTIVE")
    }

    // HEALTH
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "consia-api",
        status: "healthy",
        env: env.ENVIRONMENT,
        ts: new Date().toISOString()
      })
    }

    // OWNER TEST
    if (url.pathname === "/owner/ping") {
      if (!verifyOwner(request, env)) return unauthorized()

      return Response.json({
        ok: true,
        owner: true,
        service: "CONSIA",
        status: "secure"
      })
    }

    // ASK (stub)
    if (url.pathname === "/ask") {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          route: "/ask",
          method: "GET",
          message: "Use POST /ask with JSON body { message: '...' }"
        })
      }

      const body = await request.json()

      return Response.json({
        ok: true,
        reply: `CONSIA received: ${body.message}`
      })
    }

    // MEET PING
    if (url.pathname === "/meet/ping") {
      return Response.json({
        ok: true,
        route: "/meet/ping",
        service: "CONSIA",
        status: "pong",
        ts: new Date().toISOString()
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
