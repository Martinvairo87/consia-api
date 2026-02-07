export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

      if (path === "/" || path === "/health") return cors(env, json({ ok: true, service: "consia-api", ts: Date.now() }));

      // CORE
      if (path === "/ask" && request.method === "POST") return cors(env, await handleAsk(request, env));

      // VAULT
      if (path === "/vault/put" && request.method === "POST") return cors(env, await vaultPut(request, env));
      if (path === "/vault/get" && request.method === "POST") return cors(env, await vaultGet(request, env));

      // MEETING
      if (path === "/meeting/start" && request.method === "POST") return cors(env, await meetingStart(request, env));
      if (path === "/meeting/add" && request.method === "POST") return cors(env, await meetingAdd(request, env));
      if (path === "/meeting/close" && request.method === "POST") return cors(env, await meetingClose(request, env));

      // INBOX AUTOPILOT
      if (path === "/inbox/connect_url" && request.method === "POST") return cors(env, await inboxConnectUrl(request, env));
      if (path === "/inbox/callback" && request.method === "GET") return cors(env, await inboxCallback(request, env));
      if (path === "/inbox/sync" && request.method === "POST") return cors(env, await inboxSync(request, env));
      if (path === "/inbox/summarize" && request.method === "POST") return cors(env, await inboxSummarize(request, env));
      if (path === "/inbox/solve" && request.method === "POST") return cors(env, await inboxSolve(request, env));
      if (path === "/inbox/send" && request.method === "POST") return cors(env, await inboxSend(request, env));

      return cors(env, json({ ok: false, error: "not_found", path }, 404));
    } catch (e) {
      return cors(env, json({ ok: false, error: "server_error", message: String(e?.message || e) }, 500));
    }
  }
};

// ========= Helpers =========
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOW_ORIGIN || "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type, authorization, x-consia-sig, x-consia-ts");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("content_type_must_be_json");
  return await request.json();
}
function normLang(l) {
  const raw = (l || "en").toLowerCase();
  const base = raw.split("-")[0];
  const ok = new Set(["ar","de","en","es","fr","hi","id","it","ja","ko","nl","pl","pt","ru","tr","uk","vi","zh"]);
  return ok.has(raw) ? raw : (ok.has(base) ? base : "en");
}
async function sha1(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// ========= HMAC (Owner-only endpoints) =========
async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2,"0")).join("");
}
async function requireSig(request, env, bodyString) {
  if (!env.HMAC_SECRET) return; // dev allow
  const ts = request.headers.get("x-consia-ts") || "";
  const sig = request.headers.get("x-consia-sig") || "";
  if (!ts || !sig) throw new Error("missing_signature_headers");
  const now = Date.now();
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > 10 * 60 * 1000) throw new Error("signature_expired");
  const expected = await hmacHex(env.HMAC_SECRET, `${ts}.${bodyString}`);
  if (expected !== sig) throw new Error("bad_signature");
}

// ========= OpenAI =========
async function openaiChat(env, { messages, temperature = 0.25, model }) {
  if (!env.OPENAI_API_KEY) throw new Error("missing_OPENAI_API_KEY");
  const payload = { model: model || env.DEFAULT_MODEL || "gpt-4.1-mini", messages, temperature };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error("openai_error_" + r.status);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}
async function openaiTranslate(env, { text, from, to }) {
  if (!text || from === to) return text;
  return await openaiChat(env, {
    temperature: 0.1,
    messages: [
      { role: "system", content: "You are a precise translation engine. Preserve meaning, names, formatting, and tone. Do not add extra text." },
      { role: "user", content: `Translate from ${from} to ${to}:\n\n${text}` }
    ]
  });
}
async function translateCached(env, text, from, to) {
  from = normLang(from); to = normLang(to);
  if (!text || from === to) return text;
  const key = "t:" + (await sha1(`${from}|${to}|${text}`));
  const hit = await env.CONSIA_KV.get(key);
  if (hit) return hit;
  const out = await openaiTranslate(env, { text, from, to });
  await env.CONSIA_KV.put(key, out, { expirationTtl: 60 * 60 * 24 * 30 });
  return out;
}

// ========= /ask =========
async function handleAsk(request, env) {
  const body = await readJson(request);
  const userLang = normLang(body.lang || "en");
  const userMsg = String(body.message || "").slice(0, 12000);
  const channel = String(body.channel || "web");
  const msgEn = await translateCached(env, userMsg, userLang, "en");

  const system = [
    "You are CONSIA. World-class premium assistant + product OS guide.",
    "Output: minimal steps, no fluff. Always propose best-in-world option.",
    "Privacy-first. Never request secrets. If integration needed, say exactly which secret/binding is missing.",
    "For monetization: optimize conversion, reduce friction, maximize revenue ethically.",
    "If risk: draft only, ask for Owner approval."
  ].join("\n");

  const replyEn = await openaiChat(env, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `CHANNEL: ${channel}\n\n${msgEn}` }
    ]
  });

  const replyUser = await translateCached(env, replyEn, "en", userLang);
  return json({ ok: true, reply: replyUser, lang: userLang });
}

// ========= Vault =========
async function vaultPut(request, env) {
  const bodyStr = await request.text();
  await requireSig(request, env, bodyStr);
  const body = JSON.parse(bodyStr || "{}");
  const k = String(body.key || "").trim();
  const v = String(body.value || "");
  if (!k) throw new Error("missing_key");
  await env.CONSIA_KV.put("vault:" + k, v, { expirationTtl: 60 * 60 * 24 * 365 * 5 });
  return json({ ok: true });
}
async function vaultGet(request, env) {
  const bodyStr = await request.text();
  await requireSig(request, env, bodyStr);
  const body = JSON.parse(bodyStr || "{}");
  const k = String(body.key || "").trim();
  if (!k) throw new Error("missing_key");
  const v = await env.CONSIA_KV.get("vault:" + k);
  return json({ ok: true, value: v || null });
}

// ========= Durable Object: Meeting (simple) =========
export class MeetingDO {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/meeting/start") {
      const body = await request.json();
      await this.state.storage.put("title", body.title || "Meeting");
      await this.state.storage.put("created", body.ts || Date.now());
      await this.state.storage.put("items", []);
      return json({ ok: true });
    }
    if (path === "/meeting/add") {
      const body = await request.json();
      const items = (await this.state.storage.get("items")) || [];
      items.push({ ts: body.ts || Date.now(), text: body.text || "" });
      await this.state.storage.put("items", items);
      return json({ ok: true, count: items.length });
    }
    if (path === "/meeting/close") {
      const title = (await this.state.storage.get("title")) || "Meeting";
      const created = (await this.state.storage.get("created")) || Date.now();
      const items = (await this.state.storage.get("items")) || [];
      const md = [
        `# ${title}`,
        `Created: ${new Date(created).toISOString()}`,
        ``,
        `## Notes`,
        ...items.map(i => `- ${new Date(i.ts).toISOString()} — ${String(i.text).replace(/\n/g, " ")}`)
      ].join("\n");
      const key = "meeting:" + (await sha1(title + created));
      await this.env.CONSIA_KV.put(key, md, { expirationTtl: 60 * 60 * 24 * 365 });
      return json({ ok: true, markdown: md, stored_key: key });
    }
    return json({ ok: false, error: "not_found" }, 404);
  }
}
async function meetingStart(request, env) {
  const bodyStr = await request.text();
  await requireSig(request, env, bodyStr);
  const body = JSON.parse(bodyStr || "{}");
  const id = crypto.randomUUID();
  const stub = env.MEETING_DO.get(env.MEETING_DO.idFromName("m:" + id));
  const r = await stub.fetch("https://do/meeting/start", { method: "POST", body: JSON.stringify({ title: body.title || "Meeting", ts: Date.now() }) });
  const j = await r.json();
  return json({ ok: true, meeting_id: id, ...j });
}
async function meetingAdd(request, env) {
  const bodyStr = await request.text();
  await requireSig(request, env, bodyStr);
  const body = JSON.parse(bodyStr || "{}");
  const meetingId = String(body.meeting_id || "");
  if (!meetingId) throw new Error("missing_meeting_id");
  const stub = env.MEETING_DO.get(env.MEETING_DO.idFromName("m:" + meetingId));
  const r = await stub.fetch("https://do/meeting/add", { method: "POST", body: JSON.stringify({ text: body.text || "", ts: Date.now() }) });
  return json(await r.json());
}
async function meetingClose(request, env) {
  const bodyStr = await request.text();
  await requireSig(request, env, bodyStr);
  const body = JSON.parse(bodyStr || "{}");
  const meetingId = String(body.meeting_id || "");
  if (!meetingId) throw new Error("missing_meeting_id");
  const stub = env.MEETING_DO.get(env.MEETING_DO.idFromName("m:" + meetingId));
  const r = await stub.fetch("https://do/meeting/close", { method: "POST" });
  return json(await r.json());
}

// ===============================
// INBOX AUTOPILOT — Gmail OAuth + AI triage + drafts + optional send
// ===============================

// Owner mailbox key (single owner mode)
const OWNER_MAILBOX_KEY = "inbox:owner";

// 1) Get connect URL
async function inboxConnectUrl(request, env) {
  // Requires Google OAuth secrets present
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
    return json({ ok:false, error:"missing_google_oauth_secrets" }, 400);
  }
  const state = crypto.randomUUID();
  await env.CONSIA_KV.put("oauth_state:" + state, "1", { expirationTtl: 600 });

  const scope = encodeURIComponent([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "openid","email"
  ].join(" "));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  return json({ ok:true, url: url.toString() });
}

// 2) OAuth callback
async function inboxCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  if (!code) return new Response("Missing code", { status: 400 });

  const ok = await env.CONSIA_KV.get("oauth_state:" + state);
  if (!ok) return new Response("Invalid state", { status: 400 });

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    return new Response("OAuth not configured", { status: 400 });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });

  if (!tokenRes.ok) return new Response("Token exchange failed", { status: 400 });

  const token = await tokenRes.json();
  // Store tokens in KV (owner mailbox)
  await env.CONSIA_KV.put(OWNER_MAILBOX_KEY, JSON.stringify({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
    obtained: Date.now()
  }), { expirationTtl: 60 * 60 * 24 * 365 * 2 });

  return new Response(
    `Connected. You can close this window and return to CONSIA Inbox.`,
    { status: 200, headers: { "content-type":"text/plain; charset=utf-8" } }
  );
}

async function gmailFetch(env, token, path, init = {}) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "Authorization": "Bearer " + token,
      "Accept": "application/json"
    }
  });
  return r;
}

async function getToken(env) {
  const raw = await env.CONSIA_KV.get(OWNER_MAILBOX_KEY);
  if (!raw) throw new Error("gmail_not_connected");
  const t = JSON.parse(raw);

  // refresh if needed (simple)
  const age = (Date.now() - (t.obtained || 0)) / 1000;
  if (age < (t.expires_in || 3500) - 120) return t.access_token;

  if (!t.refresh_token || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("missing_refresh_token");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token"
    })
  });
  if (!tokenRes.ok) throw new Error("refresh_failed");
  const nt = await tokenRes.json();

  const merged = {
    ...t,
    access_token: nt.access_token,
    expires_in: nt.expires_in,
    obtained: Date.now()
  };
  await env.CONSIA_KV.put(OWNER_MAILBOX_KEY, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 365 * 2 });
  return merged.access_token;
}

// 3) Sync (list newest)
async function inboxSync(request, env) {
  const body = await readJson(request);
  const lang = normLang(body.lang || "en");
  const token = await getToken(env);

  const listRes = await gmailFetch(env, token, "messages?q=is:inbox newer_than:7d&maxResults=12");
  if (!listRes.ok) throw new Error("gmail_list_failed");
  const list = await listRes.json();
  const ids = (list.messages || []).map(m => m.id);

  const items = [];
  for (const id of ids) {
    const msgRes = await gmailFetch(env, token, `messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    if (!msgRes.ok) continue;
    const m = await msgRes.json();
    const headers = Object.fromEntries((m.payload?.headers || []).map(h => [h.name, h.value]));
    items.push({
      id,
      subject: headers.Subject || "",
      from: headers.From || "",
      date: headers.Date || "",
      snippet: m.snippet || ""
    });
  }

  return json({ ok:true, kpi:{ new: items.length, needs_action: 0, auto_solved: 0 }, items, lang });
}

// 4) Summarize inbox
async function inboxSummarize(request, env) {
  const body = await readJson(request);
  const lang = normLang(body.lang || "en");
  const token = await getToken(env);

  const snap = await inboxSync({ json: async()=>({lang}) , headers: new Headers([["content-type","application/json"]]) }, env).then(r=>r.json());
  const items = snap.items || [];

  const promptEn = `Summarize these inbox items into 5 bullets: priorities + what needs action.\n\n` +
    items.map((x,i)=>`#${i+1}\nFrom: ${x.from}\nSubject: ${x.subject}\nSnippet: ${x.snippet}\n`).join("\n");

  const summaryEn = await openaiChat(env, {
    messages: [
      { role:"system", content:"You are an elite executive email triage assistant. Output short bullets." },
      { role:"user", content: promptEn }
    ],
    temperature: 0.2
  });

  const summaryUser = await translateCached(env, summaryEn, "en", lang);
  return json({ ok:true, items:[{ subject:"CONSIA Summary", from:"CONSIA", date:new Date().toUTCString(), snippet: summaryUser }], lang });
}

// 5) Solve + Draft
async function inboxSolve(request, env) {
  const body = await readJson(request);
  const lang = normLang(body.lang || "en");
  const autopilot = !!body.autopilot;
  const rules = String(body.rules || "").slice(0, 8000);

  const snap = await inboxSync({ json: async()=>({lang}) , headers: new Headers([["content-type","application/json"]]) }, env).then(r=>r.json());
  const items = snap.items || [];

  const promptEn = `
You are CONSIA Inbox Autopilot.
Follow RULES strictly.
Return JSON array "drafts": [{id, to, subject, reply, action}] where action is "send" or "draft".
Only action="send" if autopilot is enabled AND safe to auto-reply.

AUTOPILOT_ENABLED=${autopilot ? "true":"false"}

RULES:
${rules}

EMAILS:
${items.map(x=>`ID:${x.id}\nFROM:${x.from}\nSUBJECT:${x.subject}\nSNIPPET:${x.snippet}\n`).join("\n---\n")}
`;

  const outEn = await openaiChat(env, {
    messages: [
      { role:"system", content:"Return strictly valid JSON only. No markdown." },
      { role:"user", content: promptEn }
    ],
    temperature: 0.15
  });

  let parsed;
  try { parsed = JSON.parse(outEn); } catch { parsed = { drafts: [] }; }

  const drafts = [];
  for (const d of (parsed.drafts || [])) {
    const replyUser = await translateCached(env, String(d.reply||""), "en", lang);
    drafts.push({
      id: String(d.id||""),
      to: String(d.to||""),
      subject: String(d.subject||""),
      reply: replyUser,
      action: String(d.action||"draft")
    });
  }

  // store drafts in KV
  await env.CONSIA_KV.put("inbox:drafts", JSON.stringify({ ts: Date.now(), drafts }), { expirationTtl: 60 * 60 * 24 });

  const kpi = {
    new: items.length,
    needs_action: drafts.filter(x=>x.action!=="send").length,
    auto_solved: drafts.filter(x=>x.action==="send").length
  };

  return json({ ok:true, drafts, kpi, lang });
}

// 6) Send (only those marked send)
async function inboxSend(request, env) {
  const body = await readJson(request);
  const lang = normLang(body.lang || "en");
  const token = await getToken(env);

  const raw = await env.CONSIA_KV.get("inbox:drafts");
  if (!raw) return json({ ok:true, sent: [], lang });

  const { drafts } = JSON.parse(raw);
  const toSend = (drafts || []).filter(d => d.action === "send");

  const sent = [];
  for (const d of toSend) {
    // NOTE: Real send requires RFC822 encoding. We use simple minimal text email.
    const rfc822 =
`To: ${d.to}
Subject: ${d.subject}
Content-Type: text/plain; charset="UTF-8"

${d.reply}
`;
    const rawB64 = btoa(unescape(encodeURIComponent(rfc822)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");

    const sendRes = await gmailFetch(env, token, "messages/send", {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ raw: rawB64 })
    });
    if (sendRes.ok) sent.push(d);
  }

  return json({ ok:true, sent, lang });
}
