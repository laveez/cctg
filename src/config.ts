import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type CctgMode = "on" | "tools-only" | "off";

export interface CctgConfig {
  botToken: string;
  chatId: string;
  timeoutSeconds: number;
  remoteTimeoutSeconds: number;
  autoApprove: string[];
  autoDeny: string[];
}

export const CONFIG_PATH = join(homedir(), ".cctg.json");
export const ACTIVE_PATH = join(homedir(), ".cctg-active");

export function getMode(): CctgMode {
  try {
    const content = readFileSync(ACTIVE_PATH, "utf-8").trim();
    if (content === "on" || content === "tools-only") return content;
    // Legacy: any other content (e.g. old timestamp) treated as "on"
    return "on";
  } catch {
    return "off";
  }
}

export function loadConfig(): CctgConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    throw new Error(
      `Config not found at ${CONFIG_PATH}. Run 'cctg init' to set up.`
    );
  }

  const parsed = JSON.parse(raw);

  if (!parsed.botToken || !parsed.chatId) {
    throw new Error(
      `Config at ${CONFIG_PATH} missing required fields: botToken, chatId`
    );
  }

  return {
    botToken: parsed.botToken,
    chatId: String(parsed.chatId),
    timeoutSeconds: parsed.timeoutSeconds ?? 300,
    remoteTimeoutSeconds: parsed.remoteTimeoutSeconds ?? parsed.timeoutSeconds ?? 300,
    autoApprove: parsed.autoApprove ?? [],
    autoDeny: parsed.autoDeny ?? [],
  };
}
