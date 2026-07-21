import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import fs from "node:fs";

const sh = (c) => execSync(c, { encoding: "utf8", shell: "/bin/bash" });
const F = "/tmp/mcp-edge";
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// ---------- fixture ----------
sh(`rm -rf ${F} && mkdir -p ${F}/repo/src ${F}/outside`);
sh(`cd ${F}/repo && git init -q && echo code > src/app.js && echo "ignored.log" > .gitignore && git add -A && git commit -qm init`);
sh(`echo temp > ${F}/repo/untracked.txt`);                 // untracked in repo
sh(`echo log > ${F}/repo/ignored.log`);                    // gitignored
sh(`echo staged > ${F}/repo/staged.txt && cd ${F}/repo && git add staged.txt`); // staged, uncommitted
sh(`echo modified >> ${F}/repo/src/app.js`);               // tracked + modified
sh(`mkdir -p ${F}/repo/build && echo out > ${F}/repo/build/o.txt`); // untracked dir in repo
sh(`echo plain > ${F}/outside/plain.txt`);                 // outside any repo
sh(`ln -s ${F}/repo/src/app.js ${F}/outside/link-to-tracked`); // symlink -> tracked
sh(`mkdir -p "${F}/outside/dir with spaces" && echo x > "${F}/outside/dir with spaces/f.txt"`);
sh(`mkdir -p ${F}/outside/wrapper/inner && cd ${F}/outside/wrapper/inner && git init -q && echo nested > n.js && git add . && git commit -qm i`); // nested repo inside plain dir
sh(`mkdir -p ${F}/outside/emptydir`);
sh(`cd ${F}/repo && echo uncache > uncached.txt && git add uncached.txt && git commit -qm c2 && git rm -q --cached uncached.txt`); // was tracked, now removed from index

// ---------- connect ----------
const CMD = process.env.GUARD_CMD || "./agent-guard-mcp"; // Go binary by default; set GUARD_CMD="node src/index.js" for JS
const [cmd, ...cmdArgs] = CMD.split(" ");
const t = new StdioClientTransport({ command: cmd, args: cmdArgs, cwd: process.cwd() });
const c = new Client({ name: "edge-test", version: "1.0" });
await c.connect(t);

const call = async (name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
const del = async (paths, dry) => (await call("safe_delete", { paths, dry_run: dry })).results;

// 1. untracked file in repo -> deleted
let r = await del([`${F}/repo/untracked.txt`]);
check("untracked file in repo deleted", r[0].status === "deleted" && !fs.existsSync(`${F}/repo/untracked.txt`));

// 2. gitignored file -> deleted
r = await del([`${F}/repo/ignored.log`]);
check("gitignored file deleted", r[0].status === "deleted");

// 3. tracked+modified file -> BLOCKED
r = await del([`${F}/repo/src/app.js`]);
check("tracked modified file blocked", r[0].status === "BLOCKED" && fs.existsSync(`${F}/repo/src/app.js`));

// 4. staged-but-uncommitted -> BLOCKED (in index)
r = await del([`${F}/repo/staged.txt`]);
check("staged uncommitted file blocked", r[0].status === "BLOCKED");

// 5. untracked dir inside repo -> deleted
r = await del([`${F}/repo/build`]);
check("untracked dir in repo deleted", r[0].status === "deleted" && !fs.existsSync(`${F}/repo/build`));

// 6. repo root -> BLOCKED
r = await del([`${F}/repo`]);
check("repo root blocked", r[0].status === "BLOCKED" && fs.existsSync(`${F}/repo/src/app.js`));

// 7. nonexistent path -> skipped
r = await del([`${F}/nope/missing.txt`]);
check("nonexistent path skipped", r[0].status === "skipped");

// 8. file outside any repo -> deleted
r = await del([`${F}/outside/plain.txt`]);
check("file outside repo deleted", r[0].status === "deleted");

// 9. symlink to tracked file -> symlink deletable, target survives
r = await del([`${F}/outside/link-to-tracked`]);
check("symlink deleted, tracked target survives", r[0].status === "deleted" && fs.existsSync(`${F}/repo/src/app.js`));

// 10. dir with spaces -> deleted
r = await del([`${F}/outside/dir with spaces`]);
check("dir with spaces deleted", r[0].status === "deleted");

// 11. plain dir CONTAINING a nested git repo with tracked files -> BLOCKED
r = await del([`${F}/outside/wrapper`]);
check("dir wrapping nested repo blocked", r[0].status === "BLOCKED" && fs.existsSync(`${F}/outside/wrapper/inner/n.js`));

// 12. empty dir -> deleted
r = await del([`${F}/outside/emptydir`]);
check("empty dir deleted", r[0].status === "deleted");

// 13. previously tracked, git rm --cached -> now deletable
r = await del([`${F}/repo/uncached.txt`]);
check("git rm --cached file deletable", r[0].status === "deleted");

// 14. dry_run deletes nothing
sh(`echo dry > ${F}/outside/dryfile.txt`);
r = await del([`${F}/outside/dryfile.txt`], true);
check("dry_run reports would-delete, file survives", r[0].status === "would-delete" && fs.existsSync(`${F}/outside/dryfile.txt`));

// 15. mixed batch: blocked + deletable in one call
sh(`echo mix > ${F}/outside/mix.txt`);
r = await del([`${F}/repo/src/app.js`, `${F}/outside/mix.txt`]);
check("mixed batch: tracked blocked, untracked deleted",
  r[0].status === "BLOCKED" && r[1].status === "deleted");

// 16. tilde expansion
sh(`mkdir -p ~/mcp-tilde-test && echo t > ~/mcp-tilde-test/f.txt`);
r = await del(["~/mcp-tilde-test"]);
check("tilde path expanded and deleted", r[0].status === "deleted" && !fs.existsSync(`${process.env.HOME}/mcp-tilde-test`));

// 17. check_protection accuracy
sh(`mkdir -p ${F}/outside/clean && echo c > ${F}/outside/clean/c.txt`);
let cp = await call("check_protection", { paths: [`${F}/repo/src/app.js`, `${F}/outside/clean`, `${F}/outside`] });
check("check_protection: tracked=protected", cp[0].protected === true);
check("check_protection: clean dir=unprotected", cp[1].protected === false);
check("check_protection: dir with nested repo=protected", cp[2].protected === true);

// 18. guard_status counts
sh(`echo new > ${F}/repo/newfile.txt`);
let gs = await call("guard_status", { directory: `${F}/repo` });
check("guard_status: tracked count >= 2", gs.protected_tracked_files >= 2);
check("guard_status: untracked count >= 1", gs.deletable_untracked_files >= 1);
gs = await call("guard_status", { directory: `${F}/outside` });
check("guard_status: outside not in worktree", gs.inside_git_worktree === false);

// 19. relative path (relative to server cwd = package dir)
sh(`echo rel > ./rel-test.txt`);
r = await del(["rel-test.txt"]);
check("relative path deleted", r[0].status === "deleted" && !fs.existsSync("rel-test.txt"));

// 20. blocked_any flag
let full = await call("safe_delete", { paths: [`${F}/repo/src/app.js`] });
check("blocked_any flag set", full.blocked_any === true);

sh(`rm -rf ${F}`);
await c.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
