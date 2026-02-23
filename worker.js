export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: cors()
      });
    }

    // HEALTH
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "CONSIA CORE ACTIVE",
        has_openai_key: !!env.OPENAI_API_KEY,
        worker: "consia-api-live"
      });
    }

    // CHAT /ask
    if (url.pathname === "/ask" && request.method === "POST") {
      const { message, user = "global" } = await request.json();

      const reply = await askLLM(message, env);

      // Memory Vault
      const id = env.CONSIA_STATE.idFromName(user);
      const stub = env.CONSIA_STATE.get(id);
      await stub.fetch("https://vault/save", {
        method: "POST",
        body: JSON.stringify({ user, message, reply })
      });

      return json({ ok: true, reply });
    }

    // VOICE → TTS
    if (url.pathname === "/voice" && request.method === "POST") {
      const { text } = await request.json();

      const audio = await tts(text, env);

      return new Response(audio, {
        headers: {
          ...cors(),
          "Content-Type": "audio/mpeg"
        }
      });
    }

    // WEBSOCKET REALTIME
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();

      server.addEventListener("message", async (event) => {
        const msg = event.data;

        const reply = await askLLM(msg, env);

        server.send(reply);
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // MEET ROOM REALTIME
    if (url.pathname.startsWith("/meet/ws/")) {
      const room = url.pathname.split("/").pop();

      const id = env.CONSIA_STATE.idFromName(room);
      const stub = env.CONSIA_STATE.get(id);

      return stub.fetch(request);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};



// =============================
// LLM
// =============================
async function askLLM(message, env) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: message }]
    })
  });

  const data = await res.json();
  return data.choices[0].message.content;
}



// =============================
// TTS
// =============================
async function tts(text, env) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text
    })
  });

  return res.arrayBuffer();
}



// =============================
// JSON + CORS
// =============================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(),
      "Content-Type": "application/json"
    }
  });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}



// =============================
// DURABLE OBJECT — VAULT + MEET
// =============================
export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request) {
    const url = new URL(request.url);

    // SAVE MEMORY
    if (url.pathname === "/save") {
      const data = await request.json();
      await this.state.storage.put(Date.now(), data);
      return new Response("saved");
    }

    // WEBSOCKET ROOM
    if (url.pathname.startsWith("/meet/ws")) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      this.sessions.push(server);

      server.addEventListener("message", (event) => {
        for (const session of this.sessions) {
          session.send(event.data);
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    return new Response("ok");
  }
}