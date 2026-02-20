import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";

const OFFSET_PATH = "/tmp/cctg-offset";

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface CallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  date: number;
  text?: string;
}

interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
  message?: TelegramMessage;
}

function telegramApi<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<TelegramResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from Telegram: ${body}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export async function sendPermissionRequest(
  botToken: string,
  chatId: string,
  text: string,
  requestId: string
): Promise<number> {
  const res = await telegramApi<{ message_id: number }>(
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "\u2705 Allow", callback_data: `allow:${requestId}` },
            { text: "\u274c Deny", callback_data: `deny:${requestId}` },
          ],
        ],
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.description}`);
  }

  return res.result.message_id;
}

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<number> {
  const res = await telegramApi<{ message_id: number }>(
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }
  );

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.description}`);
  }

  return res.result.message_id;
}

function loadOffset(): number {
  try {
    return parseInt(readFileSync(OFFSET_PATH, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_PATH, String(offset));
  } catch {
    // Non-critical — worst case we reprocess stale updates (requestId guards correctness)
  }
}

export async function flushStaleUpdates(
  botToken: string
): Promise<number> {
  let offset = loadOffset();
  if (offset === 0) return offset;

  // One non-blocking call to advance past any stale callbacks
  const res = await telegramApi<Update[]>(botToken, "getUpdates", {
    offset,
    timeout: 0,
    allowed_updates: ["callback_query"],
  });

  if (res.ok && res.result.length > 0) {
    for (const update of res.result) {
      offset = Math.max(offset, update.update_id + 1);
    }
    saveOffset(offset);
  }

  return offset;
}

export async function pollForDecision(
  botToken: string,
  chatId: string,
  requestId: string,
  timeoutSeconds: number
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let offset = loadOffset();

  while (Date.now() < deadline) {
    const pollTimeout = Math.min(
      30,
      Math.ceil((deadline - Date.now()) / 1000)
    );
    if (pollTimeout <= 0) break;

    const res = await telegramApi<Update[]>(botToken, "getUpdates", {
      offset,
      timeout: pollTimeout,
      allowed_updates: ["callback_query"],
    });

    if (!res.ok) {
      throw new Error(`Telegram getUpdates failed: ${res.description}`);
    }

    for (const update of res.result) {
      offset = update.update_id + 1;
      saveOffset(offset);

      const cb = update.callback_query;
      if (!cb?.data) continue;

      // Verify sender is the authorized chat
      if (String(cb.from.id) !== chatId) continue;

      // Check request ID matches
      const [decision, id] = cb.data.split(":");
      if (id !== requestId) continue;

      // Acknowledge the button press
      await telegramApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: decision === "allow" ? "Allowed" : "Denied",
      });

      return decision;
    }
  }

  return "deny"; // Timeout = deny (fail-closed)
}

export interface TextPollResult {
  type: "message" | "done" | "timeout" | "abort";
  text?: string;
}

export async function pollForTextMessage(
  botToken: string,
  chatId: string,
  timeoutSeconds: number,
  checkAbort?: () => boolean
): Promise<TextPollResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let offset = loadOffset();

  while (Date.now() < deadline) {
    if (checkAbort?.()) return { type: "abort" };

    const pollTimeout = Math.min(
      10,
      Math.ceil((deadline - Date.now()) / 1000)
    );
    if (pollTimeout <= 0) break;

    const res = await telegramApi<Update[]>(botToken, "getUpdates", {
      offset,
      timeout: pollTimeout,
      allowed_updates: ["message"],
    });

    if (!res.ok) {
      throw new Error(`Telegram getUpdates failed: ${res.description}`);
    }

    for (const update of res.result) {
      offset = update.update_id + 1;
      saveOffset(offset);

      const msg = update.message;
      if (!msg?.text) continue;
      if (String(msg.chat.id) !== chatId) continue;

      if (msg.text.trim() === "/done") {
        return { type: "done" };
      }

      return { type: "message", text: msg.text };
    }
  }

  return { type: "timeout" };
}

export async function sendQuestionWithOptions(
  botToken: string,
  chatId: string,
  text: string,
  options: { label: string; callbackData: string }[],
  requestId: string
): Promise<number> {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    const row = options.slice(i, i + 2).map((opt) => ({
      text: opt.label,
      callback_data: `${opt.callbackData}:${requestId}`,
    }));
    rows.push(row);
  }

  const res = await telegramApi<{ message_id: number }>(
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    }
  );

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.description}`);
  }

  return res.result.message_id;
}

export async function editMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string
): Promise<void> {
  await telegramApi(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
  });
}
