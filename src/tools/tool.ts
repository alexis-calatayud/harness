import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FileTracker } from "../file-tracker";

export interface ToolContext {
  /** Directorio raíz del proyecto: ninguna herramienta debe salir de aquí. */
  root: string;
  signal: AbortSignal;
  /** Qué versión de cada fichero conoce el modelo: no se modifica lo que no ha leído. */
  files: FileTracker;
}

/**
 * Contrato de una herramienta del harness. El schema de Zod es la única fuente
 * de verdad: de él sale el JSON Schema que ve el modelo y la validación en runtime.
 */
export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Las herramientas de solo lectura no piden permiso. */
  readOnly: boolean;
  /** Texto corto para mostrar en la UI y en la petición de permiso. */
  summarize(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodObject>(tool: AgentTool<S>): AgentTool {
  return tool as unknown as AgentTool;
}

export function toApiTool(tool: AgentTool): Anthropic.Beta.BetaTool {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.schema);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    // Con streaming, los inputs grandes (contenido de ficheros) llegan según se generan.
    // A cambio el servidor no valida el input: lo validamos nosotros con Zod.
    eager_input_streaming: true,
  };
}

/** Error esperado de una herramienta: se devuelve al modelo como is_error. */
export class ToolError extends Error {}

const MAX_OUTPUT_CHARS = 30_000;

/** Recorta salidas enormes para no reventar el contexto, avisando al modelo. */
export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - max} caracteres omitidos ...]\n\n${text.slice(-half)}`;
}
