// CONSIA CORE — TOP 1 WORLD — MASTER WORKER
// Realtime + Voice + Rooms + Users + Plans + Budget + Owner Security
// Deploy Ready — Cloudflare Workers

export class ConsiaState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const id = crypto.randomUUID();
      this.sessions.set(id, server);

      server.accept();

      server.addEventListener("message", (event) => {
        for (const [sid, sock] of this.sessions) {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({
              from: id,
              data: event.data
            }));
          }
        }
      });

      server.addEventListener("close", () => {
        this.sessions.delete(id);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("CONSIA REALTIME NODE");
  }
}

// ROOMS (Meeting Layer)

export class MeetingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.clients.add(server);

    server.addEventListener("message", evt => {
      for (const c of this.clients) {
        if (c.readyState === 1) {
          c.send(evt.data);
        }
      }
    });

    server.addEventListener("close", () => {
      this.clients.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

// MAIN WORKER

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // HEALTH

    if (url.pathname === "/") {
      return new Response("CONSIA CORE ACTIVE");
    }

    // OWNER SECURITY

    const ownerToken = request.headers.get("x-owner-token");
    if (url.pathname.startsWith("/owner")) {
      if (ownerToken !== env.OWNER_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("OWNER ACCESS GRANTED");
    }

    // REALTIME GLOBAL

    if (url.pathname.startsWith("/realtime")) {
      const id = env.CONSIA_STATE.idFromName("global");
      const stub = env.CONSIA_STATE.get(id);
      return stub.fetch(request);
    }

    // ROOMS

    if (url.pathname.startsWith("/room/")) {
      const room = url.pathname.split("/")[2];
      const id = env.MEETING_DO.idFromName(room);
      const stub = env.MEETING_DO.get(id);
      return stub.fetch(request);
    }

    // VOICE TOKEN

    if (url.pathname === "/voice/token") {
      return Response.json({
        ok: true,
        token: crypto.randomUUID(),
        voice: "alloy",
        realtime: true
      });
    }

    // USERS CREATE

    if (url.pathname === "/user/create") {
      const id = crypto.randomUUID();

      await env.SESSIONS_KV.put(id, JSON.stringify({
        plan: "FREE",
        created: Date.now()
      }));

      return Response.json({ ok: true, user: id });
    }

    // PLAN SET

    if (url.pathname === "/user/plan") {
      const { user, plan } = await request.json();

      await env.SESSIONS_KV.put(user, JSON.stringify({
        plan,
        updated: Date.now()
      }));

      return Response.json({ ok: true });
    }

    // BUDGET CHECK

    if (url.pathname === "/budget/check") {
      const used = await env.GLOBAL_STATE_KV.get("budget") || 0;

      if (Number(used) > 1000) {
        return Response.json({ locked: true });
      }

      return Response.json({ locked: false });
    }

    // PRESENCE

    if (url.pathname === "/presence") {
      const id = crypto.randomUUID();

      await env.PRESENCE_KV.put(id, Date.now());

      return Response.json({ ok: true });
    }

    // AUDIT LOG

    if (url.pathname === "/audit") {
      const data = await request.text();
      const id = crypto.randomUUID();

      await env.AUDIT_KV.put(id, data);

      return Response.json({ ok: true });
    }

    return new Response("CONSIA ROUTE NOT FOUND", { status: 404 });
  }
};
