// worker.js — CONSIA API (definitivo) — Top 1 / Infinito
// Entry: wrangler.toml -> main="worker.js"
// Bindings esperados (por Dashboard o wrangler.toml):
// - Durable Object: MEETING_DO (class ConsiaState)
// - KV: AUDIT_KV, GLOBAL_STATE, PRESENCE, SESSIONS_KV, VAULT_KV
// - D1 (opcional): CONSIA_DB
// - Secrets: OPENAI_API_KEY, CONSIA_OWNER_TOKEN, DEVICE_TOKEN, HMAC_SECRET, ENC_KEY_B64, VAULT_MASTER_KEY
// - Vars (opcional): ENVIRONMENT="prod", OPENAI_MODEL, MAX_DAILY_BUDGET_USD

export default {
  async fetch(request, env, ctx) {
    try {
      // CORS preflight
      if (request.method === "OPTIONS") return corsPreflight(request, env);

      const url = new URL(request.url);
      const path = url.pathname;

      // Health / info (sin auth)
      if (path === "/" || path === "/health" || path === "/_health") {
        return corsJson(request, env, 200, {
          ok: true,
          service: "consia-api",
          env: env.ENVIRONMENT || "prod",
          ts: new Date().toISOString(),
        });
      }
      if (path === "/version" || path === "/_version") {
        return corsJson(request, env, 200, {
          name: "consia-api",
          build: "v1",
          compatibility_date: "2026-02-01",
        });
      }

      // AUTH (todo lo demás)
      const auth = await requireAuth(request, env);
      if (!auth.ok) return corsJson(request, env, auth.status, { ok: false, error: auth.error });

      // Rate limit (soft)
      const rl = await rateLimit(request, env, auth);
      if (!rl.ok) return corsJson(request, env, 429, { ok: false, error: "rate_limited" });

      // Budget cap global (soft-lock)
      const budget = await enforceGlobalBudget(env);
      if (!budget.ok) return corsJson(request, env, 429, { ok: false, error: "global_budget_lock" });

      // Router
      if (path === "/ask" && request.method === "POST") {
        const body = await safeJson(request);
        const message = (body?.message ?? "").toString();
        const meta = body?.meta ?? {};
        if (!message) return corsJson(request, env, 400, { ok: false, error: "missing_message" });

        // Idempotencia
        const idem = request.headers.get("x-idempotency-key") || "";
        if (idem) {
          const cached = await env.SESSIONS_KV?.get(`idem:${idem}`, "json");
          if (cached) return corsJson(request, env, 200, cached);
        }

        const result = await openaiAsk(env, {
          message,
          meta,
          user: auth.subject,
          ip: request.headers.get("cf-connecting-ip") || null,
        });

        // Audit + cache idem
        ctx.waitUntil(audit(env, auth, "ask", { ok: result.ok }));
        if (idem && env.SESSIONS_KV) ctx.waitUntil(env.SESSIONS_KV.put(`idem:${idem}`, JSON.stringify(result), { expirationTtl: 60 * 5 }));

        // “Cost” estimado (muy conservador) para budget cap
        ctx.waitUntil(addGlobalSpend(env, estimateSpendUsd(result)));

        return corsJson(request, env, result.ok ? 200 : 500, result);
      }

      // Meetings (Durable Object)
      // POST /meet/start -> crea/retorna meeting_id
      if (path === "/meet/start" && request.method === "POST") {
        const body = await safeJson(request);
        const meetingId = (body?.meeting_id || cryptoRandomId("mtg")).toString();

        const stub = env.MEETING_DO.get(env.MEETING_DO.idFromName(meetingId));
        const res = await stub.fetch("https://do/meet/init", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            meeting_id: meetingId,
            owner: auth.subject,
            title: body?.title || "",
          }),
        });

        const data = await res.json();
        ctx.waitUntil(audit(env, auth, "meet_start", { meeting_id: meetingId }));
        return corsJson(request, env, res.status, data);
      }

      // GET/POST /meet/:id
      if (path.startsWith("/meet/")) {
        const meetingId = path.split("/")[2] || "";
        if (!meetingId) return corsJson(request, env, 400, { ok: false, error: "missing_meeting_id" });

        const stub = env.MEETING_DO.get(env.MEETING_DO.idFromName(meetingId));
        const subPath = path.replace(`/meet/${meetingId}`, "") || "/";
        const doUrl = "https://do" + subPath;

        const doRes = await stub.fetch(doUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
        });

        const txt = await doRes.text();
        return corsText(request, env, doRes.status, txt, doRes.headers.get("content-type") || "application/json");
      }

      // Vault (KV + cifrado AES-GCM)
      // PUT /vault/:key  body: { value:any }
      if (path.startsWith("/vault/")) {
        if (!env.VAULT_KV) return corsJson(request, env, 501, { ok: false, error: "VAULT_KV_missing" });

        const key = decodeURIComponent(path.slice("/vault/".length)).trim();
        if (!key) return corsJson(request, env, 400, { ok: false, error: "missing_key" });

        if (request.method === "PUT" || request.method === "POST") {
          const body = await safeJson(request);
          const plaintext = JSON.stringify({ v: body?.value ?? null, ts: Date.now() });

          const enc = await encrypt(env, plaintext);
          await env.VAULT_KV.put(`vault:${key}`, enc, { metadata: { owner: auth.subject } });

          ctx.waitUntil(audit(env, auth, "vault_put", { key }));
          return corsJson(request, env, 200, { ok: true, key });
        }

        if (request.method === "GET") {
          const enc = await env.VAULT_KV.get(`vault:${key}`);
          if (!enc) return corsJson(request, env, 404, { ok: false, error: "not_found" });

          const dec = await decrypt(env, enc);
          const parsed = safeParseJson(dec) || {};
          ctx.waitUntil(audit(env, auth, "vault_get", { key }));
          return corsJson(request, env, 200, { ok: true, key, value: parsed.v ?? null });
        }

        if (request.method === "DELETE") {
          await env.VAULT_KV.delete(`vault:${key}`);
          ctx.waitUntil(audit(env, auth, "vault_del", { key }));
          return corsJson(request, env, 200, { ok: true, key });
        }

        return corsJson(request, env, 405, { ok: false, error: "method_not_allowed" });
      }

      // Default
      return corsJson(request, env, 404, { ok: false, error: "not_found" });
    } catch (e) {
      return corsJson(request, env, 500, { ok: false, error: "internal_error", detail: String(e?.message || e) });
    }
  },
};

// ------------------------- Durable Object -------------------------

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // init
    if (path === "/meet/init" && request.method === "POST") {
      const body = await safeJson(request);
      const meeting_id = (body?.meeting_id || "").toString();
      if (!meeting_id) return json(400, { ok: false, error: "missing_meeting_id" });

      const existing = await this.state.storage.get("meta");
      if (!existing) {
        await this.state.storage.put("meta", {
          meeting_id,
          title: body?.title || "",
          owner: body?.owner || "",
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        await this.state.storage.put("messages", []);
      }
      const meta = await this.state.storage.get("meta");
      return json(200, { ok: true, meta });
    }

    // GET /
    if (path === "/" && request.method === "GET") {
      const meta = (await this.state.storage.get("meta")) || null;
      const messages = (await this.state.storage.get("messages")) || [];
      return json(200, { ok: true, meta, messages });
    }

    // POST /msg  body: {role, text, at?}
    if (path === "/msg" && request.method === "POST") {
      const body = await safeJson(request);
      const role = (body?.role || "user").toString();
      const text = (body?.text || "").toString();
      if (!text) return json(400, { ok: false, error: "missing_text" });

      const messages = (await this.state.storage.get("messages")) || [];
      messages.push({ role, text, at: body?.at || Date.now() });

      await this.state.storage.put("messages", messages);
      const meta = (await this.state.storage.get("meta")) || {};
      meta.updated_at = Date.now();
      await this.state.storage.put("meta", meta);

      return json(200, { ok: true, count: messages.length });
    }

    // POST /clear
    if (path === "/clear" && request.method === "POST") {
      await this.state.storage.put("messages", []);
      const meta = (await this.state.storage.get("meta")) || {};
      meta.updated_at = Date.now();
      await this.state.storage.put("meta", meta);
      return json(200, { ok: true });
    }

    return json(404, { ok: false, error: "do_not_found" });
  }
}

// ------------------------- Auth / Security -------------------------

async function requireAuth(request, env) {
  const authz = request.headers.get("authorization") || "";
  const token = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";

  // Owner token
  if (token && env.CONSIA_OWNER_TOKEN && timingSafeEqual(token, env.CONSIA_OWNER_TOKEN)) {
    return { ok: true, subject: "owner", tier: "owner" };
  }

  // Device token (simple)
  if (token && env.DEVICE_TOKEN && timingSafeEqual(token, env.DEVICE_TOKEN)) {
    // optional HMAC proof (si viene)
    const h = await verifyHmacIfPresent(request, env);
    if (!h.ok) return { ok: false, status: 401, error: "invalid_hmac" };
    return { ok: true, subject: "device", tier: "device" };
  }

  // HMAC-only auth (sin bearer): permite clients ultra-minimal si querés
  const hmacOnly = await verifyHmacIfPresent(request, env);
  if (hmacOnly.ok) return { ok: true, subject: "hmac", tier: "device" };

  return { ok: false, status: 401, error: "unauthorized" };
}

async function verifyHmacIfPresent(request, env) {
  // Headers esperados:
  // x-consia-ts (unix ms), x-consia-nonce, x-consia-sig (base64url)
  const ts = request.headers.get("x-consia-ts");
  const nonce = request.headers.get("x-consia-nonce");
  const sig = request.headers.get("x-consia-sig");
  if (!ts || !nonce || !sig) return { ok: false, skip: true };

  if (!env.HMAC_SECRET) return { ok: false };

  const now = Date.now();
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false };
  if (Math.abs(now - t) > 2 * 60 * 1000) return { ok: false }; // 2 min window

  // Anti-replay best-effort
  if (env.SESSIONS_KV) {
    const k = `nonce:${nonce}`;
    const seen = await env.SESSIONS_KV.get(k);
    if (seen) return { ok: false };
    await env.SESSIONS_KV.put(k, "1", { expirationTtl: 60 * 5 });
  }

  // message = method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + sha256(body)
  const url = new URL(request.url);
  const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
  const bodyHash = await sha256Hex(bodyText);

  const msg = [
    request.method.toUpperCase(),
    url.pathname,
    ts,
    nonce,
    bodyHash,
  ].join("\n");

  const expected = await hmacBase64Url(env.HMAC_SECRET, msg);
  if (!timingSafeEqual(sig, expected)) return { ok: false };
  return { ok: true };
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

// ------------------------- Rate limit / Budget cap -------------------------

async function rateLimit(request, env, auth) {
  // Simple sliding window por IP+subject
  if (!env.GLOBAL_STATE) return { ok: true }; // si no existe KV, no bloquea
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const key = `rl:${auth.subject}:${ip}:${new Date().toISOString().slice(0, 16)}`; // minute bucket
  const nStr = await env.GLOBAL_STATE.get(key);
  const n = (nStr ? parseInt(nStr, 10) : 0) + 1;
  await env.GLOBAL_STATE.put(key, String(n), { expirationTtl: 120 });

  // límites
  const limit = auth.tier === "owner" ? 600 : 120; // por minuto
  return n > limit ? { ok: false } : { ok: true };
}

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function enforceGlobalBudget(env) {
  const cap = Number(env.MAX_DAILY_BUDGET_USD || "0");
  if (!cap || cap <= 0) return { ok: true };
  if (!env.GLOBAL_STATE) return { ok: true };

  const key = `budget:${todayKey()}`;
  const spentStr = await env.GLOBAL_STATE.get(key);
  const spent = spentStr ? Number(spentStr) : 0;
  if (spent >= cap) return { ok: false };
  return { ok: true };
}

async function addGlobalSpend(env, usd) {
  const cap = Number(env.MAX_DAILY_BUDGET_USD || "0");
  if (!cap || cap <= 0) return;
  if (!env.GLOBAL_STATE) return;

  const key = `budget:${todayKey()}`;
  const spentStr = await env.GLOBAL_STATE.get(key);
  const spent = spentStr ? Number(spentStr) : 0;
  const next = spent + (Number.isFinite(usd) ? usd : 0);
  await env.GLOBAL_STATE.put(key, String(next), { expirationTtl: 60 * 60 * 48 });
}

function estimateSpendUsd(result) {
  // Conservador, evita cortar por error
  if (!result?.ok) return 0;
  const tokens = Number(result?.usage?.total_tokens || 0);
  // ~0.000002 por token como placeholder conservador (ajustás después)
  return tokens * 0.000002;
}

// ------------------------- OpenAI -------------------------

async function openaiAsk(env, { message, meta, user, ip }) {
  if (!env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY_missing" };

  const model = env.OPENAI_MODEL || "gpt-4.1-mini"; // si tenés otro, lo seteás en secret/var
  const system = meta?.system || "You are CONSIA. Be concise, execution-first, security-first.";

  const payload = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: message },
    ],
    // metadata útil
    metadata: {
      consia_user: user || "unknown",
      ip: ip || "unknown",
      env: env.ENVIRONMENT || "prod",
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: "openai_error", status: res.status, detail: data };
  }

  const text = extractResponseText(data);
  return {
    ok: true,
    model,
    output_text: text,
    raw: data,
    usage: data?.usage || null,
  };
}

function extractResponseText(data) {
  // Responses API: output_text suele estar en data.output[...].content[...].text
  try {
    if (typeof data?.output_text === "string") return data.output_text;
    const out = data?.output || [];
    for (const item of out) {
      const content = item?.content || [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
      }
    }
  } catch {}
  return "";
}

// ------------------------- Audit (hash chain) -------------------------

async function audit(env, auth, action, details) {
  if (!env.AUDIT_KV) return;

  const ts = Date.now();
  const id = cryptoRandomId("audit");
  const prev = (await env.AUDIT_KV.get("audit:head")) || "";

  const entry = {
    id,
    ts,
    action,
    subject: auth?.subject || "unknown",
    details: details || {},
    prev,
  };

  const hash = await sha256Hex(JSON.stringify(entry));
  await env.AUDIT_KV.put(`audit:${id}`, JSON.stringify({ ...entry, hash }));
  await env.AUDIT_KV.put("audit:head", hash);
}

// ------------------------- Crypto helpers -------------------------

async function sha256Hex(s) {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToU8(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// AES-GCM envelope: base64url(iv).base64url(cipher)
async function encrypt(env, plaintext) {
  if (!env.ENC_KEY_B64) throw new Error("ENC_KEY_B64_missing");
  const keyBytes = base64UrlDecodeToU8(env.ENC_KEY_B64);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

async function decrypt(env, envelope) {
  if (!env.ENC_KEY_B64) throw new Error("ENC_KEY_B64_missing");
  const [ivB64, ctB64] = (envelope || "").split(".");
  if (!ivB64 || !ctB64) throw new Error("bad_envelope");

  const keyBytes = base64UrlDecodeToU8(env.ENC_KEY_B64);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

  const iv = base64UrlDecodeToU8(ivB64);
  const ct = base64UrlDecodeToU8(ctB64);

  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plainBuf);
}

// ------------------------- HTTP helpers -------------------------

function jsonHeaders(extra = {}) {
  return { "content-type": "application/json; charset=utf-8", ...extra };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: jsonHeaders() });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  // whitelist simple: permite consia.world + subdominios; si no hay origin (curl), permite *
  const allowOrigin =
    !origin
      ? "*"
      : origin.endsWith(".consia.world") || origin === "https://consia.world"
      ? origin
      : origin; // si querés “cerrado total”, reemplazá por "https://consia.world"

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      request.headers.get("access-control-request-headers") ||
      "content-type, authorization, x-consia-device, x-consia-session, x-consia-ts, x-consia-nonce, x-consia-sig, x-idempotency-key",
    "access-control-allow-credentials": "true",
    "vary": "Origin",
  };
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function corsJson(request, env, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...jsonHeaders(), ...corsHeaders(request, env) },
  });
}

function corsText(request, env, status, text, contentType = "text/plain; charset=utf-8") {
  return new Response(text, {
    status,
    headers: { "content-type": contentType, ...corsHeaders(request, env) },
  });
}

async function safeJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const txt = await request.text().catch(() => "");
    return safeParseJson(txt) || {};
  }
  return await request.json().catch(() => ({}));
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function cryptoRandomId(prefix) {
  const u8 = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
