# cctg — Claude Code Telegram Gate

Approve or deny Claude Code's tool calls from your phone via Telegram.

When Claude Code wants to run a command, edit a file, or use any tool, cctg sends a permission request to your Telegram bot. You tap **Allow** or **Deny** — and Claude proceeds (or doesn't).

```
Claude Code                          You (phone)
    │                                    │
    ├─ wants to run `git push` ──┐       │
    │                            ▼       │
    │                       cctg hook    │
    │                            │       │
    │                            ├──▶ 💻 *Bash*                │
    │                            │    ────────────────────     │
    │                            │    git push origin main     │
    │                            │    [✅ Allow] [❌ Deny]      │
    │                            │                             │
    │                            ◀── you tap Allow ────────────┤
    │                            │                             │
    ◀── tool proceeds ──────────┘                             │
```

## How it works

cctg is a single Node.js script registered as a Claude Code [PreToolUse hook](https://docs.claude.com/en/docs/claude-code/hooks). Each time Claude wants to use a tool:

1. The hook script starts, reads the tool call details from stdin
2. Sends a Telegram message with inline **Allow** / **Deny** buttons
3. Long-polls Telegram for your response
4. Returns the decision to Claude Code via stdout
5. Exits

No daemon. No background process. No external dependencies beyond Node.js (which Claude Code already requires).

## Install

```bash
npm install -g cctg
```

## Setup

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Get your chat ID

1. Open [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send any message — it replies with your user ID

### 3. Run the setup wizard

```bash
cctg init
```

It will ask for your bot token and chat ID, then automatically register the hook in `~/.claude/settings.json`.

## Configuration

Config lives at `~/.cctg.json`:

```json
{
  "botToken": "123456:ABC-DEF...",
  "chatId": "987654321",
  "timeoutSeconds": 300,
  "autoApprove": [],
  "autoDeny": []
}
```

| Field | Description | Default |
|---|---|---|
| `botToken` | Telegram bot token from @BotFather | required |
| `chatId` | Your Telegram user ID | required |
| `timeoutSeconds` | Seconds to wait before auto-denying | `300` |
| `autoApprove` | Tool names to silently allow (e.g. `["Read", "Glob"]`) | `[]` |
| `autoDeny` | Tool names to silently deny | `[]` |

## Security

- **Fail-closed** — if anything goes wrong (timeout, network error, crash), the tool call is denied
- **Chat ID verification** — only responses from your configured Telegram user ID are accepted
- **Request ID matching** — each permission request has a unique ID, preventing replay attacks
- **No secrets in code** — bot token and chat ID live in `~/.cctg.json`, never in the repo
- **Polling mode** — no webhook server, no public URL, no ngrok needed

## License

MIT
