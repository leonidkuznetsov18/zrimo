// Conventional Commits, tightened so the generated changelog stays clean.
// `feat` → minor release, `fix`/`perf`/`revert` → patch release, a
// `BREAKING CHANGE:` footer or a `!` after the type → major release. Every
// other type is kept out of the changelog and never triggers a release.
//
// Self-contained (no shareable preset) so `npx @commitlint/cli` can run it
// from the hook and from CI without installing anything into the workspace.
export default {
  // The Conventional Commits grammar, inlined so `!` after the type and the
  // `BREAKING CHANGE:` footer are recognised without a shareable preset.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
      breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
      headerCorrespondence: ["type", "scope", "subject"],
      noteKeywords: ["BREAKING CHANGE", "BREAKING-CHANGE"],
      revertPattern:
        /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w{7,40})\b/i,
      revertCorrespondence: ["header", "hash"],
      issuePrefixes: ["#"],
    },
  },
  rules: {
    "type-empty": [2, "never"],
    "type-case": [2, "always", "lower-case"],
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "test",
      ],
    ],
    "scope-empty": [2, "never"],
    "scope-case": [2, "always", "lower-case"],
    "scope-enum": [
      2,
      "always",
      [
        "viewer",
        "core",
        "docs",
        "examples",
        "fuzz",
        "ci",
        "release",
        "deps",
        "repo",
        "brand",
      ],
    ],
    "subject-empty": [2, "never"],
    "subject-case": [2, "always", "lower-case"],
    "subject-full-stop": [2, "never", "."],
    "header-trim": [2, "always"],
    "header-max-length": [2, "always", 72],
    "body-leading-blank": [2, "always"],
    "body-max-line-length": [2, "always", 100],
    "footer-leading-blank": [2, "always"],
    "footer-max-line-length": [2, "always", 100],
  },
};
