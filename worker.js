/**
 * CONSIA API Worker (single-file)
 * - Serves / (health), /voice.html (mic UI)
 * - POST /ask  { message } -> model response
 * - POST /voice (multipart form-data: file=<audio>) -> transcribe -> /ask -> JSON
 *
 * REQUIRED SECRETS (Cloudflare Workers > Settings > Variables):
 * - OPENAI_API_KEY   (secret)
 *
 * OPTIONAL VARS:
 * - CHAT_MODEL                 (default: "gpt-4o-mini")
 * - TRANSCRIBE_MODEL           (default: "gpt-4o-mini-transcribe")
 * - CONSIA_SYSTEM_PROMPT       (default: CONSIA-safe system)
 * - CORS_ALLOW_ORIGIN          (default: "*")
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // --- CORS preflight ---
    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env);
    }

    // --- ROUTES ---
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return withCors(
        new Response("CONSIA CORE ACTIVE", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        env
      );
    }

    if (method === "GET" && url.pathname === "/voice.html") {
      return withCors(
        new Response(VOICE_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }),
        env
      );
    }

    if (method === "POST" && url.pathname === "/ask") {
      const body = await safeJson(request);
      const message = (body?.message ?? "").toString().trim();
      if (!message) return withCors(json({ error: "Missing 'message'" }, 400), env);

      try {
        const reply = await consiaAsk(message, env);
        return withCors(json({ ok: true, message, reply }), env);
      } catch (e) {
        return withCors(json({ ok: false, error: String(e?.message || e) }, 500), env);
      }
    }

    if (method === "POST" && url.pathname === "/voice") {
      // Expect multipart: file=<audio blob>
      const ct = request.headers.get("content-type") || "";
      if (!ct.includes("multipart/form-data")) {
        return withCors(json({ error: "Expected multipart/form-data with file=<audio>" }, 400), env);
      }

      try {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") {
          return withCors(json({ error: "Missing audio file field 'file'" }, 400), env);
        }

        const transcript = await transcribeAudio(file, env);
        const reply = await consiaAsk(transcript, env);

        return withCors(json({ ok: true, transcript, reply }), env);
      } catch (e) {
        return withCors(json({ ok: false, error: String(e?.message || e) }, 500), env);
      }
    }

    return withCors(
      new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }),
      env
    );
  },
};

// -------------------- CORE: CONSIA ASK --------------------
async function consiaAsk(userMessage, env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY (secret) in Worker variables.");

  const model = env.CHAT_MODEL || "gpt-4o-mini";
  const system =
    env.CONSIA_SYSTEM_PROMPT ||
    [
      "You are CONSIA. Be concise, execution-first, and safety-first.",
      "If a request is ambiguous, make a best-effort assumption and proceed.",
      "Do not reveal secrets. Do not request sensitive personal data.",
    ].join(" ");

  const payload = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI error (${res.status}): ${JSON.stringify(data)}`);
  }

  // Extract text in a resilient way
  const text =
    data?.output_text ||
    data?.output?.[0]?.content?.map((c) => c?.text).filter(Boolean).join("") ||
    "";

  return text || "(no text)";
}

// -------------------- AUDIO: TRANSCRIBE --------------------
async function transcribeAudio(file, env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY (secret) in Worker variables.");

  const model = env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

  // Build multipart form
  const form = new FormData();
  form.append("model", model);

  // Keep original name/type if available
  const filename = file.name || "audio.webm";
  const typedFile = file instanceof File ? file : new File([file], filename, { type: file.type || "audio/webm" });
  form.append("file", typedFile, filename);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Transcription error (${res.status}): ${JSON.stringify(data)}`);
  }

  const text = (data?.text ?? "").toString().trim();
  return text || "(empty transcript)";
}

// -------------------- UTILS --------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function withCors(response, env) {
  const origin = env.CORS_ALLOW_ORIGIN || "*";
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");
  // NOTE: do NOT set allow-credentials unless you set a specific origin (not "*")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// -------------------- STATIC: VOICE UI --------------------
const VOICE_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CONSIA Voice</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial; margin:24px; color:#111;}
    .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center;}
    button{padding:12px 14px; border:1px solid #ddd; border-radius:10px; background:#fff; font-weight:600;}
    button:disabled{opacity:.5}
    textarea{width:100%; min-height:88px; padding:12px; border-radius:10px; border:1px solid #ddd;}
    pre{white-space:pre-wrap; background:#fafafa; border:1px solid #eee; padding:12px; border-radius:10px;}
    .muted{color:#666; font-size:13px}
  </style>
</head>
<body>
  <h2>CONSIA Voice</h2>
  <p class="muted">Grabá y enviá. Endpoint: <b>/voice</b> (transcribe + respuesta).</p>

  <div class="row">
    <button id="btnStart">🎙️ Grabar</button>
    <button id="btnStop" disabled>⏹️ Stop</button>
    <button id="btnSend" disabled>🚀 Enviar</button>
  </div>

  <h3>Texto (opcional)</h3>
  <textarea id="txt" placeholder="Escribí acá o usá el micrófono..."></textarea>
  <div class="row" style="margin-top:10px">
    <button id="btnAsk">🧠 Preguntar</button>
  </div>

  <h3>Salida</h3>
  <pre id="out">Listo.</pre>

<script>
(() => {
  const out = document.getElementById("out");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnSend = document.getElementById("btnSend");
  const btnAsk = document.getElementById("btnAsk");
  const txt = document.getElementById("txt");

  let mediaRecorder = null;
  let chunks = [];
  let blob = null;

  const log = (obj) => out.textContent = (typeof obj === "string") ? obj : JSON.stringify(obj, null, 2);

  btnStart.onclick = async () => {
    try {
      blob = null;
      chunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        blob = new Blob(chunks, { type: "audio/webm" });
        btnSend.disabled = false;
        log({ ok: true, status: "recorded", bytes: blob.size });
      };
      mediaRecorder.start();
      btnStart.disabled = true;
      btnStop.disabled = false;
      btnSend.disabled = true;
      log("Grabando...");
    } catch (e) {
      log({ ok: false, error: String(e) });
    }
  };

  btnStop.onclick = () => {
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
      }
      btnStart.disabled = false;
      btnStop.disabled = true;
    } catch (e) {
      log({ ok: false, error: String(e) });
    }
  };

  btnSend.onclick = async () => {
    try {
      if (!blob) return log({ ok:false, error:"No hay audio" });
      btnSend.disabled = true;
      log("Enviando audio...");
      const fd = new FormData();
      fd.append("file", blob, "audio.webm");

      const res = await fetch("/voice", { method:"POST", body: fd });
      const data = await res.json();
      log(data);
      if (data?.transcript) txt.value = data.transcript;
    } catch (e) {
      log({ ok: false, error: String(e) });
    } finally {
      btnSend.disabled = false;
    }
  };

  btnAsk.onclick = async () => {
    try {
      const message = (txt.value || "").trim();
      if (!message) return log({ ok:false, error:"Escribí un mensaje" });
      log("Consultando...");
      const res = await fetch("/ask", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body: JSON.stringify({ message })
      });
      const data = await res.json();
      log(data);
    } catch (e) {
      log({ ok:false, error: String(e) });
    }
  };
})();
</script>
</body>
</html>`;
