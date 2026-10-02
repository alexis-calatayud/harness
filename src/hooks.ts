import path from "node:path";
import { z } from "zod";
import { exec, formatExec } from "./exec";
import type { ToolContext } from "./tools/tool";
import { dim, green, line, yellow } from "./ui";

export type HookPhase = "beforeTool" | "afterTool";

/** Lo que recibe un hook. `output` solo existe en afterTool. */
export interface ToolEvent {
  tool: string;
  input: unknown;
  output?: string;
}

/**
 * Un hook se ejecuta antes o después de una herramienta. Devuelve undefined si
 * todo va bien, o un mensaje para el modelo:
 * - en beforeTool, el mensaje bloquea la herramienta (vuelve como is_error);
 * - en afterTool, el mensaje se añade al tool_result (p. ej. los errores de tsc).
 */
export interface Hook {
  name: string;
  /** Si no hay matcher, el hook aplica a todas las herramientas. */
  matcher?: RegExp;
  run(event: ToolEvent, ctx: ToolContext): Promise<string | undefined>;
}

export interface Hooks {
  beforeTool: Hook[];
  afterTool: Hook[];
}

export const noHooks: Hooks = { beforeTool: [], afterTool: [] };

/**
 * Ejecuta en orden los hooks que aplican a `event.tool` y devuelve los mensajes
 * juntos, o undefined si ninguno tiene nada que decir.
 *
 * En beforeTool se para en el primer bloqueo. Si un hook lanza una excepción,
 * cuenta como mensaje: en beforeTool eso bloquea (mejor fallar cerrado).
 */
export async function runHooks(
  phase: HookPhase,
  hooks: Hook[],
  event: ToolEvent,
  ctx: ToolContext,
): Promise<string | undefined> {
  const messages: string[] = [];
  for (const hook of hooks) {
    if (hook.matcher && !hook.matcher.test(event.tool)) continue;
    let message: string | undefined;
    try {
      message = await hook.run(event, ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      message = `El hook ha fallado: ${err instanceof Error ? err.message : String(err)}`;
    }
    line(dim(`  ⚙ ${phase} ${hook.name}`) + (message === undefined ? green(" ✓") : yellow(" ✗")));
    if (message === undefined) continue;
    messages.push(`[hook ${phase} "${hook.name}"]\n${message}`);
    if (phase === "beforeTool") break;
  }
  return messages.length ? messages.join("\n\n") : undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CommandHookConfig {
  name?: string;
  /** Regex sobre el nombre de la herramienta, anclada: "edit_file|write_file". */
  matcher?: string;
  command: string;
  timeout_ms?: number;
}

/**
 * Hook que ejecuta un comando de shell en la raíz del proyecto. Recibe el evento
 * como JSON por stdin ({ hook, tool, input, output? }) y en MINI_AGENT_HOOK /
 * MINI_AGENT_TOOL. Exit 0 = todo bien; otro código = su salida va al modelo.
 */
export function commandHook(phase: HookPhase, config: CommandHookConfig): Hook {
  return {
    name: config.name ?? config.command,
    matcher: config.matcher === undefined ? undefined : new RegExp(`^(?:${config.matcher})$`),
    async run(event, { root, signal }) {
      const result = await exec(config.command, {
        cwd: root,
        signal,
        timeoutMs: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        stdin: JSON.stringify({ hook: phase, ...event }),
        env: { MINI_AGENT_HOOK: phase, MINI_AGENT_TOOL: event.tool },
      });
      return result.exitCode === 0 ? undefined : formatExec(result);
    },
  };
}

export const HOOKS_FILE = ".mini-agent/hooks.json";

const hookConfigSchema = z.strictObject({
  name: z.string().optional(),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
});

const hooksFileSchema = z.strictObject({
  beforeTool: z.array(hookConfigSchema).default([]),
  afterTool: z.array(hookConfigSchema).default([]),
});

/**
 * Lee `.mini-agent/hooks.json` de la raíz. Se carga una sola vez al arrancar:
 * si el agente edita el fichero, el cambio no tiene efecto hasta reiniciar (y el
 * usuario ve la lista de hooks al arrancar). Lanza si el fichero no es válido.
 */
export async function loadHooks(root: string): Promise<Hooks> {
  const file = Bun.file(path.join(root, HOOKS_FILE));
  if (!(await file.exists())) return noHooks;

  const parsed = hooksFileSchema.safeParse(await file.json());
  if (!parsed.success) throw new Error(`${HOOKS_FILE} no es válido:\n${z.prettifyError(parsed.error)}`);
  return {
    beforeTool: parsed.data.beforeTool.map((h) => commandHook("beforeTool", h)),
    afterTool: parsed.data.afterTool.map((h) => commandHook("afterTool", h)),
  };
}
