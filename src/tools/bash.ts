import { z } from "zod";
import { exec, formatExec } from "../exec";
import { defineTool } from "./tool";

const DEFAULT_TIMEOUT_MS = 120_000;

export const bash = defineTool({
  name: "bash",
  description:
    "Ejecuta un comando en bash con el directorio del proyecto como cwd. Devuelve stdout, stderr " +
    "y el código de salida. Úsalo para tests, git, instalar dependencias o listar ficheros. " +
    "Para leer, buscar o editar ficheros prefiere read_file, grep y edit_file. " +
    "Los comandos interactivos no funcionan.",
  schema: z.object({
    command: z.string().describe("Comando a ejecutar"),
    timeout_ms: z.number().int().min(1000).max(600_000).optional()
      .describe(`Timeout en ms (por defecto ${DEFAULT_TIMEOUT_MS})`),
  }),
  readOnly: false,
  summarize: ({ command }) => command,
  async run({ command, timeout_ms = DEFAULT_TIMEOUT_MS }, { root, signal }) {
    return formatExec(await exec(command, { cwd: root, signal, timeoutMs: timeout_ms }));
  },
});
