const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = color(2);
export const bold = color(1);
export const red = color(31);
export const green = color(32);
export const yellow = color(33);
export const cyan = color(36);

export const write = (s: string) => process.stdout.write(s);
export const line = (s = "") => process.stdout.write(`${s}\n`);
