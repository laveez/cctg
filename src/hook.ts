import { loadConfig, getMode } from "./config.js";
import {
  sendPermissionRequest,
  pollForDecision,
  editMessage,
  flushStaleUpdates,
} from "./telegram.js";
import { formatToolCall, parseHookStdin } from "./format.js";
import { isToolAllowed } from "./permissions.js";
import { randomBytes } from "node:crypto";

const PASS_THROUGH = JSON.stringify({});

async function main() {
  // Read hook payload from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const payload = parseHookStdin(input);

  // 1. Toggle check — if cctg is off, pass through (normal CLI prompts)
  if (getMode() === "off") {
    process.stdout.write(PASS_THROUGH);
    return;
  }

  // 2. Permission check — if tool is already allowed in settings.json, pass through
  if (isToolAllowed(payload.tool_name, payload.tool_input)) {
    process.stdout.write(PASS_THROUGH);
    return;
  }

  const config = loadConfig();

  // 3. Check auto-approve list (cctg config)
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

  // 4. Check auto-deny list (cctg config)
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

  // 5. Flush stale updates before sending new request
  await flushStaleUpdates(config.botToken);

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
