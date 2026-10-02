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

## ⚠️ Limitaciones conocidas

`bash` **no está en sandbox**: se ejecuta con tus permisos y puede tocar cualquier cosa. El confinamiento
a `--root` solo aplica a las herramientas de ficheros. Para eso existe el modo `ask`.

## Ejercicios para seguir

1. **Read-before-edit**: rechaza `edit_file`/`write_file` sobre ficheros que el agente no ha leído
   (o que han cambiado desde que los leyó).
2. **Hooks**: `beforeTool`/`afterTool` configurables (p. ej. ejecutar `tsc` tras cada edición y
   devolver los errores al modelo).
3. **Reglas de permisos**: allowlist tipo `bash(git status*)`, `bash(bun test*)`.
4. **Sandbox real para bash**: `sandbox-exec` en macOS o un contenedor.
5. **Gestión de contexto**: recortar `tool_result` antiguos o compactar cuando el contexto crece.
6. **Trazas**: guardar cada petición y respuesta en JSONL para reproducir sesiones (base del harness de evals).
