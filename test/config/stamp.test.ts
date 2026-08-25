import { describe, it, expect } from "vitest";
import { CONFIG_VERSION, parseConfigDetailed } from "../../src/config/parse";
import { stampVersion } from "../../src/config/stamp";

// The `version:` line is DERIVED, not authored: the editor writes what the document's
// features cost, so nobody has to know the number to get the benefit of it.
const PATTERN_RULE = `rules:\n  - match: "*://*.x.com/*"\n    open: X\n`;
const HOST_RULE = `rules:\n  - match: x.com\n`;

describe("stampVersion", () => {
  it("writes the line a config's features earn it", () => {
    expect(stampVersion(PATTERN_RULE)).toBe(`version: 2\n${PATTERN_RULE}`);
  });

  it("writes nothing for a config that needs nothing", () => {
    expect(stampVersion(HOST_RULE)).toBe(HOST_RULE);
  });

  it("leaves a line that is already right alone", () => {
    const yaml = `version: 2\n${PATTERN_RULE}`;
    expect(stampVersion(yaml)).toBe(yaml);
  });

  it("corrects a line that claims too little", () => {
    expect(stampVersion(`version: 1\n${PATTERN_RULE}`)).toBe(`version: 2\n${PATTERN_RULE}`);
  });

  it("removes a line the config no longer earns", () => {
    expect(stampVersion(`version: 2\n${HOST_RULE}`)).toBe(HOST_RULE);
  });

  it("keeps a header comment above the line it inserts", () => {
    const yaml = `# my config\n# second line\n\n${PATTERN_RULE}`;
    expect(stampVersion(yaml)).toBe(`# my config\n# second line\n\nversion: 2\n${PATTERN_RULE}`);
  });

  // The stamp is the older machine's only way to know a feature it cannot see is in there,
  // and a build in lenient mode cannot see them BY DEFINITION — it would compute a version
  // from the keys it knows, strip the marker, and disarm leniency everywhere else.
  it("does not restamp a config written by a newer build", () => {
    const yaml = `version: 99\nrules:\n  - match: x.com\n    sandbox: true\n`;
    expect(stampVersion(yaml)).toBe(yaml);
  });

  // The one the self-check cannot catch: strip the marker here and the rest still parses,
  // because what version 99 changed is what an EXISTING key means rather than which keys
  // there are. This build cannot see that, which is the whole reason it must not decide the
  // config no longer needs its marker.
  it("does not restamp a newer build's config that happens to parse here", () => {
    const yaml = `version: 99\nrules:\n  - match: x.com\n    open: X\n`;
    expect(stampVersion(yaml)).toBe(yaml);
  });

  it("leaves a config it cannot parse exactly as it found it", () => {
    const broken = `rules:\n  - match: x.com\n    open: [\n`;
    expect(stampVersion(broken)).toBe(broken);
  });

  // A top-level key sits at column 0 and block-scalar content never can, which is what
  // makes a one-line textual edit safe on a document holding a script.
  it("does not touch a version line inside a script", () => {
    const yaml =
      `rules:\n` +
      `  - match: x.com\n` +
      `    scripts:\n` +
      `      - run: |\n` +
      `          version: 1\n` +
      `          go();\n`;
    expect(stampVersion(yaml)).toBe(yaml);
  });

  it("skips an indented comment as readily as a flush one", () => {
    const yaml = `# header\n   # a note about the first rule\n${PATTERN_RULE}`;
    expect(stampVersion(yaml)).toBe(`# header\n   # a note about the first rule\nversion: 2\n${PATTERN_RULE}`);
  });

  // A line that already says the right thing is left as the user wrote it, spacing and all.
  // Rewriting it to a canonical form would be an edit nobody asked for, in a file they
  // hand-maintain.
  it("does not reformat a line that already says the right thing", () => {
    const yaml = `version:   2\n${PATTERN_RULE}`;
    expect(stampVersion(yaml)).toBe(yaml);
  });

  // The self-check earning its keep: the insert lands in a document whose shape has no room
  // for it, and what comes out does not parse. Better the text as found than a broken save.
  it("leaves a document it cannot insert into", () => {
    const flow = `{rules: [{match: "*://x.com/*", open: X}]}\n`;
    expect(stampVersion(flow)).toBe(flow);
  });

  it("strips a version line that ends the file without a newline", () => {
    expect(stampVersion(`# hi\nversion: 2`)).toBe(`# hi\n`);
  });

  it("does not strip a version line from inside a script while stamping", () => {
    const yaml =
      `rules:\n` +
      `  - match: "*://x.com/*"\n` +
      `    open: X\n` +
      `    scripts:\n` +
      `      - run: |\n` +
      `          version: 1\n`;
    expect(stampVersion(yaml)).toBe(`version: 2\n${yaml}`);
  });

  it("leaves a document that is only comments alone", () => {
    expect(stampVersion(`# nothing here\n`)).toBe(`# nothing here\n`);
  });

  it("produces text that declares exactly what it requires", () => {
    for (const yaml of [PATTERN_RULE, HOST_RULE, `version: 1\n${PATTERN_RULE}`, `version: 2\n${HOST_RULE}`]) {
      const stamped = parseConfigDetailed(stampVersion(yaml));
      expect(stamped.declaredVersion).toBe(stamped.requiredVersion);
      expect(stamped.requiredVersion).toBeLessThanOrEqual(CONFIG_VERSION);
    }
  });
});
