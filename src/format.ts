import { readFileSync } from "node:fs";

export interface ToolInput {
  command?: string;
  file_path?: string;
  content?: string;
  new_string?: string;
  old_string?: string;
  url?: string;
  pattern?: string;
  query?: string;
  [key: string]: unknown;
}

export interface HookPayload {
  hook_event_name: string;
  tool_name: string;
  tool_input: ToolInput;
}

const TOOL_ICONS: Record<string, string> = {
  Bash: "\ud83d\udcbb",
  Write: "\u270f\ufe0f",
  Edit: "\u270f\ufe0f",
  Read: "\ud83d\udcc4",
  Glob: "\ud83d\udd0d",
  Grep: "\ud83d\udd0d",
  WebFetch: "\ud83c\udf10",
  WebSearch: "\ud83c\udf10",
  Task: "\ud83e\udde0",
  Skill: "\u2699\ufe0f",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

export function formatToolCall(payload: HookPayload): string {
  const { tool_name, tool_input } = payload;
  const icon = TOOL_ICONS[tool_name] ?? "\ud83d\udd27";
  const header = `${icon} *${tool_name}*`;
  const separator = "\u2500".repeat(20);

  let body: string;

  switch (tool_name) {
    case "Bash":
      body = `\`\`\`\n${truncate(tool_input.command ?? "(no command)", 500)}\n\`\`\``;
      break;
    case "Write":
      body = `File: \`${tool_input.file_path}\`\n\`\`\`\n${truncate(tool_input.content ?? "", 300)}\n\`\`\``;
      break;
    case "Edit":
      body = `File: \`${tool_input.file_path}\`\n\nOld:\n\`\`\`\n${truncate(tool_input.old_string ?? "", 200)}\n\`\`\`\nNew:\n\`\`\`\n${truncate(tool_input.new_string ?? "", 200)}\n\`\`\``;
      break;
    case "Read":
      body = `File: \`${tool_input.file_path}\``;
      break;
    case "WebFetch":
      body = `URL: ${tool_input.url}`;
      break;
    case "WebSearch":
      body = `Query: ${tool_input.query}`;
      break;
    case "Glob":
    case "Grep":
      body = `Pattern: \`${tool_input.pattern}\``;
      break;
    default: {
      const summary = JSON.stringify(tool_input, null, 2);
      body = `\`\`\`json\n${truncate(summary, 400)}\n\`\`\``;
    }
  }

  return `${header}\n${separator}\n${body}`;
}

export function parseHookStdin(raw: string): HookPayload {
  return JSON.parse(raw);
}

export interface StopHookPayload {
  session_id: string;
  transcript_path: string;
  stop_hook_active: boolean;
  hook_event_name: string;
}

export function formatStopMessage(lastMessage: string): string {
  const icon = "\ud83e\udd16"; // 🤖
  const header = `${icon} *Claude stopped*`;
  const separator = "\u2500".repeat(20);
  const body = truncate(lastMessage, 2000);
  const footer = "_Reply to continue \u00b7 /done to stop_";

  return `${header}\n${separator}\n${body}\n\n${footer}`;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  options: QuestionOption[];
}

export function formatQuestion(questions: Question[]): string {
  const icon = "\u2753"; // ❓
  const header = `${icon} *Claude is asking*`;
  const separator = "\u2500".repeat(20);

  const parts = questions.map((q) => {
    const optionLines = q.options
      .map((o, i) => `  ${i + 1}. *${o.label}* \u2014 ${o.description}`)
      .join("\n");
    return `${q.question}\n\n${optionLines}`;
  });

  return `${header}\n${separator}\n${parts.join("\n\n")}`;
}

export function extractLastAssistantMessage(transcriptPath: string): string {
  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "assistant" && entry.message?.content) {
        const textBlocks = entry.message.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text);
        if (textBlocks.length > 0) return textBlocks.join("\n");
      }
    } catch {
      continue;
    }
  }

  return "(no message)";
}
