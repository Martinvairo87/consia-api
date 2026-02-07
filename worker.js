export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    // HEALTH CHECK
    if (url.pathname === "/health") {
      return new Response("CONSIA CORE ONLINE", { status: 200 });
    }

    // MAIN ASK ENDPOINT
    if (url.pathname === "/ask") {

      const body = await request.json();
      const message = body.message || "";

      const openai = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "system",
                content: "You are CONSIA, the most advanced autonomous AI system in the world."
              },
              {
                role: "user",
                content: message
              }
            ]
          })
        }
      );

      const data = await openai.json();
      const reply =
        data.choices?.[0]?.message?.content ||
        "CONSIA processing error.";

      return new Response(
        JSON.stringify({ reply }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // DEFAULT
    return new Response("CONSIA API ACTIVE", { status: 200 });
  }
};
