import { z } from "zod";
import { resolveInRoot } from "../sandbox";
import { defineTool, ToolError } from "./tool";

export const editFile = defineTool({
  name: "edit_file",
  description:
    "Reemplaza un fragmento exacto de un fichero. `old_string` debe aparecer exactamente una vez " +
    "(incluye líneas de contexto para que sea único), salvo que uses replace_all. " +
    "Respeta la indentación exacta y no incluyas los números de línea de read_file.",
  schema: z.object({
    path: z.string().describe("Ruta relativa a la raíz del proyecto"),
    old_string: z.string().min(1).describe("Texto exacto a reemplazar"),
    new_string: z.string().describe("Texto nuevo"),
    replace_all: z.boolean().optional().describe("Reemplazar todas las apariciones"),
  }),
  readOnly: false,
  summarize: ({ path }) => path,
  async run({ path, old_string, new_string, replace_all = false }, { root }) {
    if (old_string === new_string) throw new ToolError("old_string y new_string son idénticos");

    const file = Bun.file(resolveInRoot(root, path));
    if (!(await file.exists())) throw new ToolError(`No existe el fichero: ${path}`);
    const original = await file.text();

    const count = original.split(old_string).length - 1;
    if (count === 0) {
      throw new ToolError("old_string no aparece en el fichero. Vuelve a leerlo y copia el texto exacto.");
    }
    if (count > 1 && !replace_all) {
      throw new ToolError(
        `old_string aparece ${count} veces. Añade contexto para que sea único o usa replace_all.`,
      );
    }

    // Reemplazo con función: con un string, `$&` y similares se interpretarían como patrones.
    const updated = replace_all
      ? original.replaceAll(old_string, () => new_string)
      : original.replace(old_string, () => new_string);
    await Bun.write(file, updated);
    return `Editado ${path} (${replace_all ? count : 1} reemplazo${count > 1 && replace_all ? "s" : ""})`;
  },
});
