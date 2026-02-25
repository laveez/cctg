import { loadConfig, getMode } from "./config.js";
import {
  formatStopMessage,
  extractLastAssistantMessage,
  type StopHookPayload,
} from "./format.js";
import { connectToDaemon, sendRequest, waitForResponse } from "./daemon-client.js";
import { getSessionLabel } from "./session.js";
import { randomBytes } from "node:crypto";

const PASS_THROUGH = JSON.stringify({});

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

  // Connect to daemon and send stop request
  const socket = await connectToDaemon();
  const sessionLabel = getSessionLabel();
  const requestId = randomBytes(8).toString("hex");
  const message = formatStopMessage(lastMessage);

  sendRequest(socket, {
    type: "stop",
    requestId,
    message,
    sessionLabel,
    timeoutSeconds: config.remoteTimeoutSeconds,
  });

  const response = await waitForResponse(socket, (config.remoteTimeoutSeconds + 60) * 1000);
  socket.destroy();

  const resultType = (response.result as string) ?? "timeout";

  switch (resultType) {
    case "message":
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: response.text as string,
        })
      );
      return;

    case "done":
    case "timeout":
    case "abort":
    default:
      process.stdout.write(PASS_THROUGH);
  }
}

main().catch((err) => {
  process.stderr.write(`cctg stop-hook error: ${err.message}\n`);
  process.stdout.write(PASS_THROUGH);
});
