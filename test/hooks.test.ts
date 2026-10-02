import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent";
import { commandHook, HOOKS_FILE, type Hooks, loadHooks, noHooks, runHooks } from "../src/hooks";
import { Permissions } from "../src/permissions";
import type { ToolContext } from "../src/tools/tool";
import { writeFile } from "../src/tools/write-file";

type Message = Anthropic.Beta.BetaMessage;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mini-agent-hooks-"));
  ctx = { root, signal: new AbortController().signal };
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Cliente falso: cada llamada al modelo devuelve la siguiente respuesta de la lista. */
function fakeClient(responses: Pick<Message, "stop_reason" | "content">[]): Anthropic {
  let i = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const stream = () => ({ on() {}, finalMessage: async () => ({ ...responses[i++], usage }) });
  return { beta: { messages: { stream } } } as unknown as Anthropic;
}

/** Simula: el modelo pide write_file y después termina. Devuelve el tool_result enviado. */
async function runWriteTurn(hooks: Hooks): Promise<ToolResult> {
  const agent = new Agent({
    client: fakeClient([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "a.ts", content: "x" } }],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "hecho", citations: null }] },
    ] as Pick<Message, "stop_reason" | "content">[]),
    tools: [writeFile],
    permissions: new Permissions("yolo", async () => "s"),
    hooks,
    root,
    model: "test",
    effort: "low",
    maxTurns: 5,
  });
  await agent.send("escribe a.ts", new AbortController().signal);
  // [user, assistant(tool_use), user(tool_result), assistant(end_turn)]
  const results = agent.messages[2]!.content as ToolResult[];
  return results[0]!;
}

describe("commandHook", () => {
  test("exit 0 no devuelve mensaje; otro código devuelve su salida", async () => {
    const ok = commandHook("afterTool", { command: "echo todo bien" });
    expect(await ok.run({ tool: "x", input: {} }, ctx)).toBeUndefined();

    const bad = commandHook("afterTool", { command: "echo 'error TS2322' >&2; exit 2" });
    const msg = await bad.run({ tool: "x", input: {} }, ctx);
    expect(msg).toContain("exit code: 2");
    expect(msg).toContain("error TS2322");
  });

  test("recibe el evento por stdin y variables de entorno", async () => {
    const hook = commandHook("afterTool", { command: 'cat > event.json; echo "$MINI_AGENT_HOOK $MINI_AGENT_TOOL" > env.txt' });
    await hook.run({ tool: "edit_file", input: { path: "a.ts" }, output: "Editado" }, ctx);
    expect(await Bun.file(path.join(root, "event.json")).json()).toEqual({
      hook: "afterTool",
      tool: "edit_file",
      input: { path: "a.ts" },
      output: "Editado",
    });
    expect((await Bun.file(path.join(root, "env.txt")).text()).trim()).toBe("afterTool edit_file");
  });

  test("el matcher está anclado al nombre completo", () => {
    const hook = commandHook("afterTool", { command: "true", matcher: "edit_file|write_file" });
    expect(hook.matcher!.test("write_file")).toBe(true);
    expect(hook.matcher!.test("write_file_2")).toBe(false);
    expect(hook.matcher!.test("bash")).toBe(false);
  });
});

describe("paths", () => {
  const event = (p?: unknown) => ({ tool: "write_file", input: p === undefined ? {} : { path: p } });
  const hooks = [commandHook("afterTool", { matcher: "write_file", paths: "**/*.ts", command: "exit 1" })];

  test.each(["a.ts", "src/a.ts", "./src/a.ts"])("aplica a %s", async (p) => {
    expect(await runHooks("afterTool", hooks, event(p), ctx)).toContain("exit code: 1");
  });

  test.each(["README.md", "src/a.ts.md", "../fuera.ts"])("no aplica a %s", async (p) => {
    expect(await runHooks("afterTool", hooks, event(p), ctx)).toBeUndefined();
  });

  test("acepta rutas absolutas dentro de la raíz", async () => {
    expect(await runHooks("afterTool", hooks, event(path.join(root, "src/a.ts")), ctx)).toContain("exit code: 1");
  });

  test("no aplica a herramientas sin path", async () => {
    expect(await runHooks("afterTool", hooks, event(), ctx)).toBeUndefined();
  });
});

describe("loadHooks", () => {
  test("sin fichero no hay hooks", async () => {
    expect(await loadHooks(root)).toEqual(noHooks);
  });

  test("lee el fichero de configuración", async () => {
    await mkdir(path.join(root, ".mini-agent"));
    await Bun.write(path.join(root, HOOKS_FILE), JSON.stringify({
      afterTool: [{ name: "typecheck", matcher: "edit_file|write_file", paths: "**/*.ts", command: "bun run typecheck" }],
    }));
    const hooks = await loadHooks(root);
    expect(hooks.beforeTool).toHaveLength(0);
    expect(hooks.afterTool.map((h) => h.name)).toEqual(["typecheck"]);
    expect(hooks.afterTool[0]!.paths!.match("src/a.ts")).toBe(true);
  });

  test("rechaza claves desconocidas", async () => {
    await mkdir(path.join(root, ".mini-agent"));
    await Bun.write(path.join(root, HOOKS_FILE), JSON.stringify({ afterTools: [] }));
    await expect(loadHooks(root)).rejects.toThrow("no es válido");
  });
});

describe("hooks en el bucle del agente", () => {
  test("afterTool añade su salida al tool_result sin marcarlo como error", async () => {
    const result = await runWriteTurn({
      beforeTool: [],
      afterTool: [commandHook("afterTool", { name: "tsc", command: "echo 'a.ts(1,1): error TS1005' ; exit 2" })],
    });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Escrito a.ts");
    expect(result.content).toContain('[hook afterTool "tsc"]');
    expect(result.content).toContain("error TS1005");
  });

  test("beforeTool bloquea: no se ejecuta y vuelve como is_error", async () => {
    const result = await runWriteTurn({
      beforeTool: [commandHook("beforeTool", { matcher: "write_file", command: "echo 'prohibido escribir'; exit 1" })],
      afterTool: [],
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("prohibido escribir");
    expect(await Bun.file(path.join(root, "a.ts")).exists()).toBe(false);
  });

  test("un hook que lanza una excepción bloquea (falla cerrado)", async () => {
    const result = await runWriteTurn({
      beforeTool: [{ name: "roto", run: async () => { throw new Error("boom"); } }],
      afterTool: [],
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("boom");
  });
});
