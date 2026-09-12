// semantic-release configuration. Runs from .github/workflows/release.yml on
// every push to main; see CONTRIBUTING.md ("Commits and releases").
//
// npm publication is opt-in: it happens only when the workflow has an
// NPM_TOKEN secret, so a repository without one still gets the changelog, the
// tag and the GitHub release with the verified tarball.
const publishToNpm = Boolean(process.env.NPM_TOKEN);

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat", section: "Features" },
            { type: "fix", section: "Bug fixes" },
            { type: "perf", section: "Performance" },
            { type: "revert", section: "Reverts" },
            { type: "docs", section: "Documentation", hidden: true },
            { type: "refactor", section: "Refactoring", hidden: true },
            { type: "test", hidden: true },
            { type: "build", hidden: true },
            { type: "ci", hidden: true },
            { type: "chore", hidden: true },
          ],
        },
      },
    ],
    [
      "@semantic-release/changelog",
      { changelogFile: "CHANGELOG.md", changelogTitle: "# Changelog" },
    ],
    [
      "@semantic-release/exec",
      { prepareCmd: "node scripts/prepare-release.mjs ${nextRelease.version}" },
    ],
    // Publishes the package that prepare-release.mjs already built and
    // verified; the version bump itself happens there (npm version --workspace).
    [
      "@semantic-release/npm",
      { pkgRoot: "packages/viewer", npmPublish: publishToNpm },
    ],
    [
      "@semantic-release/git",
      {
        assets: [
          "CHANGELOG.md",
          "package.json",
          "package-lock.json",
          "packages/viewer/package.json",
          "release-status.json",
        ],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    [
      "@semantic-release/github",
      {
        // The repository has issues disabled, so the plugin's "release failed"
        // issue cannot be created; the workflow log is the failure report.
        failComment: false,
        failTitle: false,
        assets: [
          {
            path: ".cache/pack-test/web-doc-*.tgz",
            label: "web-doc npm tarball",
          },
          { path: ".cache/pack-test/SHA256SUMS", label: "SHA256SUMS" },
          {
            path: "artifacts/pack-report.json",
            label: "Package content report",
          },
        ],
      },
    ],
  ],
};
