# agent-guard-mcp

MCP server (written in **Go**, single static binary) for **git-aware safe file operations**. Give your AI agents (Claude Code, GitHub Copilot CLI, Cursor, …) free rein to delete what they build — while making it impossible for them to delete your git-tracked source code.

**Policy:** anything is deletable *until* it's tracked by a git repository.

## Tools

| Tool | Purpose |
|---|---|
| `safe_delete` | Delete files/dirs; refuses git-tracked files or dirs containing them. Supports `dry_run`. |
| `check_protection` | Report whether paths are protected and why. |
| `guard_status` | Summarize a directory: tracked (protected) vs untracked (deletable) counts. |

## Install

Build the single static binary (no runtime dependencies):
```bash
go build -o agent-guard-mcp .
```
Or install directly:
```bash
go install github.com/kavachh/agent-guard-mcp@latest
```

### Claude Code
```bash
claude mcp add agent-guard -- /path/to/agent-guard-mcp
```

### GitHub Copilot CLI
In `~/.copilot/mcp-config.json`:
```json
{
  "mcpServers": {
    "agent-guard": { "command": "/path/to/agent-guard-mcp", "args": [] }
  }
}
```

### Any MCP client (generic stdio config)
```json
{ "command": "/path/to/agent-guard-mcp", "args": [] }
```

## Recommended agent instructions

Add to your `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md`:

> Never use `rm` in the shell. Always delete files with the `safe_delete` MCP tool, which protects git-tracked source code.

Since `safe_delete` can never destroy tracked source, it is safe to auto-approve this server's tools in your client's permission settings.

## Example

```
safe_delete { "paths": ["build/", "scratch.txt"] }
→ deleted (untracked)

safe_delete { "paths": ["src/main/java/App.java"] }
→ BLOCKED: git-tracked source file — use `git rm` deliberately if intended
```

## Requirements

- `git` on PATH
- Go ≥ 1.24 (build only — the binary itself has zero dependencies)

## Testing

24-case edge suite (tracked/staged/ignored files, nested repos, symlinks, dry-run, …):
```bash
go build -o agent-guard-mcp . && npm test
```

