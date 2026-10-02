import { realpathSync } from "node:fs";
import path from "node:path";
import { ToolError } from "./tools/tool";

/**
 * Resuelve una ruta que viene del modelo (input no confiable) y garantiza que
 * queda dentro de `root`. Rechaza `..`, rutas absolutas fuera de root y
 * symlinks que apunten fuera.
 */
export function resolveInRoot(root: string, requested: string): string {
  const realRoot = realpathSync(root);
  const target = path.resolve(realRoot, requested);
  assertInside(realRoot, target, requested);

  // Comprobación léxica hecha; ahora seguimos symlinks del ancestro que exista.
  const real = realpathOfExistingAncestor(target);
  assertInside(realRoot, real, requested);
  return target;
}

function assertInside(root: string, target: string, requested: string) {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError(`La ruta "${requested}" está fuera del directorio del proyecto`);
  }
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
