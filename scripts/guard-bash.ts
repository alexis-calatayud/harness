#!/usr/bin/env bun
/**
 * Hook beforeTool para `bash`: bloquea borrados de ficheros y operaciones de git
 * que destruyen trabajo o publican cambios (push).
 *
 * Es una red de seguridad contra accidentes, NO un sandbox: un comando ofuscado
 * (`python -c ...`, variables, `eval`, base64...) puede saltárselo.
 *
 * Uso como hook: recibe el evento por stdin ({ tool, input: { command } }).
 * Exit 0 = permitido; exit 1 = bloqueado, con el motivo en stdout para el modelo.
 */

/** Comandos que borran ficheros. */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);

/** Envoltorios que ejecutan el comando que llevan detrás (`sudo rm`, `xargs rm`...). */
const WRAPPERS = new Set(["sudo", "xargs", "env", "nice", "nohup", "time", "command", "exec", "timeout", "doas"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** Opciones globales de git que llevan un argumento detrás (`git -C dir push`). */
const GIT_OPTIONS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** Devuelve el motivo del bloqueo, o undefined si el comando está permitido. */
export function check(command: string): string | undefined {
  for (const words of segments(command)) {
    const reason = checkSimpleCommand(words);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Mira solo la palabra en posición de comando (tras variables `A=b` y envoltorios),
 * para no bloquear `git commit -m "quita el rm"` ni `grep rm`.
 */
function checkSimpleCommand(words: string[]): string | undefined {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(basename(w))) {
      i++;
      // Opciones y argumentos numéricos del envoltorio: `xargs -0 rm`, `timeout 10 rm`.
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i++;
    } else break;
  }
  const cmd = basename(words[i] ?? "");
  const args = words.slice(i + 1);

  if (DELETE_COMMANDS.has(cmd)) return `borra ficheros (\`${cmd}\`)`;
  if (SHELLS.has(cmd)) {
    const c = args.indexOf("-c");
    return c === -1 ? undefined : check(args.slice(c + 1).join(" "));
  }
  if (cmd === "find") {
    if (args.includes("-delete")) return "borra ficheros (`find -delete`)";
    const exec = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
    return exec === -1 ? undefined : checkSimpleCommand(args.slice(exec + 1));
  }
  if (cmd === "git") return checkGit(args);
  return undefined;
}

function checkGit(args: string[]): string | undefined {
  // Saltar las opciones globales hasta llegar al subcomando.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += GIT_OPTIONS_WITH_ARG.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);

  switch (sub) {
    case "push":
      return "publica cambios en un remoto (`git push`)";
    case "rm":
      return "borra ficheros (`git rm`)";
    case "clean":
      return "borra ficheros no versionados (`git clean`)";
    case "reset":
      return rest.includes("--hard") ? "descarta cambios sin commit (`git reset --hard`)" : undefined;
    case "branch":
      return rest.some((a) => a === "-d" || a === "-D" || a === "--delete" || /^-[a-zA-Z]*[dD]/.test(a))
        ? "borra ramas (`git branch -d`)"
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Parte el comando en segmentos (`;`, `&&`, `||`, `|`, `&`, saltos de línea,
 * subshells) y cada segmento en palabras sin comillas. No es un parser de shell
 * completo: un `;` dentro de comillas también parte el comando, lo que puede dar
 * algún falso positivo, pero nunca deja pasar `cd x && rm y`.
 */
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n()`]|\$\(/)
    .map((segment) =>
      segment
        .split(/\s+/)
        .map((w) => w.replace(/^['"\\]+|['"]+$/g, ""))
        .filter(Boolean),
    )
    .filter((words) => words.length > 0);
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

if (import.meta.main) {
  const event = (await Bun.stdin.json()) as { tool?: string; input?: { command?: unknown } };
  const command = event.tool === "bash" && typeof event.input?.command === "string" ? event.input.command : "";
  const reason = check(command);
  if (reason) {
    console.log(
      `Comando bloqueado: ${reason}. Esta acción no está permitida al agente. ` +
        "Si es necesaria, explica al usuario qué quieres hacer y por qué, y pídele que la ejecute él.",
    );
    process.exit(1);
  }
}
