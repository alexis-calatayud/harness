import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { Permissions } from "./permissions";
import { type AgentTool, type ToolContext, ToolError, toApiTool } from "./tools/tool";
import { cyan, dim, line, red, write, yellow } from "./ui";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface AgentOptions {
  client: Anthropic;
  tools: AgentTool[];
  permissions: Permissions;
  root: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Límite de vueltas (llamadas al modelo) por cada mensaje del usuario. */
  maxTurns: number;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const MAX_JSON_RETRIES = 2;

export class Agent {
  readonly messages: MessageParam[] = [];
  readonly usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly apiTools: Anthropic.Beta.BetaTool[];
  private readonly system: string;

  constructor(private readonly opts: AgentOptions) {
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
    this.apiTools = opts.tools.map(toApiTool);
    this.system = buildSystemPrompt(opts.root);
  }

  reset() {
    this.messages.length = 0;
  }

  /**
   * Ejecuta un turno completo del usuario: llama al modelo, ejecuta herramientas
   * y repite hasta que el modelo termina o se alcanza maxTurns.
   *
   * El historial es append-only: si el turno falla o se aborta, se recorta hasta
   * el estado anterior (eliminar la cola mantiene intacto el prefijo cacheado).
   */
  async send(userText: string, signal: AbortSignal): Promise<void> {
    const checkpoint = this.messages.length;
    this.messages.push({ role: "user", content: userText });

    try {
      for (let turn = 0; turn < this.opts.maxTurns; turn++) {
        const message = await this.callModel(signal);
        this.trackUsage(message);

        switch (message.stop_reason) {
          case "end_turn":
          case "stop_sequence":
            this.messages.push({ role: "assistant", content: message.content });
            return;

          case "pause_turn": // solo con herramientas de servidor; se reenvía para continuar
            this.messages.push({ role: "assistant", content: message.content });
            continue;

          case "refusal":
            // Incluso con fallbacks, toda la cadena ha rechazado. Un tool_use podría
            // estar cortado, así que no se ejecuta nada y se descarta el turno.
            line(red(`\n✗ Rechazado (${message.stop_details?.category ?? "sin categoría"}). Se descarta el turno.`));
            this.messages.length = checkpoint;
            return;

          case "max_tokens":
            if (message.content.some((b) => b.type === "tool_use")) {
              // Un input truncado suele parsear como objeto parcial válido: no ejecutarlo nunca.
              throw new Error("Input de herramienta truncado por max_tokens");
            }
            this.messages.push({ role: "assistant", content: message.content });
            line(yellow("\n⚠ Respuesta cortada por max_tokens"));
            return;

          case "tool_use": {
            this.messages.push({ role: "assistant", content: message.content });
            const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
            const results = await this.runTools(toolUses, signal);
            // Todos los tool_result en un único mensaje user (si no, el modelo deja de paralelizar).
            this.messages.push({ role: "user", content: results });
            continue;
          }

          default:
            this.messages.push({ role: "assistant", content: message.content });
            line(yellow(`\n⚠ stop_reason inesperado: ${message.stop_reason}`));
            return;
        }
      }
      line(yellow(`\n⚠ Alcanzado el límite de ${this.opts.maxTurns} vueltas. Escribe "continúa" para seguir.`));
    } catch (err) {
      this.messages.length = checkpoint;
      throw err;
    }
  }

  private async callModel(signal: AbortSignal): Promise<Message> {
    for (let attempt = 0; ; attempt++) {
      const stream = this.opts.client.beta.messages.stream(
        {
          model: this.opts.model,
          max_tokens: 64_000,
          system: this.system,
          tools: this.apiTools,
          messages: this.messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: this.opts.effort },
          // Caché automática: marca el último bloque cacheable en cada petición,
          // así cada vuelta reutiliza todo el historial anterior.
          cache_control: { type: "ephemeral" },
          // Si un clasificador rechaza, el servidor reintenta en el modelo recomendado.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      renderStream(stream);

      try {
        return await stream.finalMessage();
      } catch (err) {
        // Con eager_input_streaming el SDK puede fallar al parsear el JSON de un input.
        // Solo eso se reintenta; los errores de API (auth, rate limit...) y el abort se propagan.
        if (err instanceof Anthropic.APIError || signal.aborted || attempt >= MAX_JSON_RETRIES) throw err;
        line(yellow(`\n⚠ Input de herramienta no parseable, reintentando (${attempt + 1}/${MAX_JSON_RETRIES})`));
      }
    }
  }

  private async runTools(toolUses: ToolUse[], signal: AbortSignal): Promise<ToolResult[]> {
    const ctx: ToolContext = { root: this.opts.root, signal };

    // Fase 1 (secuencial): validar y pedir permisos, para no mezclar preguntas en la terminal.
    const planned = [];
    for (const use of toolUses) {
      const tool = this.toolsByName.get(use.name);
      if (!tool) {
        planned.push({ use, error: `Herramienta desconocida: ${use.name}` });
        continue;
      }
      const parsed = tool.schema.safeParse(use.input);
      if (!parsed.success) {
        planned.push({ use, error: `Input inválido: ${parsed.error.message}\nRecibido: ${JSON.stringify(use.input)}` });
        continue;
      }
      const summary = tool.summarize(parsed.data);
      line(cyan(`\n→ ${tool.name}`) + dim(` ${summary}`));
      const decision = await this.opts.permissions.check(tool, summary);
      if (!decision.allowed) {
        planned.push({ use, error: decision.reason });
        continue;
      }
      planned.push({ use, run: () => tool.run(parsed.data, ctx) });
    }

    // Fase 2 (en paralelo): ejecutar lo aprobado.
    return Promise.all(
      planned.map(async (p): Promise<ToolResult> => {
        if ("error" in p) return { type: "tool_result", tool_use_id: p.use.id, is_error: true, content: p.error };
        try {
          const content = await p.run!();
          return { type: "tool_result", tool_use_id: p.use.id, content };
        } catch (err) {
          if (signal.aborted) throw err;
          // Los errores de herramienta vuelven al modelo para que se corrija; no rompen el bucle.
          const msg = err instanceof ToolError ? err.message : `Error inesperado: ${String(err)}`;
          line(red(`  ✗ ${msg}`));
          return { type: "tool_result", tool_use_id: p.use.id, is_error: true, content: msg };
        }
      }),
    );
  }

  private trackUsage(message: Message) {
    const u = message.usage;
    this.usage.input += u.input_tokens;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.usage.output += u.output_tokens;
    for (const block of message.content) {
      if (block.type === "fallback") line(yellow(`\n↪ ${block.from.model} rechazó; continúa ${block.to.model}`));
    }
  }
}

function renderStream(stream: BetaMessageStream) {
  let current: string | undefined;
  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start") {
      const type = event.content_block.type;
      if (type === "thinking" && current !== "thinking") write(dim("\n💭 "));
      if (type === "text" && current !== undefined) write("\n");
      current = type;
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "thinking_delta") write(dim(event.delta.thinking));
      if (event.delta.type === "text_delta") write(event.delta.text);
    } else if (event.type === "message_stop") {
      if (current === "text") write("\n");
    }
  });
}

function buildSystemPrompt(root: string): string {
  // Sin fechas ni nada volátil: el system prompt es el prefijo de la caché.
  return `Eres un agente de programación que trabaja en la terminal del usuario.

Directorio del proyecto: ${root}
Plataforma: ${process.platform}

Trabajas con las herramientas disponibles sobre los ficheros de ese directorio; no puedes salir de él.
- Explora antes de cambiar nada: busca con grep, lee los ficheros relevantes.
- Lee un fichero antes de editarlo. Prefiere edit_file a reescribir ficheros enteros.
- Después de cambiar código, verifícalo (tests, typecheck o ejecutándolo) si es posible.
- Si una herramienta falla, lee el error y corrige el enfoque en lugar de repetir lo mismo.
- Si el usuario deniega una acción, no la reintentes: pregunta cómo quiere seguir.
- Responde en el idioma del usuario, de forma concisa. Al terminar, resume lo que has hecho.`;
}
