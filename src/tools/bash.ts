import { z } from "zod";
import { defineTool, truncate } from "./tool";

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
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeout_ms,
      signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const parts = [`exit code: ${exitCode}${proc.signalCode ? ` (${proc.signalCode}, ¿timeout?)` : ""}`];
    if (stdout) parts.push(`stdout:\n${stdout}`);
    if (stderr) parts.push(`stderr:\n${stderr}`);
    return truncate(parts.join("\n\n"));
  },
});
