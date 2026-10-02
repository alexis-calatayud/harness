import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTracker } from "../src/file-tracker";
import { resolveInRoot } from "../src/sandbox";
import { bash } from "../src/tools/bash";
import { editFile } from "../src/tools/edit-file";
import { grep } from "../src/tools/grep";
import { readFile } from "../src/tools/read-file";
import { type ToolContext, toApiTool } from "../src/tools/tool";
import { writeFile } from "../src/tools/write-file";

let root: string;
let ctx: ToolContext;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mini-agent-"));
  ctx = { root, signal: new AbortController().signal, files: new FileTracker() };
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("sandbox", () => {
  test("permite rutas dentro de root", () => {
    expect(resolveInRoot(root, "src/a.ts")).toEndWith("/src/a.ts");
  });
  test("rechaza .. y rutas absolutas fuera", () => {
    expect(() => resolveInRoot(root, "../fuera.txt")).toThrow("fuera del directorio");
    expect(() => resolveInRoot(root, "/etc/passwd")).toThrow("fuera del directorio");
  });
  test("rechaza symlinks que apuntan fuera", async () => {
    await symlink(tmpdir(), path.join(root, "escape"));
    expect(() => resolveInRoot(root, "escape/x.txt")).toThrow("fuera del directorio");
  });
});

describe("herramientas", () => {
  test("write + read con números de línea", async () => {
    await writeFile.run({ path: "dir/hola.txt", content: "uno\ndos\ntres" }, ctx);
    expect(await readFile.run({ path: "dir/hola.txt" }, ctx)).toBe("1\tuno\n2\tdos\n3\ttres");
    expect(await readFile.run({ path: "dir/hola.txt", offset: 2, limit: 1 }, ctx)).toContain("2\tdos\n\n[1 líneas más");
  });

  test("edit exige old_string único", async () => {
    await writeFile.run({ path: "e.txt", content: "a b a" }, ctx);
    await expect(editFile.run({ path: "e.txt", old_string: "a", new_string: "x" }, ctx)).rejects.toThrow("2 veces");
    await editFile.run({ path: "e.txt", old_string: "a", new_string: "$&x", replace_all: true }, ctx);
    expect(await Bun.file(path.join(root, "e.txt")).text()).toBe("$&x b $&x");
  });

  test("edit falla si no encuentra el texto", async () => {
    await expect(editFile.run({ path: "e.txt", old_string: "zzz", new_string: "y" }, ctx)).rejects.toThrow("no aparece");
  });

  test("grep encuentra y reporta rutas relativas", async () => {
    const out = await grep.run({ pattern: "dos" }, ctx);
    // Línea exacta: con una raíz que pasa por un symlink (macOS: /var → /private/var) no debe quedar prefijo.
    expect(out.split("\n")).toContain("dir/hola.txt:2:dos");
    expect(await grep.run({ pattern: "nada-de-nada" }, ctx)).toBe("Sin coincidencias");
  });

  test("bash devuelve exit code y salidas", async () => {
    const out = await bash.run({ command: "echo hola; echo mal >&2; exit 3" }, ctx);
    expect(out).toContain("exit code: 3");
    expect(out).toContain("stdout:\nhola");
    expect(out).toContain("stderr:\nmal");
  });

  test("el JSON Schema generado no lleva $schema", () => {
    const api = toApiTool(editFile);
    expect(api.input_schema).not.toHaveProperty("$schema");
    expect(api.input_schema.required).toEqual(["path", "old_string", "new_string"]);
  });
});
