// =====================================================
// CONSIA API — CORE WORKER — TOP 1 INFINITO
// =====================================================

// -----------------------------
// Durable Object
// -----------------------------
export class ConsiaState {
  constructor(state, env) {
    this.state = state
    this.sessions = new Map()
  }

  async fetch(request) {

    // --- FIX 1101 ---
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("CONSIA WS READY", {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
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
        message: msg,
        ts: Date.now()
      }))
    })

    ws.addEventListener("close", () => {})
  }
}

// -----------------------------
// Worker Fetch
// -----------------------------
export default {
  async fetch(request, env) {

    const url = new URL(request.url)

    // -----------------------------
    // HEALTH
    // -----------------------------
    if (url.pathname === "/") {
      return new Response("CONSIA API ACTIVE", {
        headers: { "content-type": "text/plain" }
      })
    }

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        system: "CONSIA",
        ts: Date.now()
      })
    }

    // -----------------------------
    // WS ROUTE
    // -----------------------------
    if (url.pathname === "/ws") {
      const id = env.MEETING_DO.idFromName("global")
      const obj = env.MEETING_DO.get(id)
      return obj.fetch(request)
    }

    // -----------------------------
    // ASK IA
    // -----------------------------
    if (url.pathname === "/ask") {

      if (request.method !== "POST") {
        return new Response("POST required", { status: 405 })
      }

      const body = await request.json().catch(() => ({}))
      const message = body.message || "empty"

      // ---- DEMO IA ----
      // (Luego conectamos OpenAI real)

      return Response.json({
        system: "CONSIA",
        reply: `Procesado: ${message}`,
        ts: Date.now()
      })
    }

    // -----------------------------
    // MEET PING
    // -----------------------------
    if (url.pathname === "/meet/ping") {
      return Response.json({
        meet: "online",
        ws: "ready",
        ts: Date.now()
      })
    }

    // -----------------------------
    // 404
    // -----------------------------
    return new Response("CONSIA ROUTE NOT FOUND", { status: 404 })
  }
}
