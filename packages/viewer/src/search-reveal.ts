import type { SearchMatch, TextRun } from "./contracts.js";

/**
 * Vertical position of a match inside its page, in the coordinate units of
 * the page's text layer: the `y` of the first run the match overlaps.
 * Offsets follow the same convention as the highlight layers (a run's
 * explicit `logicalStart`/`logicalEnd`, else the running text length), so
 * the position agrees with where the highlight is painted. `undefined` when
 * no run overlaps the match.
 */
export function matchTopInPage(
  runs: readonly TextRun[],
  match: SearchMatch,
): number | undefined {
  let offset = 0;
  for (const run of runs) {
    const start = run.logicalStart ?? offset;
    const end = run.logicalEnd ?? start + run.text.length;
    offset = end;
    if (match.start < end && match.end > start) return run.y;
  }
  return undefined;
}

/**
 * Scroll offset that places a match about a third of the way down the
 * viewport — far enough from the top edge to read the line before it, never
 * above the page's own top so a match near the top of a page still shows the
 * page head. `matchTop` is the match's offset from the page top in CSS px.
 */
export function revealScrollTop(options: {
  readonly pageTop: number;
  readonly matchTop: number;
  readonly viewportHeight: number;
}): number {
  const lead = Math.max(0, options.viewportHeight) / 3;
  return Math.max(options.pageTop, options.pageTop + options.matchTop - lead);
}
