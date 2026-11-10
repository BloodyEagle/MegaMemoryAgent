export function valueFlag(args: string[], flag: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token !== flag && !token.startsWith(`${flag}=`)) continue;
    if (found !== undefined) throw new Error(`${flag} must be specified only once.`);
    const inline = token.startsWith(`${flag}=`);
    const value = inline ? token.slice(flag.length + 1) : args[++i];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    found = value;
  }
  return found;
}

export function commandIndex(args: string[]): number {
  valueFlag(args, "--db");
  valueFlag(args, "--repo");
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--db" || token === "--repo") index += 2;
    else if (token.startsWith("--db=") || token.startsWith("--repo=")) index += 1;
    else return index;
  }
  return index;
}

export function numberFlag(args: string[], flag: string, fallback: number, integer: boolean): number {
  const raw = valueFlag(args, flag);
  if (raw === undefined) return fallback;
  const valid = integer ? /^\d+$/.test(raw) : /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw);
  const value = Number(raw);
  if (!valid || !Number.isFinite(value) || (integer ? !Number.isSafeInteger(value) || value <= 0 : value < 0 || value > 1)) {
    throw new Error(`${flag} requires ${integer ? "a positive integer" : "a finite number between 0 and 1"}.`);
  }
  return value;
}
