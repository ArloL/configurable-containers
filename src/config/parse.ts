// See docs/superpowers/specs/2026-07-10-config-parser-design.md, and
// docs/superpowers/specs/2026-08-19-match-patterns-and-regex-design.md §3 for the three
// match forms and the two rules that fall out of them (auto-naming, scripts-on-regex).
import { parse, YAMLParseError } from "yaml";
import { hostMatcher, patternMatcher, regexMatcher, type Matcher } from "../matcher/matcher";
// The naming contract belongs to the registry, which mints the names; imported rather than
// restated so the two halves cannot drift. (Types only — no browser reaches the parser.)
import { isThrowawayName } from "../engine/registry";
import type { Action, Config, CookieSpec, Group, Rule, ScriptSpec } from "../resolver/types";

export class ConfigError extends Error {
  readonly path?: string;
  readonly line?: number;
  readonly col?: number;
  constructor(message: string, opts: { path?: string; line?: number; col?: number } = {}) {
    super(message);
    this.name = "ConfigError";
    this.path = opts.path;
    this.line = opts.line;
    this.col = opts.col;
  }
}

const ACTION_KEYS = ["open", "inherit", "ignore", "redirector"] as const;
const ALLOWED_RULE_KEYS = new Set([
  "match", "open", "default", "inherit", "ignore", "redirector", "cookies", "scripts",
]);
const ALLOWED_COOKIE_KEYS = new Set([
  "name", "url", "value", "domain", "path", "secure", "httpOnly",
  "sameSite", "expirationDate", "firstPartyDomain", "partitionKey",
]);
const SAME_SITE = new Set(["no_restriction", "lax", "strict"]);
const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
const ALLOWED_SCRIPT_KEYS = new Set(["at", "run"]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// One raw `match` entry to a Matcher. Three forms, told apart by shape: the mapping
// `{ regex: … }`, a string containing "://" (a match pattern — the scheme is what makes one),
// and anything else, read as a bare hostname.
const GLOB_META = /[*?[]/;
const PATTERN_SEP = "://";

function toMatcher(entry: unknown, path: string): Matcher {
  if (isMapping(entry)) {
    for (const k of Object.keys(entry)) {
      if (k !== "regex") throw new ConfigError(`unknown key "${k}" in ${path} (a regex match is { regex: "…" })`, { path });
    }
    if (typeof entry.regex !== "string") {
      throw new ConfigError(`${path}.regex must be a string`, { path: `${path}.regex` });
    }
    try {
      return regexMatcher(entry.regex);
    } catch (e) {
      throw new ConfigError(`${path}: ${(e as Error).message}`, { path });
    }
  }
  if (typeof entry !== "string") {
    throw new ConfigError(`${path}: a match entry is a hostname, a match pattern, or { regex: "…" }`, { path });
  }
  if (entry.includes(PATTERN_SEP)) {
    try {
      return patternMatcher(entry);
    } catch (e) {
      throw new ConfigError(`${path}: ${(e as Error).message}`, { path });
    }
  }
  // A glob with no scheme is the near-miss worth naming: `*.example.com` is what someone
  // writes meaning the match pattern, and the hostname parser would blame the wildcard.
  if (GLOB_META.test(entry)) {
    throw new ConfigError(`${path}: "${entry}" is not a bare hostname — a wildcard needs the full pattern form, as in "*://*.example.com/*"`, { path });
  }
  try {
    return hostMatcher(entry);
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`, { path });
  }
}

// `firstHost` is what an action-less rule auto-names its container after. Null unless the
// FIRST entry is a bare hostname: a pattern has no one host to take a name from
// (`*://*.example.com/*` could mean three), and a regex none at all, so those need `open:`.
function parseMatch(raw: unknown, path: string): { matchers: Matcher[]; firstHost: string | null } {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new ConfigError(`${path}.match must not be empty`, { path: `${path}.match` });
  }
  const matchers = list.map((e, j) => toMatcher(e, `${path}.match[${j}]`));
  const first = matchers[0];
  return { matchers, firstHost: first.kind === "host" ? first.host : null };
}

// `tmp<N>` is what the registry mints for a throwaway, and the name is all that tells one
// apart — so a permanent container named that is deleted by the disposer once its last tab
// closes, logins and all, and until then a tab in it reads as "already in a throwaway".
// Both losses are silent, hence an error rather than a warning. Only the exact shape is
// reserved: `tmpwork` and `tmpfiles.org` are ordinary names.
function checkContainerName(name: string, path: string): void {
  if (isThrowawayName(name)) {
    throw new ConfigError(
      `${path} "${name}" is the reserved name of a throwaway container (tmp + a number), which the disposer deletes once it is empty; pick another name`,
      { path },
    );
  }
}

function parseOpen(raw: Record<string, unknown>, path: string): Action {
  const open = raw.open;
  let containers: string[];
  if (typeof open === "string") {
    if (open === "") throw new ConfigError(`${path}.open must not be an empty container name`, { path: `${path}.open` });
    checkContainerName(open, `${path}.open`);
    containers = [open];
  } else if (Array.isArray(open)) {
    if (open.length === 0) throw new ConfigError(`${path}.open must not be empty`, { path: `${path}.open` });
    containers = open.map((c, j) => {
      if (typeof c !== "string") {
        throw new ConfigError(`${path}.open[${j}] must be a container name (string)`, { path: `${path}.open[${j}]` });
      }
      if (c === "") {
        throw new ConfigError(`${path}.open[${j}] must not be an empty container name`, { path: `${path}.open[${j}]` });
      }
      checkContainerName(c, `${path}.open[${j}]`);
      return c;
    });
  } else {
    throw new ConfigError(`${path}.open must be a string or a list of strings`, { path: `${path}.open` });
  }
  return { kind: "open", containers };
}

function parseCookie(raw: unknown, path: string): CookieSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_COOKIE_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }

  const spec = {} as CookieSpec;

  for (const key of ["name", "url"] as const) {
    const v = raw[key];
    if (typeof v !== "string" || v === "") {
      throw new ConfigError(`${path}.${key} is required and must be a non-empty string`, { path: `${path}.${key}` });
    }
    spec[key] = v;
  }

  for (const key of ["value", "domain", "path", "firstPartyDomain"] as const) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v !== "string") throw new ConfigError(`${path}.${key} must be a string`, { path: `${path}.${key}` });
      spec[key] = v;
    }
  }

  for (const key of ["secure", "httpOnly"] as const) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v !== "boolean") throw new ConfigError(`${path}.${key} must be a boolean`, { path: `${path}.${key}` });
      spec[key] = v;
    }
  }

  if ("sameSite" in raw) {
    const v = raw.sameSite;
    if (typeof v !== "string" || !SAME_SITE.has(v)) {
      throw new ConfigError(`${path}.sameSite must be one of no_restriction, lax, strict`, { path: `${path}.sameSite` });
    }
    spec.sameSite = v as CookieSpec["sameSite"];
  }

  if ("expirationDate" in raw) {
    const v = raw.expirationDate;
    if (typeof v !== "number") throw new ConfigError(`${path}.expirationDate must be a number`, { path: `${path}.expirationDate` });
    spec.expirationDate = v;
  }

  if ("partitionKey" in raw) {
    const v = raw.partitionKey;
    if (!isMapping(v)) throw new ConfigError(`${path}.partitionKey must be an object`, { path: `${path}.partitionKey` });
    spec.partitionKey = v as CookieSpec["partitionKey"];
  }

  return spec;
}

function parseCookies(raw: unknown, path: string): CookieSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.cookies must be a list`, { path: `${path}.cookies` });
  return raw.map((entry, j) => parseCookie(entry, `${path}.cookies[${j}]`));
}

function parseScript(raw: unknown, path: string): ScriptSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_SCRIPT_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }

  const spec = {} as ScriptSpec;

  const run = raw.run;
  if (run === undefined || run === "") {
    throw new ConfigError(`${path}.run is required and must be a non-empty string`, { path: `${path}.run` });
  }
  if (typeof run !== "string") {
    throw new ConfigError(`${path}.run must be a string`, { path: `${path}.run` });
  }
  spec.run = run;

  if ("at" in raw) {
    const v = raw.at;
    if (typeof v !== "string" || !RUN_AT.has(v)) {
      throw new ConfigError(`${path}.at must be one of document_start, document_end, document_idle`, { path: `${path}.at` });
    }
    spec.at = v as ScriptSpec["at"];
  }

  return spec;
}

function parseScripts(raw: unknown, path: string): ScriptSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.scripts must be a list`, { path: `${path}.scripts` });
  return raw.map((entry, j) => parseScript(entry, `${path}.scripts[${j}]`));
}

function parseRule(raw: unknown, i: number): Rule {
  const path = `rules[${i}]`;
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });

  for (const k of Object.keys(raw)) {
    if (!ALLOWED_RULE_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }
  if (!("match" in raw)) throw new ConfigError(`${path} is missing "match"`, { path });
  const { matchers, firstHost } = parseMatch(raw.match, path);

  const present = ACTION_KEYS.filter((k) => k in raw);
  if (present.length > 1) {
    throw new ConfigError(`${path} has more than one action (${present.join(", ")}); a rule has at most one action`, { path });
  }

  let action: Action;
  if (present.length === 0) {
    if (firstHost === null) {
      throw new ConfigError(`${path} has no action and its first match is not a bare hostname, so there is no host to name a container after; add "open:"`, { path });
    }
    // The auto-named case lands here too: `- match: tmp1` is a legal hostname.
    checkContainerName(firstHost, `${path}.match[0]`);
    action = { kind: "open", containers: [firstHost] }; // auto-name after the first host
  } else {
    switch (present[0]) {
      case "inherit":
        if (raw.inherit !== true) throw new ConfigError(`${path}.inherit must be true`, { path });
        action = { kind: "inherit" };
        break;
      case "ignore":
        if (raw.ignore !== true) throw new ConfigError(`${path}.ignore must be true`, { path });
        action = { kind: "ignore" };
        break;
      case "redirector":
        if (raw.redirector !== true) throw new ConfigError(`${path}.redirector must be true`, { path });
        action = { kind: "redirector" };
        break;
      default: // "open"
        action = parseOpen(raw, path);
    }
  }

  if ("default" in raw) {
    if (action.kind !== "open" || action.containers.length < 2) {
      throw new ConfigError(`${path}.default is only valid with a multi-value "open"`, { path: `${path}.default` });
    }
    const def = raw.default;
    if (typeof def !== "string") {
      throw new ConfigError(`${path}.default must be a container name`, { path: `${path}.default` });
    }
    if (!action.containers.includes(def)) {
      throw new ConfigError(`${path}.default "${def}" is not one of open: [${action.containers.join(", ")}]`, { path: `${path}.default` });
    }
    action = { ...action, default: def };
  }

  const out: Rule = { match: matchers, action };

  if ("cookies" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.cookies is not allowed on an "ignore" rule`, { path: `${path}.cookies` });
    }
    out.cookies = parseCookies(raw.cookies, path);
  }

  if ("scripts" in raw) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.scripts is not allowed on an "ignore" rule`, { path: `${path}.scripts` });
    }
    // Content scripts register against URL patterns before any navigation, and a regex has
    // no pattern form (`matcher.matcherToPatterns`). Refused here, where the user is looking
    // at the rule: the alternatives are `*://*/*` — their snippet on every page they open —
    // or injecting on a subset of what the rule routes, a silent wrong answer.
    if (matchers.some((m) => m.kind === "regex")) {
      throw new ConfigError(`${path}.scripts is not allowed on a rule with a regex match (a content script registers by URL pattern, which a regex has none of); give the script's hosts a rule of their own`, { path: `${path}.scripts` });
    }
    out.scripts = parseScripts(raw.scripts, path);
  }

  return out;
}

function parseGroup(raw: unknown, i: number): Group {
  const path = `groups[${i}]`;
  if (!Array.isArray(raw)) throw new ConfigError(`${path} must be a list of matchers`, { path });
  if (raw.length === 0) throw new ConfigError(`${path} must not be empty`, { path });
  const match = raw.map((e, j) => toMatcher(e, `${path}[${j}]`));
  return { match };
}

export function parseConfig(yamlText: string): Config {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0];
      throw new ConfigError(`YAML syntax error: ${e.message}`, { line: pos?.line, col: pos?.col });
    }
    throw e;
  }

  if (doc === null || doc === undefined) return { rules: [], groups: [] };
  if (!isMapping(doc)) throw new ConfigError("config must be a mapping with `rules` and/or `groups`");

  const rawRules = doc.rules ?? [];
  if (!Array.isArray(rawRules)) throw new ConfigError("`rules` must be a list", { path: "rules" });
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new ConfigError("`groups` must be a list", { path: "groups" });

  const rules = rawRules.map((r, i) => parseRule(r, i));
  const groups = rawGroups.map((g, i) => parseGroup(g, i));
  return { rules, groups };
}
