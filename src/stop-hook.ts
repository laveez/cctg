import { loadConfig, getMode, ACTIVE_PATH } from "./config.js";
import {
  sendMessage,
  pollForTextMessage,
  editMessage,
  flushStaleUpdates,
} from "./telegram.js";
import {
  formatStopMessage,
  extractLastAssistantMessage,
  type StopHookPayload,
} from "./format.js";
import { readFileSync } from "node:fs";

const PASS_THROUGH = JSON.stringify({});

function readMode(): string {
  try {
    return readFileSync(ACTIVE_PATH, "utf-8").trim();
  } catch {
    return "off";
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const payload: StopHookPayload = JSON.parse(input);

  // Only intercept in "on" mode
  if (getMode() !== "on") {
    process.stdout.write(PASS_THROUGH);
    return;
  }

  const config = loadConfig();

  // Extract last assistant message from transcript
  const lastMessage = extractLastAssistantMessage(payload.transcript_path);

  // Flush stale updates
  await flushStaleUpdates(config.botToken);

  // Send stop notification to Telegram
  const message = formatStopMessage(lastMessage);
  const messageId = await sendMessage(
    config.botToken,
    config.chatId,
    message
  );

  // Capture initial mode to detect changes
  const initialMode = readMode();

  // Poll for user response
  const result = await pollForTextMessage(
    config.botToken,
    config.chatId,
    config.remoteTimeoutSeconds,
    () => readMode() !== initialMode
  );

  switch (result.type) {
    case "message": {
      // User sent continuation instruction
      await editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${message}\n\n\u25b6\ufe0f _Continuing..._`
      ).catch(() => {});

      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: result.text,
        })
      );
      return;
    }

    case "done":
      await editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${message}\n\n\u23f9\ufe0f _Stopped_`
      ).catch(() => {});
      break;

    case "timeout":
      await editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${message}\n\n\u23f1\ufe0f _Timed out_`
      ).catch(() => {});
      break;

    case "abort":
      await editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${message}\n\n\ud83d\udda5\ufe0f _Switched to terminal_`
      ).catch(() => {});
      break;
  }

  process.stdout.write(PASS_THROUGH);
}

main().catch((err) => {
  process.stderr.write(`cctg stop-hook error: ${err.message}\n`);
  process.stdout.write(PASS_THROUGH);
});
