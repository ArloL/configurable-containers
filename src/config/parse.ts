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
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly col?: number | undefined;
  constructor(
    message: string,
    opts: { path?: string | undefined; line?: number | undefined; col?: number | undefined } = {}
  ) {
    super(message);
    this.name = "ConfigError";
    this.path = opts.path;
    this.line = opts.line;
    this.col = opts.col;
  }
}

// The lowest config version this build understands in full. Bumped whenever the grammar
// grows a feature, so that a config using it can say so and older builds can tell a
// feature they have never heard of from a typo. Version 2 is the two non-hostname match
// forms (patterns and regexes), which arrived after the first release.
export const CONFIG_VERSION = 2;

export interface ConfigWarning {
  message: string;
  readonly path?: string | undefined;
}

export interface ParseResult {
  config: Config;
  // The lowest CONFIG_VERSION that understands every feature the document uses, derived
  // from the document rather than read off it.
  requiredVersion: number;
  // What the document CLAIMS to need. 1 when it says nothing, which is every config
  // written before the marker existed.
  declaredVersion: number;
  warnings: ConfigWarning[];
}

// Everything a parse carries besides the document: what to do with a feature this build
// does not know, and the two things a caller learns from the walk.
interface Ctx {
  lenient: boolean;
  declaredVersion: number;
  requiredVersion: number;
  warnings: ConfigWarning[];
}

// A key this build has no entry for. Strict unless the document announces itself as newer
// than this build: a config that claims no future version cannot be holding a feature we
// have never heard of, so the key is a typo — and a typo silently ignored is a rule that
// means something else.
function unknownKey(ctx: Ctx, path: string, message: string): void {
  if (!ctx.lenient) throw new ConfigError(message, { path });
  warn(ctx, path, `${message} — ignored`);
}

// A rule or group this build cannot parse at all, which is what a feature that changed the
// SHAPE of a value looks like from here. Dropping the one rule costs the sites it names a
// throwaway; refusing the document costs every site one, so leniency stops at the rule.
function skipped(ctx: Ctx, path: string, e: unknown): void {
  if (!ctx.lenient || !(e instanceof ConfigError)) throw e;
  warn(ctx, path, `${path} skipped — ${e.message}`);
}

function warn(ctx: Ctx, path: string, message: string): void {
  ctx.warnings.push({
    message:
      `${message}; this config declares version ${ctx.declaredVersion} ` +
      `and this build understands ${CONFIG_VERSION}`,
    path,
  });
}

function use(ctx: Ctx, version: number): void {
  // Stryker disable next-line EqualityOperator: `>=` reassigns the value it already holds.
  if (version > ctx.requiredVersion) ctx.requiredVersion = version;
}

// Every feature of the grammar against the version that introduced it. These are the
// allow-lists as well: a key absent from the table is a key this build does not know, and
// the version beside a key is what `requiredVersion` is made of, so a future feature gets
// its marker written for free rather than by whoever remembers.
const ACTION_KEYS = ["open", "inherit", "ignore", "redirector"] as const;
interface FeatureVersions {
  document: Record<string, number>;
  rule: Record<string, number>;
  cookie: Record<string, number>;
  script: Record<string, number>;
  matchMapping: Record<string, number>;
  // The three forms that are a shape rather than a key, so no key table can carry them.
  matchForm: { host: number; pattern: number; regex: number };
}

export const FEATURE_VERSIONS: FeatureVersions = {
  document: { version: 1, rules: 1, groups: 1 },
  rule: {
    match: 1, open: 1, default: 1, inherit: 1, ignore: 1, redirector: 1, cookies: 1, scripts: 1,
  },
  cookie: {
    name: 1, url: 1, value: 1, domain: 1, path: 1, secure: 1, httpOnly: 1,
    sameSite: 1, expirationDate: 1, firstPartyDomain: 1, partitionKey: 1,
  },
  script: { at: 1, run: 1 },
  matchMapping: { regex: 2 },
  matchForm: { host: 1, pattern: 2, regex: 2 },
};

const {
  document: DOCUMENT_KEYS,
  rule: RULE_KEYS,
  cookie: COOKIE_KEYS,
  script: SCRIPT_KEYS,
  matchMapping: MATCH_MAPPING_KEYS,
  matchForm: MATCH_FORM_VERSIONS,
} = FEATURE_VERSIONS;
// Kept clear for the user: a YAML anchor has to attach to a node, and every node this
// grammar defines is spoken for, so a config that wants to reuse a fragment needs a key of
// its own at the top level. Ignored without comment — an `x-` key means nothing here by
// definition, so there is nothing to warn about.
const RESERVED_PREFIX = "x-";

const SAME_SITE = new Set(["no_restriction", "lax", "strict"]);
const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// One raw `match` entry to a Matcher. Three forms, told apart by shape: the mapping
// `{ regex: … }`, a string containing "://" (a match pattern — the scheme is what makes one),
// and anything else, read as a bare hostname.
const GLOB_META = /[*?[]/;
const PATTERN_SEP = "://";

function toMatcher(entry: unknown, path: string, ctx: Ctx): Matcher {
  if (isMapping(entry)) {
    for (const k of Object.keys(entry)) {
      if (!Object.hasOwn(MATCH_MAPPING_KEYS, k)) {
        unknownKey(ctx, path, `unknown key "${k}" in ${path} (a regex match is { regex: "…" })`);
      }
    }
    if (typeof entry.regex !== "string") {
      throw new ConfigError(`${path}.regex must be a string`, { path: `${path}.regex` });
    }
    use(ctx, MATCH_FORM_VERSIONS.regex);
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
    use(ctx, MATCH_FORM_VERSIONS.pattern);
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
  use(ctx, MATCH_FORM_VERSIONS.host);
  try {
    return hostMatcher(entry);
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`, { path });
  }
}

// `firstHost` is what an action-less rule auto-names its container after. Null unless the
// FIRST entry is a bare hostname: a pattern has no one host to take a name from
// (`*://*.example.com/*` could mean three), and a regex none at all, so those need `open:`.
function parseMatch(raw: unknown, path: string, ctx: Ctx): { matchers: Matcher[]; firstHost: string | null } {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new ConfigError(`${path}.match must not be empty`, { path: `${path}.match` });
  }
  const matchers = list.map((e, j) => toMatcher(e, `${path}.match[${j}]`, ctx));
  const first = matchers[0];
  // Stryker disable next-line OptionalChaining: the emptiness check above is what makes
  // `matchers[0]` present; the chain is what says so to the compiler.
  return { matchers, firstHost: first?.kind === "host" ? first.host : null };
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
  let containers: [string, ...string[]];
  if (typeof open === "string") {
    if (open === "") throw new ConfigError(`${path}.open must not be an empty container name`, { path: `${path}.open` });
    checkContainerName(open, `${path}.open`);
    containers = [open];
  } else if (Array.isArray(open)) {
    const names: string[] = open.map((c, j) => {
      if (typeof c !== "string") {
        throw new ConfigError(`${path}.open[${j}] must be a container name (string)`, { path: `${path}.open[${j}]` });
      }
      if (c === "") {
        throw new ConfigError(`${path}.open[${j}] must not be an empty container name`, { path: `${path}.open[${j}]` });
      }
      checkContainerName(c, `${path}.open[${j}]`);
      return c;
    });
    // The emptiness check, in the form that also produces the non-empty tuple. `open: []`
    // maps over nothing and throws here rather than a line earlier.
    const [first, ...rest] = names;
    if (first === undefined) throw new ConfigError(`${path}.open must not be empty`, { path: `${path}.open` });
    containers = [first, ...rest];
  } else {
    throw new ConfigError(`${path}.open must be a string or a list of strings`, { path: `${path}.open` });
  }
  return { kind: "open", containers };
}

function parseCookie(raw: unknown, path: string, ctx: Ctx): CookieSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (Object.hasOwn(COOKIE_KEYS, k)) use(ctx, COOKIE_KEYS[k]!);
    else unknownKey(ctx, path, `unknown key "${k}" in ${path}`);
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
    // Stryker disable next-line ConditionalExpression: the set membership test already
    // answers false for every non-string; the typeof is what narrows `v` for the
    // assignment below.
    if (typeof v !== "string" || !SAME_SITE.has(v)) {
      throw new ConfigError(`${path}.sameSite must be one of no_restriction, lax, strict`, { path: `${path}.sameSite` });
    }
    spec.sameSite = v as NonNullable<CookieSpec["sameSite"]>;
  }

  if ("expirationDate" in raw) {
    const v = raw.expirationDate;
    if (typeof v !== "number") throw new ConfigError(`${path}.expirationDate must be a number`, { path: `${path}.expirationDate` });
    spec.expirationDate = v;
  }

  if ("partitionKey" in raw) {
    const v = raw.partitionKey;
    if (!isMapping(v)) throw new ConfigError(`${path}.partitionKey must be an object`, { path: `${path}.partitionKey` });
    spec.partitionKey = v;
  }

  return spec;
}

function parseCookies(raw: unknown, path: string, ctx: Ctx): CookieSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.cookies must be a list`, { path: `${path}.cookies` });
  return raw.map((entry, j) => parseCookie(entry, `${path}.cookies[${j}]`, ctx));
}

function parseScript(raw: unknown, path: string, ctx: Ctx): ScriptSpec {
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });
  for (const k of Object.keys(raw)) {
    if (Object.hasOwn(SCRIPT_KEYS, k)) use(ctx, SCRIPT_KEYS[k]!);
    else unknownKey(ctx, path, `unknown key "${k}" in ${path}`);
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
    // Stryker disable next-line ConditionalExpression: as sameSite above — the set
    // rejects every non-string, the typeof narrows for the assignment.
    if (typeof v !== "string" || !RUN_AT.has(v)) {
      throw new ConfigError(`${path}.at must be one of document_start, document_end, document_idle`, { path: `${path}.at` });
    }
    spec.at = v as NonNullable<ScriptSpec["at"]>;
  }

  return spec;
}

function parseScripts(raw: unknown, path: string, ctx: Ctx): ScriptSpec[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}.scripts must be a list`, { path: `${path}.scripts` });
  return raw.map((entry, j) => parseScript(entry, `${path}.scripts[${j}]`, ctx));
}

function parseRule(raw: unknown, i: number, ctx: Ctx): Rule {
  const path = `rules[${i}]`;
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });

  // Only the keys this build knows go on: in lenient mode `unknownKey` returns, and what
  // it lets through must not reach the action count or `parseOpen`.
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.hasOwn(RULE_KEYS, k)) {
      use(ctx, RULE_KEYS[k]!);
      fields[k] = v;
    } else {
      unknownKey(ctx, path, `unknown key "${k}" in ${path}`);
    }
  }
  if (!("match" in fields)) throw new ConfigError(`${path} is missing "match"`, { path });
  const { matchers, firstHost } = parseMatch(fields.match, path, ctx);

  const present = ACTION_KEYS.filter((k) => k in fields);
  if (present.length > 1) {
    throw new ConfigError(`${path} has more than one action (${present.join(", ")}); a rule has at most one action`, { path });
  }

  let action: Action;
  const chosen = present[0];
  if (chosen === undefined) {
    if (firstHost === null) {
      throw new ConfigError(`${path} has no action and its first match is not a bare hostname, so there is no host to name a container after; add "open:"`, { path });
    }
    // The auto-named case lands here too: `- match: tmp1` is a legal hostname.
    checkContainerName(firstHost, `${path}.match[0]`);
    action = { kind: "open", containers: [firstHost] }; // auto-name after the first host
  } else {
    switch (chosen) {
      case "inherit":
        if (fields.inherit !== true) throw new ConfigError(`${path}.inherit must be true`, { path });
        action = { kind: "inherit" };
        break;
      case "ignore":
        if (fields.ignore !== true) throw new ConfigError(`${path}.ignore must be true`, { path });
        action = { kind: "ignore" };
        break;
      case "redirector":
        if (fields.redirector !== true) throw new ConfigError(`${path}.redirector must be true`, { path });
        action = { kind: "redirector" };
        break;
      case "open":
        action = parseOpen(fields, path);
        break;
    }
  }

  if ("default" in fields) {
    if (action.kind !== "open" || action.containers.length < 2) {
      throw new ConfigError(`${path}.default is only valid with a multi-value "open"`, { path: `${path}.default` });
    }
    const def = fields.default;
    if (typeof def !== "string") {
      throw new ConfigError(`${path}.default must be a container name`, { path: `${path}.default` });
    }
    if (!action.containers.includes(def)) {
      throw new ConfigError(`${path}.default "${def}" is not one of open: [${action.containers.join(", ")}]`, { path: `${path}.default` });
    }
    action = { ...action, default: def };
  }

  const out: Rule = { match: matchers, action };

  if ("cookies" in fields) {
    if (action.kind === "ignore") {
      throw new ConfigError(`${path}.cookies is not allowed on an "ignore" rule`, { path: `${path}.cookies` });
    }
    out.cookies = parseCookies(fields.cookies, path, ctx);
  }

  if ("scripts" in fields) {
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
    out.scripts = parseScripts(fields.scripts, path, ctx);
  }

  return out;
}

function parseGroup(raw: unknown, i: number, ctx: Ctx): Group {
  const path = `groups[${i}]`;
  if (!Array.isArray(raw)) throw new ConfigError(`${path} must be a list of matchers`, { path });
  if (raw.length === 0) throw new ConfigError(`${path} must not be empty`, { path });
  const match = raw.map((e, j) => toMatcher(e, `${path}[${j}]`, ctx));
  return { match };
}

function readVersion(doc: Record<string, unknown>): number {
  if (!("version" in doc)) return 1;
  const v = doc.version;
  // Stryker disable next-line ConditionalExpression: `Number.isInteger` already answers
  // false for every non-number; the typeof is what narrows `v` for the return below.
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new ConfigError("`version` must be a positive integer", { path: "version" });
  }
  return v;
}

export function parseConfig(yamlText: string): Config {
  return parseConfigDetailed(yamlText).config;
}

export function parseConfigDetailed(yamlText: string): ParseResult {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      // Stryker disable next-line OptionalChaining: `linePos` is optional in the yaml
      // library's types and set on every parse error it raises; the chain is for the
      // type, not for a case.
      const pos = e.linePos?.[0];
      // Stryker disable next-line OptionalChaining: as above.
      throw new ConfigError(`YAML syntax error: ${e.message}`, { line: pos?.line, col: pos?.col });
    }
    // Not every failure in `parse` is a YAMLParseError: an unresolved alias (`*a`) raises
    // a plain ReferenceError and a circular one a TypeError, neither carrying a position.
    // Rethrown as they are, they leave parseConfig as something that is not a ConfigError,
    // and the options page — which reports `e.message` and underlines `path` — has nothing
    // to say beyond the raw stringified error.
    throw new ConfigError(`YAML error: ${(e as Error).message}`);
  }

  // Stryker disable next-line ConditionalExpression: `parse` answers null for an empty
  // document, a comment-only one and an explicit `null`, and never undefined for a string
  // input. The second half is the contract of the value, not a case that reaches here.
  if (doc === null || doc === undefined) {
    return { config: { rules: [], groups: [] }, requiredVersion: 1, declaredVersion: 1, warnings: [] };
  }
  if (!isMapping(doc)) throw new ConfigError("config must be a mapping with `rules` and/or `groups`");

  // The one key read before anything else: it decides how the rest of the document is
  // read. A version this build cannot understand is not a reason to refuse the config —
  // it is the reason to be lenient with the parts of it we have never heard of.
  const declaredVersion = readVersion(doc);
  const ctx: Ctx = {
    lenient: declaredVersion > CONFIG_VERSION,
    declaredVersion,
    requiredVersion: 1,
    warnings: [],
  };

  // A top-level typo costs the whole config — `rulez:` matches nothing anywhere, so every
  // site opens in a throwaway while this page reports no problem at all. Loud beats that.
  for (const k of Object.keys(doc)) {
    if (Object.hasOwn(DOCUMENT_KEYS, k)) use(ctx, DOCUMENT_KEYS[k]!);
    else if (!k.startsWith(RESERVED_PREFIX)) unknownKey(ctx, k, `unknown key "${k}" at the top level`);
  }

  const rawRules = doc.rules ?? [];
  if (!Array.isArray(rawRules)) throw new ConfigError("`rules` must be a list", { path: "rules" });
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new ConfigError("`groups` must be a list", { path: "groups" });

  const rules: Rule[] = [];
  rawRules.forEach((raw, i) => {
    try {
      rules.push(parseRule(raw, i, ctx));
    } catch (e) {
      skipped(ctx, `rules[${i}]`, e);
    }
  });
  const groups: Group[] = [];
  rawGroups.forEach((raw, i) => {
    try {
      groups.push(parseGroup(raw, i, ctx));
    } catch (e) {
      skipped(ctx, `groups[${i}]`, e);
    }
  });
  return {
    config: { rules, groups },
    requiredVersion: ctx.requiredVersion,
    declaredVersion,
    warnings: ctx.warnings,
  };
}
