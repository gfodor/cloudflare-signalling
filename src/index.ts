export interface Env {
  SIGNALLING_ROOM: DurableObjectNamespace;
  ROOMS_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Health endpoint
    if (url.pathname === "/.ok") {
      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/signaling") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      // Routing requirement: roomId must be supplied (URL or header)
      const urlRoomId = url.searchParams.get("roomId") ?? undefined;
      const hdrRoomId = request.headers.get("CF-Room-Id") ?? undefined;
      const routedRoomId = urlRoomId ?? hdrRoomId;

      if (!routedRoomId) {
        // Missing routing key -> cannot resolve DO
        return new Response("roomId required (query ?roomId= or CF-Room-Id header)", { status: 400 });
      }

      // Resolve DO instance for this roomId
      const ns = env.ROOMS_DO ?? env.SIGNALLING_ROOM;
      if (!ns) {
        return new Response("Durable Object binding not found (ROOMS_DO)", { status: 500 });
      }
      const id = ns.idFromName(routedRoomId);
      const stub = ns.get(id);

      // Forward original request; DO will handle mismatch and protocol close (1008) if url/header disagree.
      return stub.fetch(request);
    }

    // Default text response (non-WS)
    return new Response(
      "Ayame‑DO signaling worker ready. Use GET /.ok for health, and WebSocket to /signaling?roomId=<id>.",
      { status: 200 }
    );
  },
}

// -----------------------------
// Room Durable Object implementation
// -----------------------------

type Participant = {
  socket: WebSocket;
  request: Request;
  connectionId: string;
  clientId: string;
  standalone: boolean;
  // runtime
  lastReadAt: number;
  pingInterval?: number;
  pongDeadline?: number;
  readDeadline?: number;
  routedRoomId: string; // key used to select this DO
  urlRoomId?: string;
  headerRoomId?: string;
  // webhook cache
  iceServers?: Json;
  authzMetadata?: Json;
};

type AuthnRequest = {
  roomId: string;
  clientId: string;
  connectionId: string;
  signalingKey?: string;
  authnMetadata?: Json;
  ayameClient?: string;
  libwebrtc?: string;
  environment?: string;
};

type AuthnResponse = {
  allowed: boolean;
  reason?: string;
  iceServers?: Json;
  authzMetadata?: Json;
};

export class RoomDurableObject {
  private state: DurableObjectState;
  private env!: Env;

  // exactly two participants max
  private a: Participant | null = null;
  private b: Participant | null = null;

  // config snapshot
  private readonly cfg: ReturnType<typeof parseConfig>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.cfg = parseConfig(env);

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const urlRoomId = url.searchParams.get("roomId") ?? undefined;
    const headerRoomId = request.headers.get("CF-Room-Id") ?? undefined;
    const routedRoomId = urlRoomId ?? headerRoomId ?? "∅";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Upgrade and hand off
    this.attach(server, request, {
      routedRoomId,
      urlRoomId,
      headerRoomId,
    });

    return new Response(null, { status: 101, webSocket: client });

  private attach(ws: WebSocket, request: Request, keys: { routedRoomId: string; urlRoomId?: string; headerRoomId?: string }) {
    const { routedRoomId, urlRoomId, headerRoomId } = keys;

    ws.accept();
    // Enforce text-only; Cloudflare Worker WS is text/binary; we will reject binary later.

    // Build a temporary 'pre-registration' state
    let participant: Participant | null = null;
    let registered = false;
    let closed = false;

    // Pre-registration timers: allow server pings before registration (spec permits)
    const preRegPingTimer = setInterval(() => {
      // Send ping as in-band JSON
      try {
        ws.send(jsonStringify({ type: "ping" }));
      } catch {
        // ignore; close handled by 'error' event
      }
    }, this.cfg.pingIntervalSec * 1000);

    const clearPreRegPing = () => {
      if (preRegPingTimer) clearInterval(preRegPingTimer);
    };

    // Helper closures
    const closeSocket = (code: number, reason?: string) => {
      if (closed) return;
      closed = true;
      try {
        ws.close(code, reason);
      } catch { /* already closed */ }
    };

    const protocolErrorClose = (reason?: string) => closeSocket(1000, reason ?? "Protocol error");

    const headerMismatchClose = () => closeSocket(1008, "roomId mismatch");

    const enforceReadLimit = (data: string): boolean => {
      // event.data is text string; enforce UTF-8 byte length
      const byteLen = new TextEncoder().encode(data).length;
      return byteLen <= this.cfg.readLimitBytes;
    };

    const send = (sock: WebSocket, obj: Json) => {
      try {
        sock.send(jsonStringify(obj));
      } catch {
        // sending failed -> close both peers per teardown path
        this.teardown(participant, "send-failed");
      }
    };

    const onRegister = async (msg: RegisterMsg) => {
      // Validate routing keys vs payload
      if (!msg.roomId || typeof msg.roomId !== "string") {
        return headerMismatchClose();
      }
      if ((urlRoomId && urlRoomId !== msg.roomId) || (headerRoomId && headerRoomId !== msg.roomId)) {
        return headerMismatchClose();
      }
      if (msg.roomId !== routedRoomId) {
        return headerMismatchClose();
      }

      // Join rules: only two participants
      const pairCount = (this.a ? 1 : 0) + (this.b ? 1 : 0);
      if (pairCount >= 2) {
        send(ws, { type: "reject", reason: "full" });
        return protocolErrorClose("room full");
      }

      // Assign connection and client ids
      const connectionId = ulid();
      const clientId = (msg.clientId && String(msg.clientId)) || connectionId;
      const standalone = !!msg.standalone;

      // Optional auth webhook
      let iceServers: Json | undefined;
      let authzMetadata: Json | undefined;

      if (this.cfg.authnWebhookUrl) {
        const payload: AuthnRequest = {
          roomId: msg.roomId,
          clientId,
          connectionId,
          signalingKey: msg.key ?? msg.signalingKey,
          authnMetadata: msg.authnMetadata,
          ayameClient: msg.ayameClient,
          libwebrtc: msg.libwebrtc,
          environment: msg.environment,
        };

        const headers = new Headers({ "Content-Type": "application/json" });
        // Forward select headers from original upgrade request
        for (const name of this.cfg.copyHeaderNames) {
          // Avoid forbidden headers; Workers runtime strips/guards some automatically
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }

        let authOk = false;
        try {
          const controller = AbortSignal.timeout(Math.max(this.cfg.pongTimeoutSec * 1000, 5000)); // reuse timeout knobs; min 5s
          const res = await fetch(this.cfg.authnWebhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller,
          });
          if (res.ok) {
            const body = (await res.json()) as Partial<AuthnResponse>;
            if (typeof body.allowed === "boolean" && body.allowed) {
              authOk = true;
              iceServers = body.iceServers;
              authzMetadata = body.authzMetadata;
            } else {
              const reason = (body && "reason" in body && (body as any).reason) || "denied";
              send(ws, { type: "reject", reason });
            }
          }
        } catch {
          // ignore; will be handled as auth failure below
        }
        if (!authOk) {
          if (!ws) return; // already closed
          send(ws, { type: "reject", reason: "InternalServerError" });
          return protocolErrorClose("auth failed");
        }
      }

      // Create participant
      participant = {
        socket: ws,
        request,
        connectionId,
        clientId,
        standalone,
        lastReadAt: nowMs(),
        routedRoomId,
        urlRoomId,
        headerRoomId,
        iceServers,
        authzMetadata,
      };
      registered = true;

      // register in slot
      let isExistClient = false;
      if (!this.a) {
        this.a = participant;
        isExistClient = false;
      } else if (!this.b) {
        this.b = participant;
        isExistClient = true;
      } else {
        // Shouldn't happen due to earlier check
        send(ws, { type: "reject", reason: "full" });
        return protocolErrorClose("room full (race)");
      }

      clearPreRegPing();

      // Send accept
      send(ws, {
        type: "accept",
        connectionId,
        isExistClient,
        isExistUser: isExistClient,
        authzMetadata,
        iceServers,
      } as Json);

      // Start timers for this participant
      this.startTimers(participant);
    };

    ws.addEventListener("message", async (ev: MessageEvent) => {
      // Update read activity
      if (participant) participant.lastReadAt = nowMs();

      // Only accept text frames (UTF-8 JSON)
      if (typeof ev.data !== "string") {
        return protocolErrorClose("binary not allowed");
      }
      if (!enforceReadLimit(ev.data)) {
        return protocolErrorClose("frame too large");
      }

      const parsed = safeParseJson(ev.data);
      if (!isObject(parsed) || typeof (parsed as any).type !== "string") {
        // Invalid JSON or missing type
        return protocolErrorClose("invalid JSON");
      }

      const msg = parsed as InboundMsg;

      // Registration must be first
      if (!registered) {
        if ((msg as any).type !== "register") {
          return protocolErrorClose("must register first");
        }
        return onRegister(msg as RegisterMsg);
      }

      // After registration: route by type
      switch (msg.type) {
        case "pong": {
          // Reset pong watchdog if any
          if (participant?.pongDeadline != null) {
            clearTimeout(participant.pongDeadline as any);
            participant.pongDeadline = undefined;
          }
          break;
        }
        case "connected": {
          // In standalone, close immediately; otherwise ignore.
          if (participant?.standalone) {
            protocolErrorClose("connected (standalone close)");
          }
          break;
        }
        case "offer":
        case "answer":
        case "candidate": {
          this.forwardToPeer(participant!, ev.data);
          break;
        }
        case "message": {
          if (!this.cfg.typeMessage) {
            return protocolErrorClose("message type disabled");
          }
          this.forwardToPeer(participant!, ev.data);
          break;
        }
        default: {
          // Unknown types cause protocol close
          return protocolErrorClose("unknown type");
        }
      }
    });

    ws.addEventListener("close", (_ev) => {
      clearPreRegPing();
      this.teardown(participant, "close");
    });

    ws.addEventListener("error", (_ev) => {
      clearPreRegPing();
      this.teardown(participant, "error");
    });

  private forwardToPeer(sender: Participant, payloadText: string) {
    const peer = this.getPeer(sender);
    if (!peer) return; // no peer yet
    try {
      peer.socket.send(payloadText);
    } catch {
      this.teardown(sender, "peer-send-failed");
    }
  }

  private teardown(p: Participant | null, reason: string) {
    // Remove timers & determine slots
    if (p) {
      if (p.pingInterval) clearInterval(p.pingInterval as any);
      if (p.pongDeadline) clearTimeout(p.pongDeadline as any);
      if (p.readDeadline) clearInterval(p.readDeadline as any);
    }

    // Figure out which slot closed
    let closingWasA = false;
    if (p && this.a && p.connectionId === this.a.connectionId) {
      closingWasA = true;
    }

    const self = p;
    const peer = self ? (closingWasA ? this.b : this.a) : null;

    // Notify peer ('bye') only in normal mode (i.e., not standalone on either?)
    // Spec: send bye to surviving peer (normal mode). If either participant is standalone, skip bye.
    const shouldSendBye = !!peer && !(self?.standalone || peer?.standalone);

    if (shouldSendBye && peer) {
      try {
        peer.socket.send(jsonStringify({ type: "bye" }));
      } catch { /* ignore */ }
    }

    // Close both sockets
    if (self) {
      try { self.socket.close(1000, "closing"); } catch { /* ignore */ }
    }
    if (peer) {
      try { peer.socket.close(1000, "peer closing"); } catch { /* ignore */ }
    }

    // Post disconnect webhook(s) for each participant (if configured)
    const postDisc = (pp: Participant | null) => {
      if (!pp || !this.cfg.disconnectWebhookUrl) return;
      const payload = {
        roomId: pp.routedRoomId,
        clientId: pp.clientId,
        connectionId: pp.connectionId,
      };
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const name of this.cfg.copyHeaderNames) {
        const value = pp.request.headers.get(name);
        if (value) headers.set(name, value);
      }
      // Fire-and-forget with timeout; failures do not affect teardown
      (async () => {
        try {
          const ctl = AbortSignal.timeout(5000);
          await fetch(this.cfg.disconnectWebhookUrl!, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: ctl,
          });
        } catch { /* ignore */ }
      })();
    };
    postDisc(self);
    postDisc(peer);

    // Clear room state
    if (self && this.a && self.connectionId === this.a.connectionId) this.a = null;
    if (self && this.b && self.connectionId === this.b.connectionId) this.b = null;
    // If both were closed due to peer logic, ensure both slots clear
    if (peer && this.a && peer.connectionId === this.a.connectionId) this.a = null;
    if (peer && this.b && peer.connectionId === this.b.connectionId) this.b = null;
  }
