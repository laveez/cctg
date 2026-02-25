import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";

export function getSessionLabel(): string {
  const renamed = process.env.CLAUDE_SESSION_NAME;
  if (renamed) return renamed;

  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const repo = basename(root);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const cwd = process.cwd();
    if (cwd !== root && cwd.includes(".worktrees/")) {
      const worktreeName = cwd.split(".worktrees/")[1]?.split("/")[0];
      if (worktreeName) return `${repo}/.worktrees/${worktreeName}`;
    }

    return branch === "HEAD" ? repo : `${repo}/${branch}`;
  } catch {
    // Not a git repo
  }

  const cwd = process.cwd();
  const home = homedir();
  if (cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}
