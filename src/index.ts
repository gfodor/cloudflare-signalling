export interface Env {
  SIGNALLING_ROOM?: DurableObjectNamespace;
  ROOMS_DO?: DurableObjectNamespace;
  AUTHN_WEBHOOK_URL?: string;
  DISCONNECT_WEBHOOK_URL?: string;
  COPY_WEBSOCKET_HEADER_NAMES?: string;
  TYPE_MESSAGE?: string;
  WS_PING_INTERVAL_SEC?: string;
  WS_PONG_TIMEOUT_SEC?: string;
  WS_READ_TIMEOUT_SEC?: string;
  READ_LIMIT_BYTES?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  TURN_CREDENTIAL_TTL_SEC?: string;
  TURN_REQUEST_TIMEOUT_MS?: string;
  TURN_API_BASE_URL?: string;
  TURN_FILTER_PORT_53?: string;
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
};

// -----------------------------
// Room Durable Object implementation
// -----------------------------

type JsonPrimitive = null | boolean | number | string;
type Json = JsonPrimitive | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json | undefined };

type RegisterMsg = {
  type: "register";
  roomId: string;
  clientId?: string;
  signalingKey?: string;
  key?: string;
  authnMetadata?: Json;
  ayameClient?: string;
  libwebrtc?: string;
  environment?: string;
  standalone?: boolean;
};

type OfferMsg = { type: "offer" } & Record<string, Json>;
type AnswerMsg = { type: "answer" } & Record<string, Json>;
type CandidateMsg = { type: "candidate" } & Record<string, Json>;
type MessageMsg = { type: "message" } & Record<string, Json>;
type PongMsg = { type: "pong" } & Record<string, Json>;
type ConnectedMsg = { type: "connected" } & Record<string, Json>;
type GenericInboundMsg = { type: string; [key: string]: Json };

type InboundMsg =
  | RegisterMsg
  | OfferMsg
  | AnswerMsg
  | CandidateMsg
  | MessageMsg
  | PongMsg
  | ConnectedMsg
  | GenericInboundMsg;

type TeardownOptions = {
  closePeer?: boolean;
  notifyPeer?: boolean;
};

type TurnConfig = {
  keyId: string;
  apiToken: string;
  ttlSec: number;
  requestTimeoutMs: number;
  apiBaseUrl: string;
  filterPort53: boolean;
};

type TurnAllocation = {
  iceServers?: Json;
  expiresAt?: string;
  ttlSeconds?: number;
};

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
  turnRequested: boolean;
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
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const urlRoomId = url.searchParams.get("roomId") ?? undefined;
    const headerRoomId = request.headers.get("CF-Room-Id") ?? undefined;
    const routedRoomId = urlRoomId ?? headerRoomId ?? "∅";
    const turnRequested = parseQueryBoolean(url.searchParams.get("turn"));

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Upgrade and hand off
    this.attach(server, request, {
      routedRoomId,
      urlRoomId,
      headerRoomId,
      turnRequested,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private attach(
    ws: WebSocket,
    request: Request,
    keys: { routedRoomId: string; urlRoomId?: string; headerRoomId?: string; turnRequested: boolean }
  ) {
    const { routedRoomId, urlRoomId, headerRoomId, turnRequested } = keys;

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

    const send = (sock: WebSocket, obj: JsonObject) => {
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

      const rejectAndClose = (reason: string, detail?: string) => {
        send(ws, { type: "reject", reason });
        clearPreRegPing();
        protocolErrorClose(detail ?? reason);
      };

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
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }

        const timeoutMs = Math.max(this.cfg.pongTimeoutSec * 1000, 5000);
        let authResponse: Response;
        try {
          authResponse = await fetch(this.cfg.authnWebhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          rejectAndClose("InternalServerError", "auth webhook error");
          return;
        }

        if (!authResponse.ok) {
          rejectAndClose("InternalServerError", "auth webhook non-200");
          return;
        }

        let authBody: unknown;
        try {
          authBody = await authResponse.json();
        } catch {
          rejectAndClose("InternalServerError", "auth webhook invalid JSON");
          return;
        }

        if (!isObject(authBody) || typeof (authBody as Partial<AuthnResponse>).allowed !== "boolean") {
          rejectAndClose("InternalServerError", "auth webhook malformed response");
          return;
        }

        const body = authBody as AuthnResponse;
        if (!body.allowed) {
          const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason : "denied";
          rejectAndClose(reason, "auth webhook denied");
          return;
        }

        iceServers = body.iceServers;
        authzMetadata = body.authzMetadata;
      }

      let turnAllocation: TurnAllocation | undefined;
      if (turnRequested) {
        if (this.cfg.turn) {
          turnAllocation = await this.generateTurnCredentials({
            roomId: msg.roomId,
            clientId,
            connectionId,
          });
        } else {
          console.warn("TURN requested but TURN_KEY_ID/TURN_API_TOKEN are not configured", {
            roomId: msg.roomId,
            clientId,
          });
        }
      }

      const mergedIceServers = mergeIceServers(iceServers, turnAllocation?.iceServers);

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
        turnRequested,
        iceServers: mergedIceServers,
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
      const acceptPayload: JsonObject = {
        type: "accept",
        connectionId,
        isExistClient,
        isExistUser: isExistClient,
        authzMetadata,
        iceServers: mergedIceServers,
      };

      send(ws, acceptPayload);

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
            const current = participant;
            try {
              current.socket.close(1000, "connected");
            } catch {
              /* ignore */
            }
            this.teardown(current, "standalone-connected", { closePeer: false, notifyPeer: false });
            participant = null;
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
  }

  private startTimers(p: Participant) {
    // Read deadline watchdog
    const readTick = () => {
      const idleMs = nowMs() - p.lastReadAt;
      if (idleMs > this.cfg.readTimeoutSec * 1000) {
        try {
          p.socket.close(1000, "read timeout");
        } catch { /* ignore */ }
        this.teardown(p, "read-timeout");
      }
    };
    p.readDeadline = setInterval(readTick, Math.max(1000, Math.floor(this.cfg.readTimeoutSec * 250))) as any;

    // Heartbeats disabled in standalone
    if (!p.standalone) {
      p.pingInterval = setInterval(() => {
        try {
          p.socket.send(jsonStringify({ type: "ping" }));
          // set pong watchdog
          p.pongDeadline = setTimeout(() => {
            try {
              p.socket.close(1000, "pong timeout");
            } catch { /* ignore */ }
            this.teardown(p, "pong-timeout");
          }, this.cfg.pongTimeoutSec * 1000) as any;
        } catch {
          this.teardown(p, "ping-send-failed");
        }
      }, this.cfg.pingIntervalSec * 1000) as any;
    }
  }

  private async generateTurnCredentials(context: {
    roomId: string;
    clientId: string;
    connectionId: string;
  }): Promise<TurnAllocation | undefined> {
    const turnCfg = this.cfg.turn;
    if (!turnCfg) return undefined;

    let endpoint: URL;
    try {
      endpoint = new URL(
        `/v1/turn/keys/${encodeURIComponent(turnCfg.keyId)}/credentials/generate-ice-servers`,
        turnCfg.apiBaseUrl
      );
    } catch (error) {
      console.error("Failed to construct TURN endpoint URL", {
        roomId: context.roomId,
        clientId: context.clientId,
        error,
      });
      return undefined;
    }

    const payload = JSON.stringify({ ttl: turnCfg.ttlSec });
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${turnCfg.apiToken}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(turnCfg.requestTimeoutMs),
      });
    } catch (error) {
      console.error("TURN credential request failed", {
        roomId: context.roomId,
        clientId: context.clientId,
        error,
      });
      return undefined;
    }

    if (!response.ok) {
      let responseText = "";
      try {
        responseText = await response.text();
      } catch {
        // ignore
      }
      console.error("TURN credential request returned non-OK", {
        status: response.status,
        roomId: context.roomId,
        clientId: context.clientId,
        body: responseText.slice(0, 512),
      });
      return undefined;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      console.error("TURN credential response was not valid JSON", {
        roomId: context.roomId,
        clientId: context.clientId,
        error,
      });
      return undefined;
    }

    if (!isObject(body)) {
      console.error("TURN credential response was not an object", {
        roomId: context.roomId,
        clientId: context.clientId,
      });
      return undefined;
    }

    const record = body as Record<string, unknown>;
    const allocation: TurnAllocation = {};

    const sanitizedIceServers = sanitizeIceServers(record.iceServers, turnCfg.filterPort53);
    if (sanitizedIceServers) {
      allocation.iceServers = sanitizedIceServers;
    }

    const expiresAtRaw = record.expiresAt ?? record.expires;
    if (typeof expiresAtRaw === "string" && expiresAtRaw.trim().length > 0) {
      allocation.expiresAt = expiresAtRaw;
    }

    const ttlCandidate = record.ttl ?? record.ttlSeconds ?? record.expiresIn;
    const ttlSeconds = Number(ttlCandidate);
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      allocation.ttlSeconds = Math.floor(ttlSeconds);
    }

    return allocation;
  }

  private forwardToPeer(sender: Participant, payloadText: string) {
    const peer = this.getPeer(sender);
    if (!peer) return; // no peer yet
    try {
      peer.socket.send(payloadText);
    } catch {
      this.teardown(sender, "peer-send-failed");
    }
  }

  private teardown(p: Participant | null, reason: string, opts?: TeardownOptions) {
    if (!p) return;

    const self = p;
    const peer = this.getPeer(self);
    const closePeer = opts?.closePeer !== false;
    const notifyPeer = opts?.notifyPeer ?? closePeer;

    const participantsToClose: Participant[] = [];
    const seen = new Set<string>();

    const addParticipant = (participant: Participant | null) => {
      if (!participant) return;
      if (seen.has(participant.connectionId)) return;
      seen.add(participant.connectionId);
      participantsToClose.push(participant);
    };

    addParticipant(self);
    if (closePeer) addParticipant(peer);

    const shouldSendBye =
      notifyPeer &&
      !!peer &&
      closePeer &&
      !(self.standalone || peer.standalone);

    if (shouldSendBye && peer) {
      try {
        peer.socket.send(jsonStringify({ type: "bye" }));
      } catch {
        /* ignore */
      }
    }

    for (const target of participantsToClose) {
      if (target.pingInterval) clearInterval(target.pingInterval as any);
      if (target.pongDeadline) clearTimeout(target.pongDeadline as any);
      if (target.readDeadline) clearInterval(target.readDeadline as any);
    }

    const selfCloseReason = reason === "standalone-connected" ? "connected" : "closing";
    const peerCloseReason = "peer closing";

    for (const target of participantsToClose) {
      const closeMessage = target.connectionId === self.connectionId ? selfCloseReason : peerCloseReason;
      try {
        target.socket.close(1000, closeMessage);
      } catch {
        /* ignore */
      }
    }

    const postDisc = (pp: Participant) => {
      if (!this.cfg.disconnectWebhookUrl) return;
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
      (async () => {
        try {
          const ctl = AbortSignal.timeout(5000);
          await fetch(this.cfg.disconnectWebhookUrl!, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: ctl,
          });
        } catch {
          /* ignore */
        }
      })();
    };

    for (const target of participantsToClose) {
      postDisc(target);
    }

    for (const target of participantsToClose) {
      if (this.a && target.connectionId === this.a.connectionId) this.a = null;
      if (this.b && target.connectionId === this.b.connectionId) this.b = null;
    }
  }

  private getPeer(p: Participant): Participant | null {
    if (this.a && p.connectionId === this.a.connectionId) return this.b;
    if (this.b && p.connectionId === this.b.connectionId) return this.a;
    return null;
  }
}

// Backward compatibility: keep old class name pointing to the same implementation
export class SignallingRoom extends RoomDurableObject {}

type ParsedConfig = {
  authnWebhookUrl?: string;
  disconnectWebhookUrl?: string;
  copyHeaderNames: string[];
  typeMessage: boolean;
  pingIntervalSec: number;
  pongTimeoutSec: number;
  readTimeoutSec: number;
  readLimitBytes: number;
  turn?: TurnConfig;
};

function parseConfig(env: Env): ParsedConfig {
  const authnWebhookUrl = toOptionalString(env.AUTHN_WEBHOOK_URL);
  const disconnectWebhookUrl = toOptionalString(env.DISCONNECT_WEBHOOK_URL);
  const copyHeaderNames = parseHeaderNames(env.COPY_WEBSOCKET_HEADER_NAMES);
  const typeMessage = parseBoolean(env.TYPE_MESSAGE, false);
  const pingIntervalSec = parseNumber(env.WS_PING_INTERVAL_SEC, 5, { min: 1 });
  const pongTimeoutSec = parseNumber(env.WS_PONG_TIMEOUT_SEC, 60, { min: 1 });
  const readTimeoutSec = parseNumber(env.WS_READ_TIMEOUT_SEC, 90, { min: 1 });
  const readLimitBytes = parseNumber(env.READ_LIMIT_BYTES, 1_048_576, { min: 1 });

  const turnKeyId = toOptionalString(env.TURN_KEY_ID);
  const turnApiToken = toOptionalString(env.TURN_API_TOKEN);
  const turn: TurnConfig | undefined =
    turnKeyId && turnApiToken
      ? {
          keyId: turnKeyId,
          apiToken: turnApiToken,
          ttlSec: Math.max(1, Math.round(parseNumber(env.TURN_CREDENTIAL_TTL_SEC, 600, { min: 60, max: 86_400 }))),
          requestTimeoutMs: Math.max(
            100,
            Math.round(parseNumber(env.TURN_REQUEST_TIMEOUT_MS, 5000, { min: 1000, max: 60_000 }))
          ),
          apiBaseUrl: sanitizeBaseUrl(toOptionalString(env.TURN_API_BASE_URL)) ?? "https://rtc.live.cloudflare.com",
          filterPort53: parseBoolean(env.TURN_FILTER_PORT_53, false),
        }
      : undefined;

  return Object.freeze({
    authnWebhookUrl,
    disconnectWebhookUrl,
    copyHeaderNames,
    typeMessage,
    pingIntervalSec,
    pongTimeoutSec,
    readTimeoutSec,
    readLimitBytes,
    turn,
  });
}

function toOptionalString(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseNumber(
  value: string | undefined,
  defaultValue: number,
  opts: { min?: number; max?: number } = {}
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  let result = parsed;
  if (opts.min !== undefined && result < opts.min) result = opts.min;
  if (opts.max !== undefined && result > opts.max) result = opts.max;
  return result;
}

function parseHeaderNames(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canonical = trimmed.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

function parseQueryBoolean(value: string | null): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  return true;
}

function mergeIceServers(primary?: Json, secondary?: Json): Json | undefined {
  const primaryIsArray = Array.isArray(primary);
  const secondaryIsArray = Array.isArray(secondary);

  if (primaryIsArray && secondaryIsArray) {
    const first = cloneJsonValue(primary as Json) as Json[];
    const second = cloneJsonValue(secondary as Json) as Json[];
    return [...first, ...second] as Json;
  }

  if (primaryIsArray) {
    return cloneJsonValue(primary as Json);
  }

  if (secondaryIsArray) {
    return cloneJsonValue(secondary as Json);
  }

  if (primary !== undefined) {
    return cloneJsonValue(primary);
  }

  if (secondary !== undefined) {
    return cloneJsonValue(secondary);
  }

  return undefined;
}

function sanitizeIceServers(raw: unknown, filterPort53: boolean): Json | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cloned = cloneJsonValue(raw as Json) as unknown[];
  if (!Array.isArray(cloned)) return undefined;
  if (!filterPort53) {
    return cloned as Json;
  }

  const allow = (url: unknown) => typeof url === "string" && !isPort53(url);

  const filtered: Json[] = [];
  for (const entry of cloned) {
    if (!isObject(entry)) continue;
    const copy: Record<string, unknown> = { ...entry };

    if (Array.isArray(copy.urls)) {
      copy.urls = copy.urls.filter(allow);
      if ((copy.urls as unknown[]).length === 0) delete copy.urls;
    } else if (typeof copy.urls === "string") {
      if (!allow(copy.urls)) delete copy.urls;
    }

    if (typeof copy.url === "string") {
      if (allow(copy.url)) {
        // keep as-is
      } else {
        delete copy.url;
      }
    }

    if (!("urls" in copy) && !("url" in copy)) {
      continue;
    }

    filtered.push(copy as Json);
  }

  return filtered.length > 0 ? (filtered as Json) : undefined;
}

function isPort53(url: string): boolean {
  const questionIndex = url.indexOf("?");
  const withoutQuery = questionIndex === -1 ? url : url.slice(0, questionIndex);
  const colonIndex = withoutQuery.lastIndexOf(":");
  if (colonIndex === -1) return false;
  const portPart = withoutQuery.slice(colonIndex + 1);
  if (!/^\d+$/.test(portPart)) return false;
  return Number(portPart) === 53;
}

function sanitizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    let normalized = url.toString();
    normalized = normalized.replace(/\/+$/, "");
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function cloneJsonValue<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonStringify(value: Json | JsonObject): string {
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

function safeParseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowMs(): number {
  return Date.now();
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;
const ULID_TIME_MAX = 2 ** 48;

function ulid(): string {
  const timeComponent = encodeTime(nowMs());
  const randomComponent = encodeRandom();
  return timeComponent + randomComponent;
}

function encodeTime(time: number): string {
  let value = Math.floor(time % ULID_TIME_MAX);
  const chars = new Array<string>(ULID_TIME_LEN).fill("0");
  for (let i = ULID_TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ULID_ALPHABET[value % 32];
    value = Math.floor(value / 32);
  }
  return chars.join("");
}

function encodeRandom(): string {
  const buffer = new Uint8Array(ULID_RANDOM_LEN);
  crypto.getRandomValues(buffer);
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    output += ULID_ALPHABET[buffer[i] & 31];
  }
  return output;
}
