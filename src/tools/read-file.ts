import { z } from "zod";
import { resolveInRoot } from "../sandbox";
import { defineTool, ToolError, truncate } from "./tool";

const DEFAULT_LIMIT = 2000;

export const readFile = defineTool({
  name: "read_file",
  description:
    "Lee un fichero de texto del proyecto. Devuelve las líneas numeradas (formato `N\\tlínea`). " +
    `Por defecto lee hasta ${DEFAULT_LIMIT} líneas; usa offset/limit para ficheros grandes. ` +
    "Lee siempre un fichero antes de editarlo.",
  schema: z.object({
    path: z.string().describe("Ruta relativa a la raíz del proyecto"),
    offset: z.number().int().min(1).optional().describe("Línea inicial (1-indexed)"),
    limit: z.number().int().min(1).optional().describe("Número máximo de líneas"),
  }),
  readOnly: true,
  summarize: ({ path }) => path,
  async run({ path, offset = 1, limit = DEFAULT_LIMIT }, { root }) {
    const file = Bun.file(resolveInRoot(root, path));
    if (!(await file.exists())) throw new ToolError(`No existe el fichero: ${path}`);

    const lines = (await file.text()).split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
    const remaining = lines.length - (offset - 1 + slice.length);
    const footer = remaining > 0 ? `\n\n[${remaining} líneas más. Usa offset=${offset + slice.length}]` : "";
    return truncate(numbered + footer);
  },
});
