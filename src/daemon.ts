import net from "node:net";
import { appendFileSync, existsSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import {
  loadConfig,
  ACTIVE_PATH,
  SOCKET_PATH,
  DAEMON_LOG_PATH,
  type CctgConfig,
} from "./config.js";
import {
  telegramApi,
  loadOffset,
  saveOffset,
  flushStaleUpdates,
  sendPermissionRequest,
  sendQuestionWithOptions,
  sendMessage,
  editMessage,
  type Update,
} from "./telegram.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  type: "permission" | "question" | "stop";
  requestId: string;
  socket: net.Socket;
  sessionLabel: string;
  timeoutTimer?: NodeJS.Timeout;
  telegramMessageId?: number;
  originalMessage?: string;
}

interface IncomingPermission {
  type: "permission";
  requestId: string;
  message: string;
  sessionLabel: string;
}

interface IncomingQuestion {
  type: "question";
  requestId: string;
  message: string;
  options: { label: string; callbackData: string }[];
  sessionLabel: string;
}

interface IncomingStop {
  type: "stop";
  requestId: string;
  message: string;
  sessionLabel: string;
  timeoutSeconds: number;
}

interface IncomingPing {
  type: "ping";
}

interface IncomingShutdown {
  type: "shutdown";
}

type IncomingMessage =
  | IncomingPermission
  | IncomingQuestion
  | IncomingStop
  | IncomingPing
  | IncomingShutdown;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pending = new Map<string, PendingRequest>();
let running = true;
let config: CctgConfig;
let server: net.Server;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  try {
    appendFileSync(DAEMON_LOG_PATH, `[${ts}] ${msg}\n`);
  } catch {
    // Can't log — nothing we can do
  }
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function socketWrite(socket: net.Socket, data: Record<string, unknown>): void {
  try {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(data) + "\n");
    }
  } catch {
    // Socket gone — ignore
  }
}

// ---------------------------------------------------------------------------
// Pending request cleanup
// ---------------------------------------------------------------------------

function removePending(requestId: string): PendingRequest | undefined {
  const req = pending.get(requestId);
  if (!req) return undefined;
  if (req.timeoutTimer) clearTimeout(req.timeoutTimer);
  pending.delete(requestId);
  return req;
}

function cleanupSocketRequests(socket: net.Socket): void {
  for (const [requestId, req] of pending) {
    if (req.socket !== socket) continue;

    removePending(requestId);

    // Best-effort edit Telegram message to show disconnected
    if (req.telegramMessageId && req.originalMessage) {
      editMessage(
        config.botToken,
        config.chatId,
        req.telegramMessageId,
        `${req.originalMessage}\n\n\u26a0\ufe0f _Client disconnected_`
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function labelMessage(sessionLabel: string, message: string): string {
  return `\ud83d\udcc2 _${sessionLabel}_\n\n${message}`;
}

async function handlePermission(msg: IncomingPermission, socket: net.Socket): Promise<void> {
  try {
    const labeled = labelMessage(msg.sessionLabel, msg.message);
    const messageId = await sendPermissionRequest(
      config.botToken,
      config.chatId,
      labeled,
      msg.requestId
    );

    pending.set(msg.requestId, {
      type: "permission",
      requestId: msg.requestId,
      socket,
      sessionLabel: msg.sessionLabel,
      telegramMessageId: messageId,
      originalMessage: labeled,
    });
  } catch (err) {
    log(`Failed to send permission request ${msg.requestId}: ${err}`);
    socketWrite(socket, { requestId: msg.requestId, decision: "deny" });
  }
}

async function handleQuestion(msg: IncomingQuestion, socket: net.Socket): Promise<void> {
  try {
    const labeled = labelMessage(msg.sessionLabel, msg.message);
    const messageId = await sendQuestionWithOptions(
      config.botToken,
      config.chatId,
      labeled,
      msg.options,
      msg.requestId
    );

    pending.set(msg.requestId, {
      type: "question",
      requestId: msg.requestId,
      socket,
      sessionLabel: msg.sessionLabel,
      telegramMessageId: messageId,
      originalMessage: labeled,
    });
  } catch (err) {
    log(`Failed to send question ${msg.requestId}: ${err}`);
    // Default to first option on failure
    socketWrite(socket, { requestId: msg.requestId, decision: "opt0" });
  }
}

async function handleStop(msg: IncomingStop, socket: net.Socket): Promise<void> {
  try {
    const labeled = labelMessage(msg.sessionLabel, msg.message);
    const messageId = await sendMessage(
      config.botToken,
      config.chatId,
      labeled
    );

    const timeoutTimer = setTimeout(() => {
      const req = removePending(msg.requestId);
      if (!req) return;

      socketWrite(socket, { requestId: msg.requestId, result: "timeout" });

      editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${labeled}\n\n\u23f1\ufe0f _Timed out_`
      ).catch(() => {});
    }, msg.timeoutSeconds * 1000);

    pending.set(msg.requestId, {
      type: "stop",
      requestId: msg.requestId,
      socket,
      sessionLabel: msg.sessionLabel,
      timeoutTimer,
      telegramMessageId: messageId,
      originalMessage: labeled,
    });
  } catch (err) {
    log(`Failed to send stop message ${msg.requestId}: ${err}`);
    socketWrite(socket, { requestId: msg.requestId, result: "timeout" });
  }
}

function handleSocketMessage(msg: IncomingMessage, socket: net.Socket): void {
  switch (msg.type) {
    case "ping":
      socketWrite(socket, { type: "pong" });
      break;
    case "shutdown":
      log("Shutdown requested via socket");
      shutdown();
      break;
    case "permission":
      handlePermission(msg, socket).catch((err) =>
        log(`handlePermission error: ${err}`)
      );
      break;
    case "question":
      handleQuestion(msg, socket).catch((err) =>
        log(`handleQuestion error: ${err}`)
      );
      break;
    case "stop":
      handleStop(msg, socket).catch((err) =>
        log(`handleStop error: ${err}`)
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Telegram poll loop
// ---------------------------------------------------------------------------

async function pollLoop(): Promise<void> {
  let offset = loadOffset();

  while (running) {
    try {
      const res = await telegramApi<Update[]>(config.botToken, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["callback_query", "message"],
      });

      if (!res.ok) {
        log(`getUpdates failed: ${res.description}`);
        await sleep(2000);
        continue;
      }

      for (const update of res.result) {
        offset = Math.max(offset, update.update_id + 1);

        if (update.callback_query) {
          handleCallbackQuery(update.callback_query);
        } else if (update.message) {
          handleTextMessage(update.message);
        }
      }

      saveOffset(offset);
    } catch (err) {
      log(`Poll loop error: ${err}`);
      // Back off on network errors, but don't crash
      await sleep(5000);
    }
  }
}

function handleCallbackQuery(cb: NonNullable<Update["callback_query"]>): void {
  if (!cb.data) return;
  if (String(cb.from.id) !== config.chatId) return;

  const parts = cb.data.split(":");
  if (parts.length < 2) return;

  const decision = parts[0];
  const requestId = parts.slice(1).join(":"); // requestId could theoretically contain ":"

  const req = removePending(requestId);
  if (!req) {
    // Acknowledge orphan callback to remove "loading" state
    telegramApi(config.botToken, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Expired",
    }).catch(() => {});
    return;
  }

  // Send response to hook client
  if (req.type === "permission") {
    socketWrite(req.socket, { requestId, decision });
  } else if (req.type === "question") {
    socketWrite(req.socket, { requestId, decision });
  }

  // Acknowledge the callback
  const ackText =
    req.type === "permission"
      ? decision === "allow"
        ? "Allowed"
        : "Denied"
      : `Selected: ${decision}`;

  telegramApi(config.botToken, "answerCallbackQuery", {
    callback_query_id: cb.id,
    text: ackText,
  }).catch(() => {});

  // Edit the Telegram message with status
  if (req.telegramMessageId && req.originalMessage) {
    let statusIcon: string;
    let statusText: string;

    if (req.type === "permission") {
      statusIcon = decision === "allow" ? "\u2705" : "\u274c";
      statusText = decision === "allow" ? "Allowed" : "Denied";
    } else {
      statusIcon = "\u2705";
      statusText = `Selected: ${decision}`;
    }

    editMessage(
      config.botToken,
      config.chatId,
      req.telegramMessageId,
      `${req.originalMessage}\n\n${statusIcon} ${statusText}`
    ).catch(() => {});
  }
}

function handleTextMessage(msg: NonNullable<Update["message"]>): void {
  if (!msg.text) return;
  if (String(msg.chat.id) !== config.chatId) return;

  // Find the most recent pending stop request
  let latestStop: PendingRequest | undefined;
  for (const req of pending.values()) {
    if (req.type !== "stop") continue;
    latestStop = req;
  }

  if (!latestStop) return;

  const req = removePending(latestStop.requestId);
  if (!req) return;

  const text = msg.text.trim();

  if (text === "/done") {
    socketWrite(req.socket, { requestId: req.requestId, result: "done" });

    if (req.telegramMessageId && req.originalMessage) {
      editMessage(
        config.botToken,
        config.chatId,
        req.telegramMessageId,
        `${req.originalMessage}\n\n\u23f9\ufe0f _Stopped_`
      ).catch(() => {});
    }
  } else {
    socketWrite(req.socket, { requestId: req.requestId, result: "message", text });

    if (req.telegramMessageId && req.originalMessage) {
      editMessage(
        config.botToken,
        config.chatId,
        req.telegramMessageId,
        `${req.originalMessage}\n\n\u25b6\ufe0f _Continuing..._`
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function watchActiveFile(): void {
  watchFile(ACTIVE_PATH, { interval: 5000 }, () => {
    if (!existsSync(ACTIVE_PATH)) {
      log("Active file removed — shutting down");
      shutdown();
    }
  });
}

function shutdown(): void {
  if (!running) return;
  running = false;

  log("Shutting down...");

  // Abort/deny all pending requests
  for (const [requestId, req] of pending) {
    if (req.type === "permission" || req.type === "question") {
      socketWrite(req.socket, {
        requestId,
        decision: "deny",
      });
    } else if (req.type === "stop") {
      socketWrite(req.socket, {
        requestId,
        result: "abort",
      });
    }

    if (req.telegramMessageId && req.originalMessage) {
      editMessage(
        config.botToken,
        config.chatId,
        req.telegramMessageId,
        `${req.originalMessage}\n\n\u26a0\ufe0f _Daemon shutdown_`
      ).catch(() => {});
    }

    if (req.timeoutTimer) clearTimeout(req.timeoutTimer);
  }
  pending.clear();

  // Stop watching the active file
  unwatchFile(ACTIVE_PATH);

  // Close socket server and clean up
  server.close(() => {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone
    }
    log("Shutdown complete");
    process.exit(0);
  });

  // Force exit if server.close hangs
  setTimeout(() => {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone
    }
    process.exit(0);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

function startServer(): net.Server {
  // Clean up stale socket
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // Doesn't exist — fine
  }

  const srv = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line) as IncomingMessage;
          handleSocketMessage(msg, socket);
        } catch (err) {
          log(`Invalid JSON from socket: ${err}`);
        }
      }
    });

    socket.on("close", () => {
      cleanupSocketRequests(socket);
    });

    socket.on("error", (err) => {
      log(`Socket error: ${err.message}`);
      cleanupSocketRequests(socket);
    });
  });

  srv.listen(SOCKET_PATH, () => {
    log(`Socket server listening on ${SOCKET_PATH}`);
  });

  srv.on("error", (err) => {
    log(`Server error: ${err.message}`);
    process.exit(1);
  });

  return srv;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  config = loadConfig();

  log("Daemon starting...");

  // Flush stale Telegram updates on startup
  await flushStaleUpdates(config.botToken);
  log("Stale updates flushed");

  // Start socket server
  server = startServer();

  // Start lifecycle watcher
  watchActiveFile();

  // Start poll loop (runs until shutdown)
  pollLoop().catch((err) => {
    log(`Poll loop crashed: ${err}`);
    shutdown();
  });

  // Handle signals
  process.on("SIGTERM", () => {
    log("Received SIGTERM");
    shutdown();
  });
  process.on("SIGINT", () => {
    log("Received SIGINT");
    shutdown();
  });

  log("Daemon started — PID " + process.pid);
}

main().catch((err) => {
  log(`Daemon failed to start: ${err}`);
  process.exit(1);
});
