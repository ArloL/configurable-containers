// Keeping a config's `version:` line equal to what its features cost. Pure, and textual on
// purpose: this rewrites the user's own YAML, so it must not reflow their comments,
// quoting or key order the way a parse-and-serialise round trip would.
import { CONFIG_VERSION, parseConfigDetailed, type ParseResult } from "./parse";

// A top-level key sits at column 0, and block-scalar content is always indented past its
// key — so this cannot match the `version:` line inside somebody's script snippet.
const VERSION_LINE = /^version:.*(?:\r?\n|$)/m;

function isBlankOrComment(line: string): boolean {
  const t = line.trimStart();
  return t === "" || t.startsWith("#");
}

export function stampVersion(yamlText: string): string {
  let before: ParseResult;
  try {
    before = parseConfigDetailed(yamlText);
  } catch {
    return yamlText;
  }
  // A build in lenient mode cannot see the features that earned this line — it would
  // derive a version from the keys it happens to know, strip the marker, and disarm
  // leniency on every other machine still running an older build.
  if (before.declaredVersion > CONFIG_VERSION) return yamlText;
  if (before.declaredVersion === before.requiredVersion) return yamlText;

  const stripped = yamlText.replace(VERSION_LINE, "");
  const stamped =
    before.requiredVersion > 1 ? insertLine(stripped, `version: ${before.requiredVersion}`) : stripped;

  // The document is edited as text, so this stands in for knowing every shape YAML can
  // take: a flow-style mapping has no line to insert above, and text that no longer parses
  // is not an improvement on the text as found. Nothing more is checked because nothing
  // more can differ — a second `version:` key is a duplicate YAML refuses outright, so
  // stamped text that parses declares what was written into it.
  try {
    parseConfigDetailed(stamped);
  } catch {
    return yamlText;
  }
  return stamped;
}

// Below any header comment: those describe the file, and a marker nobody typed should not
// push them down.
function insertLine(yamlText: string, line: string): string {
  const lines = yamlText.split("\n");
  // Never -1: a document with a version to declare has a key to declare it above.
  const at = lines.findIndex((l) => !isBlankOrComment(l));
  lines.splice(at, 0, line);
  return lines.join("\n");
}
