import type Anthropic from "@anthropic-ai/sdk";
import { Agent, type AgentOptions } from "../src/agent";
import { noHooks } from "../src/hooks";
import { Permissions } from "../src/permissions";

type Message = Anthropic.Beta.BetaMessage;
export type FakeResponse = Pick<Message, "stop_reason" | "content">;
export type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** Cliente falso: cada llamada al modelo devuelve la siguiente respuesta de la lista. */
export function fakeClient(responses: FakeResponse[]): Anthropic {
  let i = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const stream = () => ({
    on() {},
    finalMessage: async () => {
      const response = responses[i++];
      if (!response) throw new Error("El cliente falso no tiene más respuestas");
      return { ...response, usage, stop_details: null };
    },
  });
  return { beta: { messages: { stream } } } as unknown as Anthropic;
}

let nextId = 0;

/** Respuesta en la que el modelo pide una herramienta. */
export function toolUse(name: string, input: unknown): FakeResponse {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${++nextId}`, name, input }] } as FakeResponse;
}

export const endTurn: FakeResponse = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "hecho", citations: null }],
} as FakeResponse;

export const refusal: FakeResponse = { stop_reason: "refusal", content: [] } as FakeResponse;

/** Agente con permisos en modo yolo, sin hooks salvo que se indiquen, y el cliente falso. */
export function testAgent(
  responses: FakeResponse[],
  opts: Pick<AgentOptions, "root" | "tools"> & Partial<AgentOptions>,
): Agent {
  return new Agent({
    client: fakeClient(responses),
    permissions: new Permissions("yolo", async () => "s"),
    hooks: noHooks,
    model: "test",
    effort: "low",
    maxTurns: 10,
    ...opts,
  });
}

/** Todos los tool_result enviados al modelo, en orden. */
export function toolResults(agent: Agent): ToolResult[] {
  return agent.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b): b is ToolResult => b.type === "tool_result") : [],
  );
}
