import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolInput } from "./format.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const LOCAL_SETTINGS_PATH = join(homedir(), ".claude", "settings.local.json");

function loadAllowRules(): string[] {
  const rules: string[] = [];
  for (const path of [SETTINGS_PATH, LOCAL_SETTINGS_PATH]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const allow = parsed?.permissions?.allow;
      if (Array.isArray(allow)) {
        rules.push(...allow);
      }
    } catch {
      // File missing or invalid — skip
    }
  }
  return rules;
}

function globMatch(pattern: string, value: string): boolean {
  // Simple glob: only support * as "match anything" and ** as recursive
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchBashRule(ruleArg: string, command: string): boolean {
  // Rule format: "prefix:*" — command must start with prefix
  if (ruleArg.endsWith(":*")) {
    const prefix = expandTilde(ruleArg.slice(0, -2));
    return command === prefix || command.startsWith(prefix + " ");
  }
  // Exact match (no wildcard)
  return command === expandTilde(ruleArg);
}

function expandTilde(s: string): string {
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  if (s === "~") return homedir();
  return s;
}

function matchPathRule(ruleArg: string, filePath: string): boolean {
  return globMatch(expandTilde(ruleArg), filePath);
}

function matchDomainRule(ruleArg: string, url: string): boolean {
  // Rule format: "domain:host"
  if (!ruleArg.startsWith("domain:")) return false;
  const domain = ruleArg.slice("domain:".length);
  try {
    const urlHost = new URL(url).hostname;
    return urlHost === domain || urlHost.endsWith("." + domain);
  } catch {
    return false;
  }
}

export function isToolAllowed(
  toolName: string,
  toolInput: ToolInput
): boolean {
  const rules = loadAllowRules();

  for (const rule of rules) {
    // Bare tool name: "Read", "Glob", "WebSearch", etc.
    if (rule === toolName) return true;

    // MCP tool name: "mcp__server__tool" — exact match
    if (rule.startsWith("mcp__") && rule === toolName) return true;

    // Parenthesized rules: "ToolName(arg)"
    const parenMatch = rule.match(/^(\w+)\((.+)\)$/);
    if (!parenMatch) continue;

    const [, ruleTool, ruleArg] = parenMatch;
    if (ruleTool !== toolName) continue;

    switch (toolName) {
      case "Bash": {
        const command = toolInput.command ?? "";
        if (matchBashRule(ruleArg, command)) return true;
        break;
      }
      case "Read":
      case "Write":
      case "Edit": {
        const filePath = toolInput.file_path ?? "";
        if (matchPathRule(ruleArg, filePath)) return true;
        break;
      }
      case "WebFetch": {
        const url = toolInput.url ?? "";
        if (matchDomainRule(ruleArg, url)) return true;
        break;
      }
      case "Skill": {
        // Rule: "Skill(name)" — match skill name from tool_input
        const skillName = (toolInput as Record<string, unknown>).skill as string ?? "";
        if (ruleArg === skillName) return true;
        break;
      }
      default:
        // Unrecognized rule format for this tool — skip (fail-safe)
        break;
    }
  }

  return false;
}
