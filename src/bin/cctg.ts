#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../config.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

async function init() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\ncctg — Claude Code Telegram Gate\n");
  console.log(
    "This will set up a Telegram bot to approve Claude's tool calls.\n"
  );
  console.log("Prerequisites:");
  console.log("  1. Create a bot via @BotFather on Telegram");
  console.log("  2. Send /start to your new bot");
  console.log("  3. Get your chat ID (send a message to @userinfobot)\n");

  const botToken = await rl.question("Bot token: ");
  const chatId = await rl.question("Your Telegram chat ID: ");
  const timeoutStr = await rl.question("Timeout in seconds (default 300): ");
  const timeoutSeconds = parseInt(timeoutStr) || 300;

  rl.close();

  // Write config
  const config = {
    botToken: botToken.trim(),
    chatId: chatId.trim(),
    timeoutSeconds,
    autoApprove: [],
    autoDeny: [],
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n\u2705 Config written to ${CONFIG_PATH}`);

  // Determine hook command path
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const hookPath = join(__dirname, "..", "hook.js");

  // Register hook in settings.json
  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const hookEntry = {
    hooks: [
      {
        type: "command" as const,
        command: `node ${hookPath}`,
        timeout: Math.max(timeoutSeconds + 30, 600),
      },
    ],
  };

  // Add to PreToolUse hooks (don't overwrite existing)
  const preToolUse = (hooks.PreToolUse ?? []) as unknown[];
  const alreadyInstalled = preToolUse.some((h) =>
    JSON.stringify(h).includes("cctg")
  );

  if (!alreadyInstalled) {
    preToolUse.push(hookEntry);
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    console.log(`\u2705 Hook registered in ${SETTINGS_PATH}`);
  } else {
    console.log(`\u2139\ufe0f Hook already registered in ${SETTINGS_PATH}`);
  }

  console.log(
    "\n\ud83c\udf89 Setup complete! Claude Code will now send permission requests to Telegram.\n"
  );
}

const command = process.argv[2];

if (command === "init") {
  init().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  console.log("Usage: cctg init");
  console.log(
    "  init  \u2014 Set up Telegram bot and register Claude Code hook"
  );
}
