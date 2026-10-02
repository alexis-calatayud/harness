import type { AgentTool } from "./tools/tool";
import { yellow } from "./ui";

export type Ask = (question: string) => Promise<string>;
export type Decision = { allowed: true } | { allowed: false; reason: string };

/**
 * Política de permisos:
 * - herramientas readOnly: siempre permitidas
 * - modo "yolo": todo permitido
 * - modo "ask": pregunta al usuario; "a" recuerda la decisión para esa herramienta
 */
export class Permissions {
  private alwaysAllowed = new Set<string>();

  constructor(
    private mode: "ask" | "yolo",
    private ask: Ask,
  ) {}

  async check(tool: AgentTool, summary: string): Promise<Decision> {
    if (tool.readOnly || this.mode === "yolo" || this.alwaysAllowed.has(tool.name)) {
      return { allowed: true };
    }
    const answer = (await this.ask(yellow(`  ¿Permitir ${tool.name}: ${summary}? [s]í / [n]o / [a]lways > `)))
      .trim()
      .toLowerCase();
    if (answer === "a") {
      this.alwaysAllowed.add(tool.name);
      return { allowed: true };
    }
    if (answer === "s" || answer === "y" || answer === "") return { allowed: true };
    return { allowed: false, reason: "El usuario ha denegado esta acción. Pregúntale cómo quiere continuar." };
  }
}
