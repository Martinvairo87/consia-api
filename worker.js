export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // HEALTH
    if (url.pathname === "/") {
      return new Response("CONSIA CORE ACTIVE", { status: 200 });
    }

    // VOICE SESSION TOKEN
    if (url.pathname === "/voice/session") {
      try {
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4o-realtime-preview",
            voice: "alloy"
          })
        });

        const data = await response.json();

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    return new Response("Route not found", { status: 404 });
  }
};
