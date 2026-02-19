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
