// agent-guard-mcp — MCP server for git-aware safe file operations.
//
// Principle: anything an AI agent builds can be freely deleted UNTIL it is
// tracked by a git repository. Tracked source files are protected.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func git(dir string, args ...string) (string, bool) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func expand(p string) string {
	if strings.HasPrefix(p, "~") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, p[1:])
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

// findNestedRepo walks dir looking for nested .git entries whose repo has tracked files.
func findNestedRepo(dir string) string {
	var hit string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || hit != "" {
			return filepath.SkipAll
		}
		if d.IsDir() && d.Name() == ".git" {
			repo := filepath.Dir(p)
			if tracked, ok := git(repo, "ls-files"); ok && tracked != "" {
				hit = repo
				return filepath.SkipAll
			}
			return filepath.SkipDir
		}
		return nil
	})
	return hit
}

type inspection struct {
	Path      string   `json:"path"`
	Exists    bool     `json:"exists"`
	Protected bool     `json:"protected"`
	Reason    string   `json:"reason"`
	Sample    []string `json:"sample,omitempty"`
}

func inspect(raw string) inspection {
	p := expand(raw)
	st, err := os.Lstat(p)
	if err != nil {
		return inspection{Path: p, Exists: false, Protected: false, Reason: "does not exist"}
	}

	if st.IsDir() {
		if inTree, _ := git(p, "rev-parse", "--is-inside-work-tree"); inTree == "true" {
			if tracked, ok := git(p, "ls-files"); ok && tracked != "" {
				lines := strings.Split(tracked, "\n")
				sample := lines
				if len(sample) > 5 {
					sample = sample[:5]
				}
				return inspection{Path: p, Exists: true, Protected: true,
					Reason: fmt.Sprintf("directory contains %d git-tracked file(s)", len(lines)),
					Sample: sample}
			}
		}
		if nested := findNestedRepo(p); nested != "" {
			return inspection{Path: p, Exists: true, Protected: true,
				Reason: "directory contains a nested git repository with tracked files: " + nested}
		}
		return inspection{Path: p, Exists: true, Protected: false, Reason: "directory contains no git-tracked files"}
	}

	parent, base := filepath.Dir(p), filepath.Base(p)
	if _, ok := git(parent, "ls-files", "--error-unmatch", base); ok {
		return inspection{Path: p, Exists: true, Protected: true, Reason: "git-tracked source file"}
	}
	return inspection{Path: p, Exists: true, Protected: false, Reason: "not tracked by git"}
}

// ---- tool inputs ----

type deleteInput struct {
	Paths  []string `json:"paths" jsonschema:"Files or directories to delete"`
	DryRun bool     `json:"dry_run,omitempty" jsonschema:"If true only report what would happen"`
}

type checkInput struct {
	Paths []string `json:"paths" jsonschema:"Files or directories to check"`
}

type statusInput struct {
	Directory string `json:"directory" jsonschema:"Directory to summarize"`
}

type deleteResult struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Reason string `json:"reason"`
	Hint   string `json:"hint,omitempty"`
}

func jsonText(v any) *mcp.CallToolResult {
	b, _ := json.MarshalIndent(v, "", "  ")
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}
}

func safeDelete(_ context.Context, _ *mcp.CallToolRequest, in deleteInput) (*mcp.CallToolResult, any, error) {
	results := make([]deleteResult, 0, len(in.Paths))
	blockedAny := false
	for _, raw := range in.Paths {
		info := inspect(raw)
		switch {
		case !info.Exists:
			results = append(results, deleteResult{info.Path, "skipped", "does not exist", ""})
		case info.Protected:
			blockedAny = true
			results = append(results, deleteResult{info.Path, "BLOCKED", info.Reason,
				"Use `git rm` deliberately if removal is truly intended."})
		case in.DryRun:
			results = append(results, deleteResult{info.Path, "would-delete", info.Reason, ""})
		default:
			if err := os.RemoveAll(info.Path); err != nil {
				results = append(results, deleteResult{info.Path, "error", err.Error(), ""})
			} else {
				results = append(results, deleteResult{info.Path, "deleted", info.Reason, ""})
			}
		}
	}
	return jsonText(map[string]any{"blocked_any": blockedAny, "results": results}), nil, nil
}

func checkProtection(_ context.Context, _ *mcp.CallToolRequest, in checkInput) (*mcp.CallToolResult, any, error) {
	results := make([]inspection, 0, len(in.Paths))
	for _, p := range in.Paths {
		results = append(results, inspect(p))
	}
	return jsonText(results), nil, nil
}

func guardStatus(_ context.Context, _ *mcp.CallToolRequest, in statusInput) (*mcp.CallToolResult, any, error) {
	dir := expand(in.Directory)
	if _, err := os.Stat(dir); err != nil {
		return jsonText(map[string]any{"directory": dir, "exists": false}), nil, nil
	}
	inTree, _ := git(dir, "rev-parse", "--is-inside-work-tree")
	inside := inTree == "true"
	var root string
	trackedCount, untrackedCount := 0, 0
	if inside {
		root, _ = git(dir, "rev-parse", "--show-toplevel")
		if t, ok := git(dir, "ls-files"); ok && t != "" {
			trackedCount = len(strings.Split(t, "\n"))
		}
		if u, ok := git(dir, "ls-files", "--others", "--exclude-standard"); ok && u != "" {
			untrackedCount = len(strings.Split(u, "\n"))
		}
	}
	return jsonText(map[string]any{
		"directory":                 dir,
		"inside_git_worktree":       inside,
		"repo_root":                 root,
		"protected_tracked_files":   trackedCount,
		"deletable_untracked_files": untrackedCount,
		"policy":                    "Tracked files are protected from deletion; everything else is deletable.",
	}), nil, nil
}

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "agent-guard", Version: "0.2.0"}, nil)

	mcp.AddTool(server, &mcp.Tool{
		Name: "safe_delete",
		Description: "Delete files or directories with a git-aware guard: refuses to delete " +
			"git-tracked source files or directories containing them (including nested repos). " +
			"Untracked files, build artifacts, and temp files are deleted freely. Use this instead of `rm`.",
	}, safeDelete)

	mcp.AddTool(server, &mcp.Tool{
		Name: "check_protection",
		Description: "Check whether paths are protected from deletion (git-tracked source code) " +
			"without deleting anything.",
	}, checkProtection)

	mcp.AddTool(server, &mcp.Tool{
		Name: "guard_status",
		Description: "Summarize guard state for a directory: whether it's inside a git work tree, " +
			"how many files are tracked (protected) vs untracked (deletable).",
	}, guardStatus)

	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}
