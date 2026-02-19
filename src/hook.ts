import { loadConfig } from "./config.js";
import {
  sendPermissionRequest,
  pollForDecision,
  editMessage,
} from "./telegram.js";
import { formatToolCall, parseHookStdin } from "./format.js";
import { randomBytes } from "node:crypto";

async function main() {
  // Read hook payload from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const payload = parseHookStdin(input);
  const config = loadConfig();

  // Check auto-approve list
  if (config.autoApprove.includes(payload.tool_name)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      })
    );
    return;
  }

  // Check auto-deny list
  if (config.autoDeny.includes(payload.tool_name)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
        },
        systemMessage: `Tool ${payload.tool_name} is auto-denied by cctg config.`,
      })
    );
    return;
  }

  // Generate unique request ID
  const requestId = randomBytes(8).toString("hex");

  // Send permission request to Telegram
  const message = formatToolCall(payload);
  const messageId = await sendPermissionRequest(
    config.botToken,
    config.chatId,
    message,
    requestId
  );

  // Wait for response
  const decision = await pollForDecision(
    config.botToken,
    config.chatId,
    requestId,
    config.timeoutSeconds
  );

  // Update the Telegram message to show the decision
  const statusIcon = decision === "allow" ? "\u2705" : "\u274c";
  const statusText = decision === "allow" ? "Allowed" : "Denied";
  await editMessage(
    config.botToken,
    config.chatId,
    messageId,
    `${message}\n\n${statusIcon} ${statusText}`
  ).catch(() => {}); // Non-critical

  // Output decision to Claude Code
  const result = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
    },
    ...(decision === "deny" && {
      systemMessage: "User denied this tool call via Telegram.",
    }),
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  // On any error, fail-closed (deny)
  process.stderr.write(`cctg error: ${err.message}\n`);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
      systemMessage: `cctg hook error: ${err.message}. Denying for safety.`,
    })
  );
});
