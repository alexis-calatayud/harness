import { truncate } from "./tools/tool";

export interface ExecOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Si se indica, se escribe en el stdin del proceso. */
  stdin?: string;
  /** Variables extra (se suman a las del proceso actual). */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signalCode: string | null;
}

/** Ejecuta un comando con `bash -c`. Lo comparten la herramienta bash y los hooks. */
export async function exec(command: string, opts: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    env: opts.env && { ...process.env, ...opts.env },
    timeout: opts.timeoutMs,
    signal: opts.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, signalCode: proc.signalCode ?? null };
}

/** Formato que ve el modelo: código de salida, stdout y stderr, truncado. */
export function formatExec({ stdout, stderr, exitCode, signalCode }: ExecResult): string {
  const parts = [`exit code: ${exitCode}${signalCode ? ` (${signalCode}, ¿timeout?)` : ""}`];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  return truncate(parts.join("\n\n"));
}
