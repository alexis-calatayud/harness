import { realpathSync } from "node:fs";
import path from "node:path";
import { ToolError } from "./tools/tool";

/**
 * Resuelve una ruta que viene del modelo (input no confiable) y garantiza que
 * queda dentro de `root`. Rechaza `..`, rutas absolutas fuera de root y
 * symlinks que apunten fuera.
 *
 * Devuelve la ruta real (symlinks resueltos), así cada fichero tiene una sola
 * forma: "./a.ts", "a.ts" y "/ruta/absoluta/a.ts" dan el mismo resultado.
 */
export function resolveInRoot(root: string, requested: string): string {
  const lexicalRoot = path.resolve(root);
  const realRoot = realpathSync(root);
  // El modelo ve la raíz tal como la escribió el usuario (macOS: /var/...), pero también
  // puede usar su forma real (/private/var/...): una ruta absoluta vale con cualquiera de las dos.
  const target = path.resolve(lexicalRoot, requested);
  if (!isInside(lexicalRoot, target) && !isInside(realRoot, target)) throw outside(requested);

  // Comprobación léxica hecha; ahora seguimos symlinks del ancestro que exista.
  const real = realpathOfExistingAncestor(target);
  if (!isInside(realRoot, real)) throw outside(requested);
  return real;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function outside(requested: string): ToolError {
  return new ToolError(`La ruta "${requested}" está fuera del directorio del proyecto`);
}

function realpathOfExistingAncestor(target: string): string {
  let current = target;
  const rest: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
