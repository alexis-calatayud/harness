import { describe, expect, test } from "bun:test";
import path from "node:path";
import { commandHook } from "../src/hooks";
import { check } from "../scripts/guard-bash";

describe("guard-bash", () => {
  test.each([
    "rm -rf dist",
    "cd src && rm old.ts",
    "sudo rm /tmp/x",
    "/bin/rm a",
    "find . -name '*.tmp' | xargs rm",
    "find . -name '*.log' -delete",
    "find . -name '*.tmp' -exec rm {} \\;",
    "find . -print0 | xargs -0 rm",
    "timeout 10 rm a",
    "FOO=1 rm a",
    "rmdir build",
    "unlink link",
    'bash -c "rm -rf node_modules"',
    "echo $(rm a)",
    "git push",
    "git push --force origin main",
    "git -C ../otro push",
    "git add . && git commit -m wip && git push",
    "git rm src/a.ts",
    "git clean -fdx",
    "git reset --hard HEAD~1",
    "git branch -D feature",
    "git branch --delete feature",
  ])("bloquea: %s", (command) => {
    expect(check(command)).toBeString();
  });

  test.each([
    "ls -la",
    "bun test",
    "bun run typecheck",
    "git status",
    "git diff --stat",
    "git log --oneline -5",
    "git add -A",
    'git commit -m "push y rm en el mensaje"',
    "git reset HEAD a.ts",
    "git branch -a",
    "git -C ../otro status",
    "grep -rn form src",
    "mkdir -p tmp/rmx",
    "echo rm",
    "grep -rn rm src",
    "bash -c 'bun test'",
  ])("permite: %s", (command) => {
    expect(check(command)).toBeUndefined();
  });
});

describe("guard-bash como hook", () => {
  const root = path.resolve(import.meta.dir, "..");
  const ctx = { root, signal: new AbortController().signal };
  const hook = commandHook("beforeTool", { matcher: "bash", command: "bun scripts/guard-bash.ts" });

  test("bloquea con un mensaje para el modelo", async () => {
    const msg = await hook.run({ tool: "bash", input: { command: "git push" } }, ctx);
    expect(msg).toContain("exit code: 1");
    expect(msg).toContain("git push");
    expect(msg).toContain("pídele que la ejecute él");
  });

  test("deja pasar los comandos permitidos", async () => {
    expect(await hook.run({ tool: "bash", input: { command: "bun test" } }, ctx)).toBeUndefined();
  });
});
