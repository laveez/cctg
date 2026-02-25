import net from "node:net";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PATH } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonRequest {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface DaemonResponse {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;

export function connectToDaemon(maxRetries = DEFAULT_MAX_RETRIES): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let daemonSpawned = false;

    function tryConnect(): void {
      const socket = net.createConnection(SOCKET_PATH);

      socket.once("connect", () => {
        // Remove the error listener we set for connection failure
        socket.removeAllListeners("error");
        resolve(socket);
      });

      socket.once("error", () => {
        socket.destroy();
        attempt++;

        if (attempt > maxRetries) {
          reject(new Error(`Failed to connect to daemon after ${maxRetries} retries`));
          return;
        }

        // Auto-start daemon on first failure if socket file doesn't exist
        if (!daemonSpawned && !existsSync(SOCKET_PATH)) {
          const daemonPath = join(
            dirname(fileURLToPath(import.meta.url)),
            "daemon.js"
          );
          const child = spawn("node", [daemonPath], {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          });
          child.unref();
          daemonSpawned = true;
        }

        // Retry with backoff
        setTimeout(tryConnect, 200 * (attempt + 1));
      });
    }

    tryConnect();
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export function sendRequest(socket: net.Socket, request: DaemonRequest): void {
  socket.write(JSON.stringify(request) + "\n");
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export function waitForResponse(
  socket: net.Socket,
  timeoutMs: number
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }

    function onData(chunk: Buffer): void {
      if (settled) return;
      buffer += chunk.toString();

      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      settled = true;
      cleanup();

      try {
        resolve(JSON.parse(line) as DaemonResponse);
      } catch {
        reject(new Error("Invalid JSON from daemon"));
      }
    }

    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function onClose(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Daemon connection closed before response"));
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error("Daemon response timed out"));
    }, timeoutMs);

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
