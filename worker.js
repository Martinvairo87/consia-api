/**
 * CONSIA API Worker — Top 1 Pack
 * - CORS hardened
 * - Durable Objects bindings compatible
 * - KV namespaces compatible
 * - Adds: /voice.html static UI route
 *
 * NOTE: Keep secrets in Cloudflare "Secrets" (never in code):
 * - OPENAI_API_KEY
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-consia-device, x-consia-session",
  "access-control-allow-credentials": "true",
};

const VOICE_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>CONSIA VOICE — Realtime</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0b0f; color:#fff; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 18px; }
    .card { background: #12121a; border:1px solid #242436; border-radius: 14px; padding: 14px; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; align-items:center; }
    button { background:#2a2aff; border:none; color:#fff; padding:10px 14px; border-radius: 10px; font-weight: 700; cursor:pointer; }
    button.secondary { background:#23233a; }
    input, select, textarea { background:#0f0f18; border:1px solid #242436; color:#fff; padding:10px 12px; border-radius: 10px; width: 100%; }
    textarea { min-height: 120px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
    .pill { display:inline-flex; padding:6px 10px; border:1px solid #242436; border-radius: 999px; background:#0f0f18; gap:8px; align-items:center; }
    .ok { color:#4ef3a4; }
    .bad { color:#ff6b6b; }
    .tiny { opacity: .85; font-size: 12px; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 10px; }
    @media (min-width: 860px) { .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row" style="justify-content:space-between; margin-bottom: 12px;">
      <div class="pill"><b>CONSIA VOICE</b> <span class="tiny">Realtime • Mic • Avatar Sync</span></div>
      <div class="pill"><span id="statusDot" class="bad">●</span> <span id="statusText">Disconnected</span></div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="row">
          <button id="btnToken">1) Get Token</button>
          <button id="btnConnect" class="secondary">2) Connect WS</button>
          <button id="btnStart" class="secondary">3) Start Mic</button>
          <button id="btnStop" class="secondary">Stop</button>
        </div>

        <div style="margin-top:10px;">
          <div class="tiny">Model</div>
          <input id="model" value="gpt-4o-realtime-preview" />
        </div>

        <div style="margin-top:10px;">
          <div class="tiny">Console</div>
          <div id="log" class="mono" style="margin-top:8px; background:#0f0f18; border:1px solid #242436; border-radius:12px; padding:10px; height: 240px; overflow:auto;"></div>
        </div>
      </div>

      <div class="card">
        <div class="tiny">Text Test</div>
        <textarea id="txt" placeholder="Escribí algo para testear que el realtime está vivo..."></textarea>
        <div class="row" style="margin-top:10px;">
          <button id="btnSend">Send Text Event</button>
          <button id="btnPing" class="secondary">Ping CONSIA</button>
        </div>
        <div class="tiny" style="margin-top:10px;">
          Tip: si el mic no funciona, primero permití micrófono en Safari y recargá.
        </div>
      </div>
    </div>
  </div>

<script>
  const API_BASE = location.origin; // https://api.consia.world
  const logEl = document.getElementById('log');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  let clientSecret = null;
  let ws = null;
  let stream = null;
  let recorder = null;

  function log(...a){
    const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ');
    logEl.textContent += s + "\\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(ok, text){
    statusDot.className = ok ? 'ok' : 'bad';
    statusText.textContent = text;
  }

  async function getToken(){
    const model = document.getElementById('model').value.trim();
    const res = await fetch(API_BASE + "/voice/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model })
    });
    const data = await res.json();
    if(!res.ok){ throw new Error(data?.error || "token_error"); }
    clientSecret = data.client_secret?.value || data.client_secret || data.value || null;
    log("TOKEN OK:", data);
    return clientSecret;
  }

  function openWS(){
    if(!clientSecret) throw new Error("no_token");

    const model = document.getElementById('model').value.trim();
    const url = "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(model);

    ws = new WebSocket(url, [
      // OpenAI Realtime uses subprotocol auth per docs:
      // "openai-insecure-api-key.<EPHEMERAL_KEY>"
      "realtime",
      "openai-insecure-api-key." + clientSecret
    ]);

    ws.onopen = () => {
      setStatus(true, "Connected");
      log("WS OPEN:", url);

      // minimal session update
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: "You are CONSIA VOICE. Be concise, helpful, and safe.",
          modalities: ["text","audio"],
        }
      }));
    };

    ws.onmessage = (ev) => {
      try { log("WS MSG:", JSON.parse(ev.data)); }
      catch { log("WS MSG:", ev.data); }
    };

    ws.onerror = (e) => { log("WS ERROR", e); };
    ws.onclose = () => { setStatus(false, "Disconnected"); log("WS CLOSED"); ws = null; };
  }

  async function startMic(){
    if(!ws) throw new Error("ws_not_connected");

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

    recorder.ondataavailable = async (ev) => {
      if(!ws || ws.readyState !== 1) return;
      if(!ev.data || ev.data.size === 0) return;

      // Send as base64 chunk event (placeholder). Real-time audio format requirements vary.
      const buf = await ev.data.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));

      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64
      }));
    };

    recorder.start(250);
    log("MIC STARTED (MediaRecorder opus/webm chunks)");
  }

  function stopAll(){
    try { recorder && recorder.state !== "inactive" && recorder.stop(); } catch {}
    recorder = null;
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
    try { ws && ws.close(); } catch {}
    ws = null;
    setStatus(false, "Disconnected");
    log("STOPPED");
  }

  document.getElementById('btnToken').onclick = async () => {
    try { await getToken(); }
    catch(e){ log("TOKEN FAIL:", String(e)); }
  };

  document.getElementById('btnConnect').onclick = () => {
    try { openWS(); }
    catch(e){ log("CONNECT FAIL:", String(e)); }
  };

  document.getElementById('btnStart').onclick = async () => {
    try { await startMic(); }
    catch(e){ log("MIC FAIL:", String(e)); }
  };

  document.getElementById('btnStop').onclick = stopAll;

  document.getElementById('btnSend').onclick = () => {
    try {
      if(!ws) throw new Error("ws_not_connected");
      const text = document.getElementById('txt').value.trim();
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type:"input_text", text }] } }));
      ws.send(JSON.stringify({ type: "response.create" }));
      log("SENT TEXT:", text);
    } catch(e){ log("SEND FAIL:", String(e)); }
  };

  document.getElementById('btnPing').onclick = async () => {
    const res = await fetch(API_BASE + "/ping");
    const t = await res.text();
    log("PING:", t);
  };

  setStatus(false, "Disconnected");
  log("Ready. Step 1: Get Token. Step 2: Connect. Step 3: Start Mic.");
</script>
</body>
</html>`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...CORS, ...extraHeaders },
  });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extraHeaders },
  });
}

async function withCorsPreflight(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS } });
  }
  return null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * OpenAI Realtime: Create ephemeral client secret.
 * Source: OpenAI docs (realtime client_secrets).
 */
async function openaiCreateRealtimeClientSecret(env, model) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("missing_OPENAI_API_KEY");
  }

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      // Keep flexible: some accounts accept model here; otherwise default server-side
      model: model || "gpt-4o-realtime-preview",
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || "openai_error";
    throw new Error(msg);
  }
  return data; // includes client_secret
}

export default {
  async fetch(request, env, ctx) {
    const pre = await withCorsPreflight(request);
    if (pre) return pre;

    const url = new URL(request.url);
    const path = url.pathname;

    // Static UI
    if (request.method === 'GET' && (path === '/voice.html' || path === '/voice')) {
      return new Response(VOICE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
    }

    // Health / root
    if (path === "/" && request.method === "GET") {
      return text("CONSIA CORE ACTIVE");
    }

    // Basic ping
    if (path === "/ping") {
      return json({ ok: true, service: "consia-api", ts: Date.now() });
    }

    // Voice token (ephemeral)
    if (path === "/voice/token" && request.method === "POST") {
      const body = await readJson(request);
      const model = body?.model || "gpt-4o-realtime-preview";
      try {
        const data = await openaiCreateRealtimeClientSecret(env, model);
        return json({ ok: true, ...data });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Voice session (alias)
    if (path === "/voice/session" && request.method === "POST") {
      const body = await readJson(request);
      const model = body?.model || "gpt-4o-realtime-preview";
      try {
        const data = await openaiCreateRealtimeClientSecret(env, model);
        return json({
          ok: true,
          model,
          client_secret: data.client_secret,
          ws_url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Minimal Marketplace (foundation)
    if (path === "/market/products" && request.method === "GET") {
      // Placeholder catalog (best-seller style) — later we move to MARKET_KV
      const products = [
        { id: "consia-airbuds", brand: "CONSIA", name: "AirBuds Pro Max", category: "Audio", price_usd: 79.99, image: "/market/img/consia-airbuds.png" },
        { id: "consia-smartplug", brand: "CONSIA", name: "SmartPlug Ultra", category: "Smart Home", price_usd: 19.99, image: "/market/img/consia-smartplug.png" },
        { id: "consia-cam", brand: "CONSIA", name: "SecureCam 4K", category: "Security", price_usd: 59.99, image: "/market/img/consia-cam.png" },
        { id: "consia-bottle", brand: "CONSIA", name: "HydraBottle Steel", category: "Lifestyle", price_usd: 24.99, image: "/market/img/consia-bottle.png" },
      ];
      return json({ ok: true, products });
    }

    if (path.startsWith("/market/products/") && request.method === "GET") {
      const id = path.split("/").pop();
      return json({
        ok: true,
        product: {
          id,
          brand: "CONSIA",
          name: "Prototype Product",
          status: "prototype",
          notes: "Next: move catalog to MARKET_KV + suppliers directory + checkout rails.",
        },
      });
    }

    return json({ ok: false, error: "Route not found", path }, 404);
  },
};
