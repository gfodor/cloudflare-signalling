export interface Env {
  SIGNALLING_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response(
        "Cloudflare signalling worker ready. Connect with a WebSocket using ?room=<name>.",
        { status: 200 }
      );
    }

    const url = new URL(request.url);
    const roomName = url.searchParams.get("room") || "default";
    const roomId = env.SIGNALLING_ROOM.idFromName(roomName);
    const roomStub = env.SIGNALLING_ROOM.get(roomId);

    return roomStub.fetch(request);
  },
};

export class SignallingRoom {
  private readonly peers: Set<WebSocket> = new Set();

  constructor(_: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleSession(socket: WebSocket) {
    socket.accept();
    this.peers.add(socket);

    socket.addEventListener("message", (event) => {
      const payload = event.data;
      for (const peer of this.peers) {
        if (peer === socket) {
          continue;
        }
        this.forwardToPeer(peer, payload);
      }
    });

    socket.addEventListener("close", () => {
      this.peers.delete(socket);
    });

    socket.addEventListener("error", () => {
      this.peers.delete(socket);
      try {
        socket.close(1011, "Socket error");
      } catch {
        // Socket already closed; ignore.
      }
    });
  }

  private forwardToPeer(peer: WebSocket, payload: unknown) {
    try {
      peer.send(payload);
    } catch {
      this.peers.delete(peer);
      try {
        peer.close(1011, "Broadcast error");
      } catch {
        // Peer is already closed; ignore.
      }
    }
  }
}
