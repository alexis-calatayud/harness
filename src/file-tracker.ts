import { ToolError } from "./tools/tool";

type Snapshot = ReadonlyMap<string, number | bigint>;

/**
 * Qué versión de cada fichero conoce el modelo (read-before-edit).
 *
 * Guarda un hash del contenido que el modelo ha visto: al leerlo con read_file o
 * al escribirlo él mismo. Antes de modificar un fichero existente se exige que
 * esté registrado y que el contenido actual coincida; si otro proceso (o un
 * comando de bash) lo ha cambiado, el modelo tiene que volver a leerlo.
 *
 * Se compara el contenido y no el mtime: es robusto ante herramientas que
 * conservan el mtime y ante dos escrituras en el mismo instante.
 */
export class FileTracker {
  private known = new Map<string, number | bigint>();

  /** El modelo conoce ahora este contenido de `file` (ruta absoluta). */
  record(file: string, content: string) {
    this.known.set(file, Bun.hash(content));
  }

  /** Lanza un ToolError si el modelo no conoce el contenido actual de `file`. */
  assertKnown(file: string, current: string, shownPath: string) {
    const hash = this.known.get(file);
    if (hash === undefined) {
      throw new ToolError(`No has leído ${shownPath}. Léelo con read_file antes de modificarlo.`);
    }
    if (hash !== Bun.hash(current)) {
      throw new ToolError(
        `${shownPath} ha cambiado desde que lo leíste (lo ha modificado otro proceso o un comando). ` +
          "Vuelve a leerlo antes de modificarlo.",
      );
    }
  }

  /** Para descartar un turno: el registro vuelve al checkpoint junto con el historial. */
  snapshot(): Snapshot {
    return new Map(this.known);
  }

  restore(snapshot: Snapshot) {
    this.known = new Map(snapshot);
  }

  clear() {
    this.known.clear();
  }
}
