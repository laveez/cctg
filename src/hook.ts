import { loadConfig, getMode } from "./config.js";
import {
  sendPermissionRequest,
  sendQuestionWithOptions,
  pollForDecision,
  editMessage,
  flushStaleUpdates,
} from "./telegram.js";
import { formatToolCall, formatQuestion, parseHookStdin, type Question } from "./format.js";
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
  const mode = getMode();
  if (mode === "off") {
    process.stdout.write(PASS_THROUGH);
    return;
  }

  // 2. Permission check — if tool is already allowed in settings.json, pass through
  if (isToolAllowed(payload.tool_name, payload.tool_input)) {
    process.stdout.write(PASS_THROUGH);
    return;
  }

  const config = loadConfig();

  // 2b. AskUserQuestion interception — only in "on" mode
  if (mode === "on" && payload.tool_name === "AskUserQuestion") {
    const questions = (payload.tool_input.questions ?? []) as Question[];
    if (questions.length > 0) {
      await flushStaleUpdates(config.botToken);

      const requestId = randomBytes(8).toString("hex");
      const message = formatQuestion(questions);

      // Build option buttons from first question's options
      const q = questions[0];
      const options = q.options.map((o, i) => ({
        label: o.label,
        callbackData: `opt${i}`,
      }));

      const messageId = await sendQuestionWithOptions(
        config.botToken,
        config.chatId,
        message,
        options,
        requestId
      );

      // Poll for selection (reuses pollForDecision which now returns any string)
      const decision = await pollForDecision(
        config.botToken,
        config.chatId,
        requestId,
        config.timeoutSeconds
      );

      const optIndex = parseInt(decision.replace("opt", ""), 10);
      const selectedOption = q.options[optIndex] ?? q.options[0];

      await editMessage(
        config.botToken,
        config.chatId,
        messageId,
        `${message}\n\n\u2705 Selected: *${selectedOption.label}*`
      ).catch(() => {});

      // Deny the tool call but inject the answer as context
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            additionalContext: `The user was asked "${q.question}" and selected: "${selectedOption.label}" (${selectedOption.description}). Proceed with this choice without asking again.`,
          },
        })
      );
      return;
    }
  }

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
