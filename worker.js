export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // Health
    if (url.pathname === "/health") {
      return cors(json({ ok: true, service: "consia-api", env: env.ENVIRONMENT || "prod" }));
    }

    // Durable Object proxy (State / Meeting)
    if (url.pathname.startsWith("/state")) {
      const id = env.MEETING_DO.idFromName("global");
      return cors(await env.MEETING_DO.get(id).fetch(request));
    }

    // Simple ask endpoint (Owner-gated optional)
    if (url.pathname === "/ask" && request.method === "POST") {
      // OPTIONAL gate: if you set CONSIA_OWNER_TOKEN secret, it enforces it.
      const owner = env.CONSIA_OWNER_TOKEN;
      if (owner) {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token !== owner) return cors(json({ ok: false, error: "unauthorized" }, 401));
      }

      const body = await safeJson(request);
      const message = (body?.message || "").toString().slice(0, 4000);
      if (!message) return cors(json({ ok: false, error: "missing_message" }, 400));

      // If no OpenAI key, return echo (keeps worker alive)
      if (!env.OPENAI_API_KEY) {
        return cors(json({ ok: true, mode: "echo", reply: message }));
      }

      const model = env.OPENAI_MODEL || "gpt-4.1-mini";

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          input: message,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return cors(json({ ok: false, error: "openai_error", detail: data }, res.status));
      }

      const reply =
        data?.output_text ||
        data?.output?.[0]?.content?.[0]?.text ||
        "";

      return cors(json({ ok: true, model, reply }));
    }

    return cors(json({ ok: false, error: "not_found" }, 404));
  },
};

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // SQLite init (only once)
    await this.state.storage.transaction(async () => {
      const sql = this.state.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL,
          t INTEGER NOT NULL
        );
      `);
    });

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/state/get" && request.method === "POST") {
      const { key } = await safeJson(request);
      const k = (key || "").toString().slice(0, 256);
      if (!k) return cors(json({ ok: false, error: "missing_key" }, 400));

      const sql = this.state.storage.sql;
      const row = sql.exec("SELECT v, t FROM kv WHERE k = ? LIMIT 1", k).toArray()[0];
      if (!row) return cors(json({ ok: true, key: k, value: null }));

      return cors(json({ ok: true, key: k, value: row.v, t: row.t }));
    }

    if (url.pathname === "/state/set" && request.method === "POST") {
      const { key, value } = await safeJson(request);
      const k = (key || "").toString().slice(0, 256);
      const v = (value ?? "").toString().slice(0, 20000);
      if (!k) return cors(json({ ok: false, error: "missing_key" }, 400));

      const t = Date.now();
      const sql = this.state.storage.sql;
      sql.exec("INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t", k, v, t);

      return cors(json({ ok: true, key: k, t }));
    }

    if (url.pathname === "/state/ping") {
      return cors(json({ ok: true, pong: true, ts: Date.now() }));
    }

    return cors(json({ ok: false, error: "state_not_found" }, 404));
  }
}

/* helpers */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type, authorization");
  return new Response(res.body, { status: res.status, headers: h });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
