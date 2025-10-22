import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { Miniflare } from "miniflare";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const entryPath = path.join(projectRoot, "src", "index.ts");

let cachedScript: string | null = null;

async function loadWorkerScript(): Promise<string> {
  if (cachedScript) return cachedScript;
  const source = await readFile(entryPath, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  cachedScript = result.code;
  return cachedScript;
}

export interface CreateWorkerOptions {
  bindings?: Record<string, unknown>;
  durableObjects?: Record<string, string | { className: string }>;
}

export async function createWorker(options: CreateWorkerOptions = {}) {
  const script = await loadWorkerScript();
  const durableObjects =
    options.durableObjects ??
    ({
      ROOMS_DO: { className: "RoomDurableObject" },
      SIGNALLING_ROOM: { className: "SignallingRoom" },
    } as Record<string, string | { className: string }>);
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2025-10-22",
    durableObjects,
    bindings: options.bindings,
  });
}

type EventTargetWithRemove = EventTarget & {
  removeEventListener: EventTarget["removeEventListener"];
};

function waitForEvent<T extends Event>(
  target: EventTargetWithRemove,
  type: string,
  timeoutMs = 2000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, handler as EventListener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);

    const handler = (event: Event) => {
      clearTimeout(timer);
      target.removeEventListener(type, handler as EventListener);
      resolve(event as T);
    };

    target.addEventListener(type, handler as EventListener);
  });
}

export async function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  const event = await waitForEvent<MessageEvent>(ws as unknown as EventTargetWithRemove, "message", timeoutMs);
  return typeof event.data === "string" ? event.data : "";
}

export async function waitForClose(ws: WebSocket, timeoutMs = 2000) {
  return waitForEvent<CloseEvent>(ws as unknown as EventTargetWithRemove, "close", timeoutMs);
}

export function parseJsonMessage(text: string) {
  return JSON.parse(text) as Record<string, unknown>;
}

export function buildWsHeaders(extra: Record<string, string> = {}) {
  const headers = new Headers({
    Upgrade: "websocket",
    Connection: "Upgrade",
    ...extra,
  });
  return headers;
}

export async function connectClient(
  mf: Miniflare,
  roomId: string,
  init?: { headers?: Record<string, string>; path?: string }
) {
  const path = init?.path ?? "/signaling";
  const url = new URL(`https://example.com${path}`);
  if (!init?.headers?.["CF-Room-Id"]) {
    url.searchParams.set("roomId", roomId);
  }
  const headers = buildWsHeaders(init?.headers);
  const res = await mf.dispatchFetch(url.toString(), { headers });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`Expected WebSocket upgrade, received status ${res.status}`);
  }
  const ws = res.webSocket;
  ws.accept();
  return ws;
}

export function jsonMessage(message: Record<string, unknown>) {
  return JSON.stringify(message);
}
