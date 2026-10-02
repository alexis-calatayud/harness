import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTracker } from "../src/file-tracker";
import { editFile } from "../src/tools/edit-file";
import { readFile } from "../src/tools/read-file";
import type { ToolContext } from "../src/tools/tool";
import { writeFile } from "../src/tools/write-file";
import { endTurn, refusal, testAgent, toolResults, toolUse } from "./fake-client";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mini-agent-rbe-"));
  ctx = { root, signal: new AbortController().signal, files: new FileTracker() };
  // Un fichero que ya existía antes de que el agente empezara.
  await Bun.write(path.join(root, "a.txt"), "uno\ndos\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const contentOf = (p: string) => Bun.file(path.join(root, p)).text();

describe("read-before-edit", () => {
  test("edit_file sobre un fichero no leído falla y no lo toca", async () => {
    await expect(editFile.run({ path: "a.txt", old_string: "uno", new_string: "1" }, ctx)).rejects.toThrow("No has leído a.txt");
    expect(await contentOf("a.txt")).toBe("uno\ndos\n");
  });

  test("write_file sobre un fichero existente no leído falla y no lo toca", async () => {
    await expect(writeFile.run({ path: "a.txt", content: "nuevo" }, ctx)).rejects.toThrow("No has leído a.txt");
    expect(await contentOf("a.txt")).toBe("uno\ndos\n");
  });

  test("tras leerlo se puede editar, y seguir editando sin volver a leer", async () => {
    await readFile.run({ path: "a.txt" }, ctx);
    await editFile.run({ path: "a.txt", old_string: "uno", new_string: "1" }, ctx);
    await editFile.run({ path: "a.txt", old_string: "dos", new_string: "2" }, ctx);
    expect(await contentOf("a.txt")).toBe("1\n2\n");
  });

  test("una lectura parcial también cuenta", async () => {
    await readFile.run({ path: "a.txt", offset: 2, limit: 1 }, ctx);
    await editFile.run({ path: "a.txt", old_string: "uno", new_string: "1" }, ctx);
  });

  test("si otro proceso lo cambia, hay que volver a leerlo", async () => {
    await readFile.run({ path: "a.txt" }, ctx);
    await Bun.write(path.join(root, "a.txt"), "uno\ndos\ntres\n");
    await expect(editFile.run({ path: "a.txt", old_string: "uno", new_string: "1" }, ctx)).rejects.toThrow("ha cambiado");

    await readFile.run({ path: "a.txt" }, ctx);
    await editFile.run({ path: "a.txt", old_string: "uno", new_string: "1" }, ctx);
    expect(await contentOf("a.txt")).toBe("1\ndos\ntres\n");
  });

  test("crear un fichero nuevo no exige lectura, y después se puede editar", async () => {
    await writeFile.run({ path: "nuevo/b.txt", content: "hola" }, ctx);
    await editFile.run({ path: "nuevo/b.txt", old_string: "hola", new_string: "adiós" }, ctx);
    expect(await contentOf("nuevo/b.txt")).toBe("adiós");
  });

  test("distintas formas de escribir la ruta son el mismo fichero", async () => {
    await readFile.run({ path: "./a.txt" }, ctx);
    await editFile.run({ path: path.join(root, "a.txt"), old_string: "uno", new_string: "1" }, ctx);
  });
});

describe("read-before-edit en el bucle del agente", () => {
  test("/reset olvida lo leído", async () => {
    const agent = testAgent(
      [toolUse("read_file", { path: "a.txt" }), endTurn, toolUse("edit_file", { path: "a.txt", old_string: "uno", new_string: "1" }), endTurn],
      { root, tools: [readFile, editFile] },
    );
    const signal = new AbortController().signal;
    await agent.send("lee a.txt", signal);
    agent.reset();
    await agent.send("edita a.txt", signal);

    const [edit] = toolResults(agent);
    expect(edit!.is_error).toBe(true);
    expect(edit!.content).toContain("No has leído a.txt");
  });

  test("un turno descartado también descarta lo que se leyó en él", async () => {
    const agent = testAgent(
      [
        // Turno 1: lee el fichero y después el modelo rechaza → se descarta el turno entero.
        toolUse("read_file", { path: "a.txt" }),
        refusal,
        // Turno 2: el modelo ya no tiene el contenido en su contexto.
        toolUse("edit_file", { path: "a.txt", old_string: "uno", new_string: "1" }),
        endTurn,
      ],
      { root, tools: [readFile, editFile] },
    );
    const signal = new AbortController().signal;
    await agent.send("lee a.txt", signal);
    expect(agent.messages).toHaveLength(0);
    await agent.send("edita a.txt", signal);

    const [edit] = toolResults(agent);
    expect(edit!.is_error).toBe(true);
    expect(edit!.content).toContain("No has leído a.txt");
    expect(await contentOf("a.txt")).toBe("uno\ndos\n");
  });

  test("lo leído en turnos anteriores que sí se guardaron se mantiene", async () => {
    const agent = testAgent(
      [toolUse("read_file", { path: "a.txt" }), endTurn, toolUse("edit_file", { path: "a.txt", old_string: "uno", new_string: "1" }), endTurn],
      { root, tools: [readFile, editFile] },
    );
    const signal = new AbortController().signal;
    await agent.send("lee a.txt", signal);
    await agent.send("edita a.txt", signal);

    const [, edit] = toolResults(agent);
    expect(edit!.is_error).toBeUndefined();
    expect(await contentOf("a.txt")).toBe("1\ndos\n");
  });
});
