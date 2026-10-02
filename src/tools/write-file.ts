import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInRoot } from "../sandbox";
import { defineTool } from "./tool";

export const writeFile = defineTool({
  name: "write_file",
  description:
    "Crea un fichero o sobrescribe uno existente con el contenido completo indicado. " +
    "Para cambios parciales en un fichero existente usa edit_file.",
  schema: z.object({
    path: z.string().describe("Ruta relativa a la raíz del proyecto"),
    content: z.string().describe("Contenido completo del fichero"),
  }),
  readOnly: false,
  summarize: ({ path, content }) => `${path} (${content.split("\n").length} líneas)`,
  async run({ path: requested, content }, { root }) {
    const target = resolveInRoot(root, requested);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, content);
    return `Escrito ${requested} (${content.length} caracteres)`;
  },
});
