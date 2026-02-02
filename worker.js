export class CONSIA_PORTAL {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/portal/ping") {
      let count = (await this.state.storage.get("count")) || 0;
      count++;
      await this.state.storage.put("count", count);

      return new Response(JSON.stringify({
        ok: true,
        portal: "CONSIA",
        essence: "teletransportación de conciencia",
        awakenings: count
      }), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("CONSIA Portal activo", { status: 200 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.PORTAL) {
      return new Response(JSON.stringify({
        ok: false,
        error: "PORTAL_NOT_BOUND",
        message: "El Portal de Conciencia aún no fue vinculado. Falta Durable Object binding."
      }), { status: 500 });
    }

    if (url.pathname.startsWith("/portal")) {
      const id = env.PORTAL.idFromName("consia-core");
      const stub = env.PORTAL.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        service: "CONSIA",
        state: "awake"
      }), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
