// Reading `src/` as text, for the fitness functions in this directory.
//
// A fitness function asks a question about the SHAPE of the codebase — "does anything
// outside the port touch `browser.*`", "is this event registered twice" — rather than
// about a behaviour. The subject is therefore the source itself, and the honest way to
// read it is as text: importing the modules would answer a question about what the
// bundler resolves, which is not the question.
//
// Comments are stripped first, and that is load-bearing. This repo comments densely and
// names the very APIs it is careful NOT to call (`src/resolver/types.ts` explains itself
// in terms of `browser.cookies.set`, `src/overlays/scripts.ts` in terms of
// `browser.contentScripts.register`). A check that grepped raw text would read those
// notes as violations and would be deleted within a week for crying wolf.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  /** Repo-relative, forward-slashed: "src/engine/engine.ts". */
  path: string;
  /** Exactly as it is on disk. */
  raw: string;
  /** Comments replaced by whitespace, so line numbers and offsets still line up. */
  code: string;
}

// Block and line comments out, everything else untouched. Not a parser: it does not
// know that a "//" inside a string literal is not a comment. That is deliberate — the
// alternative is a TypeScript parse per check, and the cost of the naive version is
// understating the code, i.e. a missed violation rather than a false alarm. The one
// place it matters (a url in a string) is not something these checks look for.
function stripComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

/** Every `.ts` file under the given repo-relative directories, sorted for stable output. */
export function sourceFiles(...dirs: string[]): SourceFile[] {
  return dirs
    .flatMap((dir) => globSync(`${dir}/**/*.ts`, { cwd: root }))
    .map((p) => p.replaceAll("\\", "/"))
    .sort()
    .map((path) => {
      const raw = readFileSync(root + path, "utf8");
      return { path, raw, code: stripComments(raw) };
    });
}

/** Every file whose CODE (not its comments) matches `pattern`, with the lines that did. */
export function filesMatching(files: SourceFile[], pattern: RegExp): { path: string; lines: string[] }[] {
  const hits: { path: string; lines: string[] }[] = [];
  for (const file of files) {
    const lines = file.code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line))
      .map(({ line, n }) => `${n}: ${line}`);
    if (lines.length > 0) hits.push({ path: file.path, lines });
  }
  return hits;
}

/** Just the paths, which is what most expectations compare against. */
export function pathsMatching(files: SourceFile[], pattern: RegExp): string[] {
  return filesMatching(files, pattern).map((h) => h.path);
}

export function readRepoFile(relativePath: string): string {
  return readFileSync(root + relativePath, "utf8");
}
