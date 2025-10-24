import http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  connectClient,
  createWorker,
  jsonMessage,
  parseJsonMessage,
  waitForClose,
  waitForMessage,
} from "./utils";

const disposables: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (disposables.length) {
    const dispose = disposables.pop();
    if (dispose) await dispose();
  }
});

describe("Cloudflare signalling worker", () => {
  test("GET /.ok responds with 200 and empty body", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const res = await mf.dispatchFetch("https://example.com/.ok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("GET /signaling without roomId returns 400", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const response = await mf.dispatchFetch("https://example.com/signaling", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("roomId required");
  });

  test("Worker falls back to legacy SIGNALLING_ROOM binding", async () => {
    const mf = await createWorker({
      durableObjects: {
        SIGNALLING_ROOM: { className: "SignallingRoom" },
      },
    });
    disposables.push(() => mf.dispose());

    const ws = await connectClient(mf, "legacy-room");
    ws.send(jsonMessage({ type: "register", roomId: "legacy-room" }));
    const message = parseJsonMessage(await waitForMessage(ws));
    expect(message.type).toBe("accept");
    ws.close();
  });

  test("Two participants register and exchange signaling payloads", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const wsA = await connectClient(mf, "room1");
    const wsB = await connectClient(mf, "room1");

    wsA.send(jsonMessage({ type: "register", roomId: "room1", clientId: "alice" }));
    const acceptA = parseJsonMessage(await waitForMessage(wsA));
    expect(acceptA.type).toBe("accept");
    expect(acceptA.isExistClient).toBe(false);

    wsB.send(jsonMessage({ type: "register", roomId: "room1", clientId: "bob" }));
    const acceptB = parseJsonMessage(await waitForMessage(wsB));
    expect(acceptB.type).toBe("accept");
    expect(acceptB.isExistClient).toBe(true);

    wsA.send(jsonMessage({ type: "offer", roomId: "room1", sdp: "fake-sdp" }));
    const forwarded = parseJsonMessage(await waitForMessage(wsB));
    expect(forwarded.type).toBe("offer");
    expect(forwarded.sdp).toBe("fake-sdp");

    wsA.close();
    wsB.close();
  });

  test("Third participant is rejected when room full", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const ws1 = await connectClient(mf, "room2");
    const ws2 = await connectClient(mf, "room2");
    const ws3 = await connectClient(mf, "room2");

    ws1.send(jsonMessage({ type: "register", roomId: "room2", clientId: "first" }));
    await waitForMessage(ws1);

    ws2.send(jsonMessage({ type: "register", roomId: "room2", clientId: "second" }));
    await waitForMessage(ws2);

    ws3.send(jsonMessage({ type: "register", roomId: "room2", clientId: "third" }));
    const rejectMsg = parseJsonMessage(await waitForMessage(ws3));
    expect(rejectMsg.type).toBe("reject");
    expect(rejectMsg.reason).toBe("full");
    const close = await waitForClose(ws3);
    expect(close.code).toBe(1000);

    ws1.close();
    ws2.close();
  });

  test("message frames require TYPE_MESSAGE flag", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const ws = await connectClient(mf, "room3");
    ws.send(jsonMessage({ type: "register", roomId: "room3" }));
    await waitForMessage(ws); // accept

    ws.send(jsonMessage({ type: "message", roomId: "room3", data: "oops" }));
    const close = await waitForClose(ws);
    expect(close.code).toBe(1000);
  });

  test("message frames are forwarded when TYPE_MESSAGE=true", async () => {
    const mf = await createWorker({
      bindings: { TYPE_MESSAGE: "true" },
    });
    disposables.push(() => mf.dispose());

    const ws1 = await connectClient(mf, "room4");
    const ws2 = await connectClient(mf, "room4");

    ws1.send(jsonMessage({ type: "register", roomId: "room4" }));
    await waitForMessage(ws1);

    ws2.send(jsonMessage({ type: "register", roomId: "room4" }));
    await waitForMessage(ws2);

    ws1.send(jsonMessage({ type: "message", roomId: "room4", hello: "world" }));
    const msg = parseJsonMessage(await waitForMessage(ws2));
    expect(msg.type).toBe("message");
    expect(msg.hello).toBe("world");

    ws1.close();
    ws2.close();
  });

  test("roomId mismatch closes socket with 1008", async () => {
    const mf = await createWorker();
    disposables.push(() => mf.dispose());

    const ws = await connectClient(mf, "header-room", { headers: { "CF-Room-Id": "header-room" } });
    ws.send(jsonMessage({ type: "register", roomId: "other-room" }));
    const close = await waitForClose(ws);
    expect(close.code).toBe(1008);
  });

  test("auth webhook deny rejects registration with provided reason", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ allowed: false, reason: "blocked" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as http.AddressInfo;

    const mf = await createWorker({
      bindings: {
        AUTHN_WEBHOOK_URL: `http://127.0.0.1:${port}/auth`,
      },
    });
    disposables.push(() => mf.dispose());
    disposables.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );

    const ws = await connectClient(mf, "secure-room");
    ws.send(
      jsonMessage({
        type: "register",
        roomId: "secure-room",
        clientId: "user-1",
        signalingKey: "secret",
      })
    );
    const message = parseJsonMessage(await waitForMessage(ws));
    expect(message.type).toBe("reject");
    expect(message.reason).toBe("blocked");
    const close = await waitForClose(ws);
    expect(close.code).toBe(1000);
  });

  test("auth webhook success mirrors iceServers and authzMetadata", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          allowed: true,
          iceServers: [{ urls: ["stun:example.org"] }],
          authzMetadata: { role: "vip" },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as http.AddressInfo;

    const mf = await createWorker({
      bindings: {
        AUTHN_WEBHOOK_URL: `http://127.0.0.1:${port}/auth`,
      },
    });
    disposables.push(() => mf.dispose());
    disposables.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );

    const ws = await connectClient(mf, "secure-room-allow");
    ws.send(
      jsonMessage({
        type: "register",
        roomId: "secure-room-allow",
        clientId: "user-2",
      })
    );
    const accept = parseJsonMessage(await waitForMessage(ws));
    expect(accept.type).toBe("accept");
    expect(accept.authzMetadata).toEqual({ role: "vip" });
   expect(accept.iceServers).toEqual([{ urls: ["stun:example.org"] }]);
    ws.close();
  });

  test("TURN credentials delivered when turn=true", async () => {
    let captured: { path?: string; authorization?: string; body?: any } | null = null;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = undefined;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        captured = {
          path: req.url ?? undefined,
          authorization: req.headers["authorization"],
          body: parsed,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            iceServers: [
              {
                urls: [
                  "stun:global.turn.cloudflare.com:3478",
                  "turn:global.turn.cloudflare.com:53?transport=udp",
                  "turns:global.turn.cloudflare.com:5349?transport=tcp",
                ],
                username: "user-123",
                credential: "cred-456",
              },
            ],
            ttl: 120,
            expiresAt: "2025-10-24T12:34:56Z",
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as http.AddressInfo;

    const mf = await createWorker({
      bindings: {
        TURN_KEY_ID: "test-turn-key",
        TURN_API_TOKEN: "super-secret-token",
        TURN_CREDENTIAL_TTL_SEC: "120",
        TURN_FILTER_PORT_53: "true",
        TURN_API_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    disposables.push(() => mf.dispose());
    disposables.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );

    const ws = await connectClient(mf, "turn-room", { path: "/signaling?roomId=turn-room&turn=true" });
    ws.send(jsonMessage({ type: "register", roomId: "turn-room" }));
    const accept = parseJsonMessage(await waitForMessage(ws));

    expect(accept.type).toBe("accept");
    expect(captured).not.toBeNull();
    expect(captured?.authorization).toBe("Bearer super-secret-token");
    expect(captured?.path).toBe("/v1/turn/keys/test-turn-key/credentials/generate-ice-servers");
    expect(captured?.body?.ttl).toBe(120);

    expect(Array.isArray(accept.iceServers)).toBe(true);
    const servers = accept.iceServers as Array<Record<string, unknown>>;
    expect(servers).toHaveLength(1);
    const urls = servers[0]?.urls as string[];
    expect(Array.isArray(urls)).toBe(true);
    expect(urls).toContain("stun:global.turn.cloudflare.com:3478");
    expect(urls).toContain("turns:global.turn.cloudflare.com:5349?transport=tcp");
    const hasPort53 = urls.some((url) => {
      const qIndex = url.indexOf("?");
      const withoutQuery = qIndex === -1 ? url : url.slice(0, qIndex);
      const colonIndex = withoutQuery.lastIndexOf(":");
      if (colonIndex === -1) return false;
      const portPart = withoutQuery.slice(colonIndex + 1);
      return /^\d+$/.test(portPart) && Number(portPart) === 53;
    });
    expect(hasPort53).toBe(false);

    expect(accept.turnCredentials).toEqual({
      expiresAt: "2025-10-24T12:34:56Z",
      ttlSeconds: 120,
    });

    ws.close();
  });
});
