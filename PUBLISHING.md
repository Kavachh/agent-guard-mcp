# Publishing checklist

Placeholder username is `kavachh` — replace with your real personal GitHub username first:

```bash
grep -rl kavachh --exclude-dir=node_modules . | xargs sed -i '' 's/kavachh/YOUR_REAL_USERNAME/g'
go mod tidy && go build -o agent-guard-mcp . && npm test   # verify after rename
```

## 1. GitHub repo

```bash
gh auth login                # log in with your PERSONAL account
gh repo create agent-guard-mcp --public --source=. --push \
  --description "Git-aware safe file operations MCP server for AI agents"
```

## 2. First release (triggers binary builds)

```bash
git tag v0.2.0 && git push origin v0.2.0
# .github/workflows/release.yml builds darwin/linux/windows binaries
# and attaches them to the GitHub Release automatically
```

Users can then install via:
- `go install github.com/YOUR_REAL_USERNAME/agent-guard-mcp@latest`
- or download a binary from the Releases page

## 3. MCP Registry (registry.modelcontextprotocol.io)

```bash
brew install mcp-publisher            # or: go install github.com/modelcontextprotocol/registry/cmd/publisher@latest
mcp-publisher login github            # authenticates as your GitHub user
mcp-publisher publish                 # reads ./server.json
```

Note: the `io.github.YOUR_REAL_USERNAME/*` namespace is verified against your GitHub login,
so login and server.json name must match. Update the release-asset URL in server.json
if the version tag differs.

## 4. Community discovery

- PR adding the repo to https://github.com/punkpeye/awesome-mcp-servers (Files section)
- Add GitHub topics: `mcp`, `mcp-server`, `ai-agents`, `claude`, `copilot`, `git`

## 5. Optional extras

- Homebrew tap for `brew install`
- npm wrapper package so `npx agent-guard-mcp` works for Node users
