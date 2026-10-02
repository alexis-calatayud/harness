# mini-agent

Agente de programación mínimo para practicar *harness engineering*: el bucle del agente,
las herramientas, los permisos y todo lo que rodea al modelo. Está escrito con un bucle manual
(sin Tool Runner) para que cada decisión esté a la vista.

## Uso

```bash
bun install
cp .env.example .env   # y rellena ANTHROPIC_API_KEY
bun start                         # REPL en el directorio actual
bun start --root ../otro-proyecto # trabajar sobre otro directorio
bun start -p "explica este repo"  # one-shot
bun start --yes                   # sin pedir permisos (cuidado)
bun start --effort xhigh --model claude-sonnet-5-5
```

En el REPL: `/reset`, `/usage`, `/exit`. Ctrl+C interrumpe el turno en curso.

## Estructura

| Fichero | Qué hace |
|---|---|
| `src/agent.ts` | El bucle: stream → `stop_reason` → herramientas → repetir |
| `src/tools/tool.ts` | Contrato `AgentTool`: schema Zod → JSON Schema + validación |
| `src/tools/*.ts` | `read_file`, `write_file`, `edit_file`, `grep`, `bash` |
| `src/sandbox.ts` | Confina rutas del modelo a `--root` (incluye symlinks) |
| `src/permissions.ts` | Lectura libre; escritura y bash preguntan (`s`/`n`/`a`) |
| `src/hooks.ts` | Hooks `beforeTool`/`afterTool` y carga de `.mini-agent/hooks.json` |
| `src/exec.ts` | Ejecución de comandos compartida por `bash` y los hooks |
| `src/index.ts` | CLI, REPL, Ctrl+C, coste aproximado |

## Decisiones del harness

- **Historial append-only.** Si un turno falla, se aborta o es rechazado, se recorta al checkpoint
  anterior en vez de editar mensajes. Así no se invalida la caché ni el thinking previo.
- **Cada `stop_reason` se trata de forma explícita.** `max_tokens` con un `tool_use` no se ejecuta nunca
  (el input estaría truncado). `refusal` descarta el turno.
- **Validación propia.** Con `eager_input_streaming` el servidor no valida los inputs: Zod lo hace
  antes de ejecutar, y un input inválido vuelve al modelo como `is_error`.
- **Los errores de herramienta no rompen el bucle.** Se devuelven al modelo para que se corrija.
- **Permisos primero, ejecución en paralelo.** Las preguntas son secuenciales y lo aprobado se ejecuta
  con `Promise.all`. Todos los `tool_result` van en un único mensaje.
- **Caché de prompt.** El system prompt y el orden de las herramientas son estables, y se usa
  `cache_control` automático. Para comprobarlo, mira `cache read` en `/usage`.
- **Fallbacks.** `fallbacks: "default"` reintenta en el servidor si un clasificador rechaza.

## Hooks

Comandos que el harness ejecuta antes o después de una herramienta, configurados en
`.mini-agent/hooks.json` dentro de `--root`:

```json
{
  "beforeTool": [
    { "name": "guard-bash", "matcher": "bash", "command": "bun scripts/guard-bash.ts" }
  ],
  "afterTool": [
    { "name": "typecheck", "matcher": "edit_file|write_file", "command": "bun run typecheck" }
  ]
}
```

- `matcher` es una regex anclada sobre el nombre de la herramienta; sin ella, el hook aplica a todas.
- El hook recibe el evento como JSON por stdin (`{ hook, tool, input, output? }`) y en
  `MINI_AGENT_HOOK` / `MINI_AGENT_TOOL`. Se ejecuta en `--root`, con `timeout_ms` (60 s por defecto).
- **Exit 0**: no pasa nada. **Otro código**: su salida va al modelo.
  - En `beforeTool` **bloquea** la herramienta: vuelve como `is_error` y no se pregunta permiso.
  - En `afterTool` se **añade** al `tool_result` (sin `is_error`, la herramienta sí funcionó). Así el
    modelo ve los errores de `tsc` justo después de su edición y los corrige en la siguiente vuelta.
- `afterTool` solo se ejecuta si la herramienta ha funcionado. Un hook que falla o lanza en `beforeTool`
  bloquea (falla cerrado).
- Desde código se puede pasar cualquier `Hook` (`{ name, matcher?, run }`) en `AgentOptions.hooks`.

Este repo trae ambos activos en `.mini-agent/hooks.json`. `scripts/guard-bash.ts` bloquea borrados
(`rm`, `rmdir`, `unlink`, `shred`, `find -delete`, también tras `sudo`, `xargs`, `bash -c`...) y git
destructivo o que publica (`push`, `rm`, `clean`, `reset --hard`, `branch -d`). Mira la palabra en
posición de comando, así que `git commit -m "quita el rm"` pasa. Es una red contra accidentes, **no un
sandbox**: `python -c`, `eval` o variables pueden saltárselo.

Los hooks ejecutan comandos **sin pedir permiso**. Por eso el fichero se lee una sola vez al arrancar
(si el agente lo edita, no tiene efecto hasta reiniciar) y la lista se muestra al inicio. Revísala antes de
usar mini-agent en un repo que no sea tuyo. Con varias ediciones en paralelo, cada una lanza su
`afterTool`, así que un `tsc` puede ejecutarse varias veces en la misma vuelta.

## ⚠️ Limitaciones conocidas

`bash` **no está en sandbox**: se ejecuta con tus permisos y puede tocar cualquier cosa. El confinamiento
a `--root` solo aplica a las herramientas de ficheros. Para eso existe el modo `ask`.

## Ejercicios para seguir

1. **Read-before-edit**: rechaza `edit_file`/`write_file` sobre ficheros que el agente no ha leído
   (o que han cambiado desde que los leyó).
2. ~~**Hooks**~~ ✅ hecho (ver [Hooks](#hooks)).
3. **Reglas de permisos**: allowlist tipo `bash(git status*)`, `bash(bun test*)`.
4. **Sandbox real para bash**: `sandbox-exec` en macOS o un contenedor.
5. **Gestión de contexto**: recortar `tool_result` antiguos o compactar cuando el contexto crece.
6. **Trazas**: guardar cada petición y respuesta en JSONL para reproducir sesiones (base del harness de evals).
