// ===============================
// CONSIA CORE WORKER — DEFINITIVO
// ===============================

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

const corsHeaders = (env) => ({
  "access-control-allow-origin": env.CORS_ALLOW_ORIGINS || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-consia-device",
  "access-control-max-age": "86400",
});

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --------- HEALTH ----------
    if (path === "/" || path === "/health") {
      return json(
        {
          ok: true,
          service: "CONSIA",
          state: "awake",
          message: "El sistema está consciente.",
          timestamp: Date.now(),
        },
        200,
        corsHeaders(env)
      );
    }

    // --------- MEMORY ----------
    if (path.startsWith("/memory")) {
      const id = env.MEMORY.idFromName("global");
      const stub = env.MEMORY.get(id);
      return stub.fetch(request);
    }

    // --------- IDENTITY ----------
    if (path.startsWith("/identity")) {
      const id = env.IDENTITY.idFromName("global");
      const stub = env.IDENTITY.get(id);
      return stub.fetch(request);
    }

    // --------- UI STATE ----------
    if (path.startsWith("/ui")) {
      const id = env.UI_STATE.idFromName("global");
      const stub = env.UI_STATE.get(id);
      return stub.fetch(request);
    }

    // --------- OWNER ----------
    if (path.startsWith("/owner")) {
      const auth = request.headers.get("authorization");
      if (!auth || auth !== `Bearer ${env.CONSIA_OWNER_TOKEN}`) {
        return json(
          { ok: false, error: "OWNER_ONLY" },
          403,
          corsHeaders(env)
        );
      }
      const id = env.OWNER.idFromName("root");
      const stub = env.OWNER.get(id);
      return stub.fetch(request);
    }

    return json(
      { ok: false, error: "NOT_FOUND" },
      404,
      corsHeaders(env)
    );
  },
};

// ===============================
// DURABLE OBJECTS
// ===============================

export class CONSIA_MEMORY {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    const data = (await this.state.storage.get("memory")) || {};
    return json({ ok: true, memory: data });
  }
}

export class CONSIA_IDENTITY {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const device =
      request.headers.get("x-consia-device") || "unknown";
    await this.state.storage.put("last_device", device);
    return json({ ok: true, device });
  }
}

export class CONSIA_UI_STATE {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    const ui = (await this.state.storage.get("ui")) || {
      theme: "dark",
      mode: "focus",
    };
    return json({ ok: true, ui });
  }
}

export class CONSIA_OWNER {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    return json({
      ok: true,
      owner: "authenticated",
      powers: "absolute",
      timestamp: Date.now(),
    });
  }
}
