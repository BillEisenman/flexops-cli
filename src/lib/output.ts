/**
 * Output helpers — keeps human-readable formatting separate from the JSON path
 * so --json never accidentally interleaves color codes or progress chatter.
 */
import kleur from "kleur";

export function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeError(line: string): void {
  process.stderr.write(`${kleur.red("✗")} ${line}\n`);
}

export function writeSuccess(line: string): void {
  process.stdout.write(`${kleur.green("✓")} ${line}\n`);
}

export function writeInfo(line: string): void {
  process.stdout.write(`${kleur.blue("→")} ${line}\n`);
}

export function writeWarning(line: string): void {
  process.stderr.write(`${kleur.yellow("!")} ${line}\n`);
}

export function dim(value: string): string {
  return kleur.gray(value);
}

export function bold(value: string): string {
  return kleur.bold(value);
}
