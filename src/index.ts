#!/usr/bin/env bun
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { Agent, type AgentOptions, type Usage } from "./agent";
import { type Hooks, loadHooks } from "./hooks";
import { Permissions } from "./permissions";
import { defaultTools } from "./tools";
import { bold, dim, green, line, red, yellow } from "./ui";

const { values: args } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    prompt: { type: "string", short: "p" },
    yes: { type: "boolean", short: "y", default: false },
    model: { type: "string", default: process.env.MINI_AGENT_MODEL ?? "claude-opus-5-5" },
    effort: { type: "string", default: process.env.MINI_AGENT_EFFORT ?? "high" },
    "max-turns": { type: "string", default: "50" },
  },
});

const root = path.resolve(args.root);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Ctrl+C durante un turno lo interrumpe; con el prompt vacío, sale.
let inFlight: AbortController | null = null;
rl.on("SIGINT", () => {
  if (inFlight) inFlight.abort();
  else shutdown();
});

const permissions = new Permissions(args.yes ? "yolo" : "ask", (q) =>
  rl.question(q, { signal: inFlight?.signal }),
);

// Los hooks ejecutan comandos sin pedir permiso: se cargan una vez y se muestran al arrancar.
let hooks: Hooks;
try {
  hooks = await loadHooks(root);
} catch (err) {
  line(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}
for (const phase of ["beforeTool", "afterTool"] as const) {
  for (const hook of hooks[phase]) {
    line(dim(`hook ${phase} ${hook.matcher ? `[${hook.matcher.source}] ` : ""}${hook.name}`));
  }
}

const agent = new Agent({
  client: new Anthropic(),
  tools: defaultTools,
  permissions,
  hooks,
  root,
  model: args.model,
  effort: args.effort as AgentOptions["effort"],
  maxTurns: Number(args["max-turns"]),
});

async function runTurn(text: string) {
  inFlight = new AbortController();
  try {
    await agent.send(text, inFlight.signal);
  } catch (err) {
    if (inFlight.signal.aborted) line(yellow("\n⏹ Interrumpido. El turno se ha descartado."));
    else if (err instanceof Anthropic.AuthenticationError) line(red("\n✗ Credenciales inválidas: revisa ANTHROPIC_API_KEY"));
    else if (err instanceof Anthropic.RateLimitError) line(red("\n✗ Rate limit. Espera un poco y reintenta."));
    else if (err instanceof Anthropic.APIError) line(red(`\n✗ Error de API ${err.status}: ${err.message}`));
    else line(red(`\n✗ ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    inFlight = null;
  }
}

// Precios $/MTok (input, output). Cache read ≈ 0.05x en estos modelos, cache write 1.25x.
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
};

function formatUsage(u: Usage): string {
  const tokens = `in ${u.input} · cache read ${u.cacheRead} · cache write ${u.cacheWrite} · out ${u.output}`;
  const price = PRICES[args.model];
  if (!price) return tokens;
  const [inp, out, read] = price;
  const cost = (u.input * inp + u.cacheWrite * inp * 1.25 + u.cacheRead * read + u.output * out) / 1e6;
  return `${tokens} · ~$${cost.toFixed(4)}`;
}

function shutdown() {
  line(dim(`\n${formatUsage(agent.usage)}`));
  rl.close();
  process.exit(0);
}

if (args.prompt) {
  await runTurn(args.prompt);
  shutdown();
}

line(bold("mini-agent") + dim(` · ${args.model} · effort ${args.effort} · ${root}`));
line(dim("Comandos: /reset, /usage, /exit. Ctrl+C interrumpe el turno en curso.\n"));

while (true) {
  const input = (await rl.question(green("› "))).trim();
  if (!input) continue;
  if (input === "/exit") shutdown();
  if (input === "/reset") {
    agent.reset();
    line(dim("Historial borrado."));
    continue;
  }
  if (input === "/usage") {
    line(dim(formatUsage(agent.usage)));
    continue;
  }
  await runTurn(input);
  line();
}
