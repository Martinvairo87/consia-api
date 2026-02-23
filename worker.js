export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("CONSIA PRODUCTION ACTIVE");
    }

    if (url.pathname === "/voice/session") {
      const response = await fetch(
        "https://api.openai.com/v1/realtime/sessions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4o-realtime-preview",
            voice: "alloy"
          })
        }
      );

      const data = await response.json();
      return Response.json(data);
    }

    return new Response("Route not found", { status: 404 });
  }
};
