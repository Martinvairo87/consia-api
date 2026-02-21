// worker.js — CONSIA API (definitivo, DO + seguridad + presupuesto + rate-limit + WS + Vault)
// ENTRYPOINT: worker.js (wrangler.toml -> main="worker.js")

// =========================
// Utils
// =========================
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function nowMs() {
  return Date.now();
}

function isoDayUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return "";
  }
}

function getClientIP(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function u8ToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const u8 = new Uint8Array(sig);
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const o = normalizeOrigin(origin);

  // Allowed origins:
  // - CONSIA sites
  // - localhost for dev
  // - (optional) extra origins in env.CORS_ALLOWLIST (comma-separated)
  const allow = new Set([
    "https://consia.world",
    "https://api.consia.world",
    "http://localhost:3000",
    "http://localhost:5173",
  ]);

  if (env.CORS_ALLOWLIST) {
    for (const item of env.CORS_ALLOWLIST.split(",").map((x) => x.trim()).filter(Boolean)) {
      allow.add(item);
    }
  }

  const allowOrigin = allow.has(o) ? o : "https://consia.world";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers":
      "content-type, authorization, x-consia-device, x-consia-session, x-consia-sig, x-consia-ts",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "vary": "Origin",
  };
}

function isPreflight(request) {
  return request.method === "OPTIONS";
}

function bearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseJSONSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// =========================
// Security gates
// =========================
async function requireOwner(env, request) {
  const t = bearerToken(request);
  if (!env.CONSIA_OWNER_TOKEN) return false;
  return timingSafeEq(t, env.CONSIA_OWNER_TOKEN);
}

// Optional request signing (HMAC) for sensitive routes.
// Client sends:
// - x-consia-ts: unix ms
// - x-consia-sig: hex(hmac(secret, `${ts}.${method}.${path}.${bodySha256?}`))
// For simplicity we sign `${ts}.${method}.${pathname}`
async function verifyHmac(env, request) {
  if (!env.HMAC_SECRET) return true; // if not set, don't block
  const ts = request.headers.get("x-consia-ts") || "";
  const sig = request.headers.get("x-consia-sig") || "";
  const t = Number(ts);
  if (!Number.isFinite(t)) return false;
  const drift = Math.abs(nowMs() - t);
  if (drift > 5 * 60 * 1000) return false; // 5 min
  const url = new URL(request.url);
  const msg = `${ts}.${request.method.toUpperCase()}.${url.pathname}`;
  const expected = await hmacSha256Hex(env.HMAC_SECRET, msg);
  return timingSafeEq(sig, expected);
}

// =========================
// Rate limit (KV)
// =========================
async function rateLimit(env, request, bucket, limit, windowSec) {
  // Requires KV: GLOBAL_STATE or SESSIONS_KV (we use GLOBAL_STATE)
  const kv = env.GLOBAL_STATE;
  if (!kv) return { ok: true };

  const ip = getClientIP(request);
  const key = `rl:${bucket}:${ip}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const curStr = await kv.get(key);
  const cur = curStr ? Number(curStr) : 0;

  if (cur >= limit) {
    return { ok: false, status: 429, body: { ok: false, error: "rate_limited" } };
  }

  // best-effort increment
  await kv.put(key, String(cur + 1), { expirationTtl: windowSec + 5 });
  return { ok: true };
}

// =========================
// Global daily budget (KV)
// =========================
async function budgetTryConsumeUSD(env, amountUsd) {
  const kv = env.GLOBAL_STATE;
  if (!kv) return { ok: true, used: 0, cap: 0 };

  const cap = Number(env.MAX_DAILY_BUDGET_USD || "0");
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true, used: 0, cap: 0 };

  const day = isoDayUTC();
  const key = `budget:${day}`;
  const curStr = await kv.get(key);
  const cur = curStr ? Number(curStr) : 0;

  const next = cur + amountUsd;
  if (next > cap) return { ok: false, used: cur, cap };

  await kv.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 3 });
  return { ok: true, used: next, cap };
}

// =========================
// Vault (AES-GCM) on KV
// =========================
async function vaultEncrypt(env, plaintextU8) {
  const keyB64 = env.ENC_KEY_B64;
  if (!keyB64) throw new Error("ENC_KEY_B64 missing");
  const keyRaw = b64ToU8(keyB64);
  const key = await crypto.subtle.importKey("raw", keyRaw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextU8);
  return {
    iv_b64: u8ToB64(iv),
    ct_b64: u8ToB64(new Uint8Array(ct)),
  };
}

async function vaultDecrypt(env, iv_b64, ct_b64) {
  const keyB64 = env.ENC_KEY_B64;
  if (!keyB64) throw new Error("ENC_KEY_B64 missing");
  const keyRaw = b64ToU8(keyB64);
  const key = await crypto.subtle.importKey("raw", keyRaw, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = b64ToU8(iv_b64);
  const ct = b64ToU8(ct_b64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

// =========================
// OpenAI proxy (minimal, production-safe)
// =========================
async function openaiChat(env, { messages, model, temperature, max_output_tokens }) {
  const apiKey = env.OPENAI_API_KEY || env.API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const m = model || env.OPENAI_MODEL || "gpt-4.1-mini";
  const body = {
    model: m,
    messages,
    temperature: typeof temperature === "number" ? clamp(temperature, 0, 1) : 0.2,
  };

  // allow either max_tokens or max_output_tokens depending on your preference
  if (typeof max_output_tokens === "number") body.max_tokens = clamp(max_output_tokens, 1, 2000);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function estimateUsdFromUsage(env, usage) {
  // Top-1 stable: strict budget enforcement needs real pricing tables.
  // Aquí: estimación conservadora configurable, sin romper producción.
  const per1k = Number(env.EST_USD_PER_1K_TOKENS || "0.002"); // default conservative placeholder
  const total = Number(usage?.total_tokens || 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return (total / 1000) * per1k;
}

// =========================
// Durable Object: ConsiaState (WS + state)
// =========================
export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sockets.add(server);

      server.addEventListener("message", (evt) => {
        // Broadcast to all (presence / avatar / realtime)
        for (const ws of this.sockets) {
          try {
            if (ws !== server) ws.send(evt.data);
          } catch {}
        }
      });

      const cleanup = () => {
        this.sockets.delete(server);
        try { server.close(); } catch {}
      };

      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Basic DO REST for internal state if needed
    if (url.pathname === "/do/ping") {
      return json({ ok: true, do: "ConsiaState", time: Date.now() });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
}

// =========================
// Main router
// =========================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (isPreflight(request)) return new Response(null, { status: 204, headers: cors });

    // Always set baseline security headers
    const baseHeaders = {
      ...cors,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };

    // Global lightweight rate-limit
    {
      const rl = await rateLimit(env, request, "global", 120, 60);
      if (!rl.ok) return json(rl.body, rl.status, baseHeaders);
    }

    // Health
    if (url.pathname === "/health" || url.pathname === "/") {
      return json(
        {
          ok: true,
          name: "CONSIA API",
          env: env.ENVIRONMENT || "prod",
          day: isoDayUTC(),
        },
        200,
        baseHeaders
      );
    }

    // Realtime WS (through Durable Object)
    if (url.pathname === "/realtime") {
      const id = env.MEETING_DO?.idFromName("global");
      if (!id) return json({ ok: false, error: "MEETING_DO missing" }, 500, baseHeaders);
      const stub = env.MEETING_DO.get(id);
      // forward upgrade
      return stub.fetch("https://do.consia/realtime", request);
    }

    // Owner-only admin ping
    if (url.pathname === "/owner/ping") {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: "unauthorized" }, 401, baseHeaders);
      return json({ ok: true, owner: true, time: Date.now() }, 200, baseHeaders);
    }

    // Vault endpoints (Owner-only + optional HMAC)
    if (url.pathname.startsWith("/vault/")) {
      if (!(await requireOwner(env, request))) return json({ ok: false, error: "unauthorized" }, 401, baseHeaders);
      if (!(await verifyHmac(env, request))) return json({ ok: false, error: "bad_signature" }, 401, baseHeaders);
      if (!env.VAULT_KV) return json({ ok: false, error: "VAULT_KV missing" }, 500, baseHeaders);

      const key = url.pathname.replace("/vault/", "").trim();
      if (!key) return json({ ok: false, error: "missing_key" }, 400, baseHeaders);

      if (request.method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const sealed = await vaultEncrypt(env, bytes);
        await env.VAULT_KV.put(`vault:${key}`, JSON.stringify(sealed));
        return json({ ok: true, stored: key }, 200, baseHeaders);
      }

      if (request.method === "GET") {
        const raw = await env.VAULT_KV.get(`vault:${key}`);
        if (!raw) return json({ ok: false, error: "not_found" }, 404, baseHeaders);
        const sealed = parseJSONSafe(raw);
        if (!sealed?.iv_b64 || !sealed?.ct_b64) return json({ ok: false, error: "corrupt" }, 500, baseHeaders);
        const pt = await vaultDecrypt(env, sealed.iv_b64, sealed.ct_b64);
        return new Response(pt, { status: 200, headers: { ...baseHeaders, "content-type": "application/octet-stream" } });
      }

      if (request.method === "DELETE") {
        await env.VAULT_KV.delete(`vault:${key}`);
        return json({ ok: true, deleted: key }, 200, baseHeaders);
      }

      return json({ ok: false, error: "method_not_allowed" }, 405, baseHeaders);
    }

    // CONSIA Ask (public with guardrails + budget + RL)
    if (url.pathname === "/ask" && request.method === "POST") {
      // Stronger RL on /ask
      {
        const rl = await rateLimit(env, request, "ask", 30, 60);
        if (!rl.ok) return json(rl.body, rl.status, baseHeaders);
      }

      const body = await request.json().catch(() => null);
      if (!body) return json({ ok: false, error: "bad_json" }, 400, baseHeaders);

      // Accept either {message} or {messages}
      const message = typeof body.message === "string" ? body.message : "";
      const messages = Array.isArray(body.messages) ? body.messages : null;

      const chatMessages =
        messages ||
        [
          {
            role: "system",
            content:
              "You are CONSIA. Be concise, execution-first, secure-by-default. No secrets. No unsafe guidance.",
          },
          { role: "user", content: message },
        ];

      // Budget cap (pre-check with conservative estimate)
      // (We’ll reconcile after usage is known; this prevents runaway.)
      {
        const pre = Number(env.PRECHECK_USD_PER_REQUEST || "0");
        if (pre > 0) {
          const b = await budgetTryConsumeUSD(env, pre);
          if (!b.ok) return json({ ok: false, error: "daily_budget_exceeded" }, 429, baseHeaders);
        }
      }

      try {
        const data = await openaiChat(env, {
          messages: chatMessages,
          model: body.model,
          temperature: body.temperature,
          max_output_tokens: body.max_output_tokens,
        });

        // Post usage-based budget (best-effort)
        if (data?.usage) {
          const usd = estimateUsdFromUsage(env, data.usage);
          if (usd > 0) {
            const b = await budgetTryConsumeUSD(env, usd);
            if (!b.ok) {
              // Soft-lock: allow response but signal budget reached
              return json(
                {
                  ok: true,
                  warning: "budget_reached_after_response",
                  result: data,
                },
                200,
                baseHeaders
              );
            }
          }
        }

        // Minimal response payload
        return json(
          {
            ok: true,
            id: data.id,
            model: data.model,
            usage: data.usage || null,
            content: data.choices?.[0]?.message?.content ?? "",
            raw: body.return_raw ? data : undefined,
          },
          200,
          baseHeaders
        );
      } catch (e) {
        return json({ ok: false, error: "openai_failed", message: String(e?.message || e) }, 502, baseHeaders);
      }
    }

    // Not found
    return json({ ok: false, error: "not_found", path: url.pathname }, 404, baseHeaders);
  },
};
