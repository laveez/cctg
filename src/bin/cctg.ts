#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, ACTIVE_PATH } from "../config.js";

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

  // Determine hook command path (use $HOME for cross-machine portability)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const homeDir = homedir();
  const toPortable = (abs: string) =>
    abs.startsWith(homeDir) ? `$HOME${abs.slice(homeDir.length)}` : abs;
  const hookPath = toPortable(join(__dirname, "..", "hook.js"));

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
    console.log(`\u2705 PreToolUse hook registered in ${SETTINGS_PATH}`);
  } else {
    console.log(`\u2139\ufe0f PreToolUse hook already registered in ${SETTINGS_PATH}`);
  }

  // Register Stop hook
  const stopHookPath = toPortable(join(__dirname, "..", "stop-hook.js"));
  const stopHookEntry = {
    hooks: [
      {
        type: "command" as const,
        command: `node ${stopHookPath}`,
        timeout: Math.max(timeoutSeconds + 30, 600),
      },
    ],
  };

  const stopHooks = (hooks.Stop ?? []) as unknown[];
  const stopAlreadyInstalled = stopHooks.some((h) =>
    JSON.stringify(h).includes("cctg")
  );

  if (!stopAlreadyInstalled) {
    stopHooks.push(stopHookEntry);
    hooks.Stop = stopHooks;
    settings.hooks = hooks;
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    console.log(`\u2705 Stop hook registered in ${SETTINGS_PATH}`);
  }

  console.log(
    "\n\ud83c\udf89 Setup complete! Claude Code will now route through Telegram.\n"
  );
}

function on() {
  writeFileSync(ACTIVE_PATH, "on");
  console.log("\u2705 cctg ON — full remote control (tools + stop + questions via Telegram)");
}

function toolsOnly() {
  writeFileSync(ACTIVE_PATH, "tools-only");
  console.log("\u2705 cctg TOOLS-ONLY — tool approvals via Telegram, input at terminal");
}

function off() {
  try {
    unlinkSync(ACTIVE_PATH);
  } catch {
    // Already off
  }
  console.log("\u274c cctg disabled — tool calls use normal CLI prompts");
}

function status() {
  let mode = "OFF";
  try {
    const content = readFileSync(ACTIVE_PATH, "utf-8").trim();
    if (content === "on") mode = "ON (full remote)";
    else if (content === "tools-only") mode = "TOOLS-ONLY (tool approvals)";
    else mode = "ON (full remote)"; // Legacy timestamp
  } catch {
    mode = "OFF (CLI prompts)";
  }
  console.log(`cctg: ${mode}`);
}

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
    break;
  case "on":
    on();
    break;
  case "tools-only":
    toolsOnly();
    break;
  case "off":
    off();
    break;
  case "status":
    status();
    break;
  default:
    console.log("Usage: cctg <command>\n");
    console.log("Commands:");
    console.log("  init        \u2014 Set up Telegram bot and register hooks");
    console.log("  on          \u2014 Full remote control (going AFK)");
    console.log("  tools-only  \u2014 Tool approvals only (at keyboard)");
    console.log("  off         \u2014 Disable all Telegram control");
    console.log("  status      \u2014 Show current mode");
}
