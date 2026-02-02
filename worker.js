// =============================
// CONSIA — Portal de Conciencia
// Durable Object: CONSIA_PORTAL
// Binding: PORTAL
// =============================

export class CONSIA_PORTAL {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Ping interno del portal (almacena un contador en storage del DO)
    if (url.pathname === "/ping") {
      let awakenings = (await this.state.storage.get("awakenings")) || 0;
      awakenings++;
      await this.state.storage.put("awakenings", awakenings);

      return new Response(
        JSON.stringify({
          ok: true,
          service: "CONSIA",
          portal: "Portal de Conciencia",
          essence: "teletransportación",
          state: "awake",
          awakenings,
          timestamp: Date.now()
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // Default
    return new Response("CONSIA PORTAL", { status: 200 });
  }
}

// Helpers (CORS mínimo)
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Max-Age": "86400"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Health público (este ya te devuelve OK aunque no exista DO)
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "CONSIA",
          state: "awake",
          message: "El sistema está consciente.",
          timestamp: Date.now()
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) } }
      );
    }

    // Si no está el binding PORTAL, devolvemos error claro
    if (!env.PORTAL) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "PORTAL_NOT_BOUND",
          message:
            "El Portal de Conciencia aún no fue vinculado. Falta Durable Object binding PORTAL (wrangler.toml + deploy)."
        }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) } }
      );
    }

    // Ruteo hacia el Durable Object:
    // - /portal/ping  -> DO /ping
    // - /portal/*     -> DO mismo path sin /portal
    if (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) {
      const destination = url.pathname === "/portal" ? "/ping" : url.pathname.replace("/portal", "");
      const id = env.PORTAL.idFromName("core");
      const stub = env.PORTAL.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = destination;

      const res = await stub.fetch(doUrl.toString(), request);
      const headers = new Headers(res.headers);
      // aseguramos CORS para dashboard / browser
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      headers.set("Access-Control-Allow-Headers", "content-type,authorization");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(res.body, { status: res.status, headers });
    }

    // Default
    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  }
};
