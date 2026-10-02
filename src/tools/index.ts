import { bash } from "./bash";
import { editFile } from "./edit-file";
import { grep } from "./grep";
import { readFile } from "./read-file";
import type { AgentTool } from "./tool";
import { writeFile } from "./write-file";

// El orden importa: cambiarlo entre peticiones invalida la caché de prompt.
export const defaultTools: AgentTool[] = [readFile, writeFile, editFile, grep, bash];
