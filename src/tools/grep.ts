import { z } from "zod";
import { resolveInRoot } from "../sandbox";
import { defineTool, truncate } from "./tool";

const MAX_LINES = 200;

export const grep = defineTool({
  name: "grep",
  description:
    "Busca una expresión regular en los ficheros del proyecto (respeta .gitignore si hay ripgrep). " +
    `Devuelve líneas \`fichero:línea:contenido\`, máximo ${MAX_LINES}.`,
  schema: z.object({
    pattern: z.string().describe("Expresión regular"),
    path: z.string().optional().describe("Directorio o fichero donde buscar (por defecto, la raíz)"),
    glob: z.string().optional().describe('Filtro de ficheros, p. ej. "*.ts"'),
    ignore_case: z.boolean().optional(),
  }),
  readOnly: true,
  summarize: ({ pattern, path }) => `/${pattern}/ en ${path ?? "."}`,
  async run({ pattern, path = ".", glob, ignore_case }, { root, signal }) {
    const target = resolveInRoot(root, path);
    const rg = Bun.which("rg");
    const cmd = rg
      ? [rg, "--line-number", "--no-heading", "--color=never",
         ...(ignore_case ? ["-i"] : []), ...(glob ? ["--glob", glob] : []), "-e", pattern, target]
      : ["grep", "-rnE", "--exclude-dir=node_modules", "--exclude-dir=.git",
         ...(ignore_case ? ["-i"] : []), ...(glob ? [`--include=${glob}`] : []), "-e", pattern, target];

    const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", signal });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Código 1 = sin coincidencias; >1 = error real (regex inválida, etc.)
    if (code === 1) return "Sin coincidencias";
    if (code > 1) return `Error en la búsqueda: ${err.trim()}`;

    const lines = out.trimEnd().split("\n").map((l) => l.replace(root + "/", ""));
    const extra = lines.length > MAX_LINES ? `\n\n[${lines.length - MAX_LINES} coincidencias más; afina la búsqueda]` : "";
    return truncate(lines.slice(0, MAX_LINES).join("\n") + extra);
  },
});
