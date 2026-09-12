import Fuse from "fuse.js";

import type { FuzzySearchOptions, SearchMatch } from "./contracts.js";

/**
 * Fuzzy matching is delegated to Fuse.js (Bitap with a bounded edit budget per
 * 32-character chunk). It bridges the gaps NFKC + case folding leave open when
 * a query was not copied verbatim from the document: AI-generated citations
 * and OCR'd passages differ from the source in spacing, line breaks, list
 * bullets, table separators and typographic punctuation. Every hit maps back
 * to original UTF-16 offsets, so the viewport highlights the verbatim text.
 */
export interface ResolvedFuzzySearchOptions {
  readonly threshold: number;
  readonly maxScore: number;
  readonly maxQueryLength: number;
  readonly maxPageTextLength: number;
  readonly pagesPerBatch: number;
  readonly pageWindow: number;
}

export const DEFAULT_FUZZY_SEARCH_OPTIONS: ResolvedFuzzySearchOptions =
  Object.freeze({
    threshold: 0.3,
    maxScore: 0.4,
    // Bitap cost grows with the query; 600 characters still identifies a
    // passage while keeping a page under ~100 ms on a laptop.
    maxQueryLength: 600,
    maxPageTextLength: 20_000,
    pagesPerBatch: 2,
    pageWindow: 12,
  });

/**
 * Layer fuzzy settings in precedence order (viewer defaults first, then the
 * per-call option). `true` enables the defaults, an object enables and
 * overrides them, `false` disables, `undefined` leaves the previous layer in
 * place. Returns `undefined` when fuzzy matching ends up disabled.
 */
export function resolveFuzzySearchOptions(
  ...layers: readonly (boolean | FuzzySearchOptions | undefined)[]
): ResolvedFuzzySearchOptions | undefined {
  let enabled = false;
  let resolved: ResolvedFuzzySearchOptions = DEFAULT_FUZZY_SEARCH_OPTIONS;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (typeof layer === "boolean") {
      enabled = layer;
      continue;
    }
    enabled = true;
    resolved = {
      threshold: unitInterval(layer.threshold, resolved.threshold),
      maxScore: unitInterval(layer.maxScore, resolved.maxScore),
      maxQueryLength: positiveInteger(
        layer.maxQueryLength,
        resolved.maxQueryLength,
      ),
      maxPageTextLength: positiveInteger(
        layer.maxPageTextLength,
        resolved.maxPageTextLength,
      ),
      pagesPerBatch: positiveInteger(
        layer.pagesPerBatch,
        resolved.pagesPerBatch,
      ),
      pageWindow: positiveInteger(layer.pageWindow, resolved.pageWindow),
    };
  }
  return enabled ? resolved : undefined;
}

export interface FuzzyPageText {
  readonly pageIndex: number;
  readonly text: string;
}

/**
 * One match per page whose text holds the query within the edit budget: the
 * span from the first to the last matched character, so the highlight covers
 * the passage as one block. Pages are returned in page order.
 */
export function findFuzzyPageMatches(
  pages: readonly FuzzyPageText[],
  query: string,
  options: ResolvedFuzzySearchOptions,
  caseSensitive = false,
): readonly SearchMatch[] {
  const pattern = query.slice(0, options.maxQueryLength);
  if (!pattern.trim()) return [];
  const items = pages.map((page) => ({
    pageIndex: page.pageIndex,
    text: page.text.slice(0, options.maxPageTextLength),
  }));
  const fuse = new Fuse(items, {
    keys: ["text"],
    isCaseSensitive: caseSensitive,
    ignoreDiacritics: false,
    includeMatches: true,
    includeScore: true,
    // A citation can sit anywhere on the page; Fuse's location bias would
    // otherwise penalize matches far from the start of the text.
    ignoreLocation: true,
    // Long page text must not dilute the score of a match inside it.
    ignoreFieldNorm: true,
    threshold: options.threshold,
    minMatchCharLength: 3,
    shouldSort: false,
  });
  const matches: SearchMatch[] = [];
  for (const result of fuse.search(pattern)) {
    if ((result.score ?? 1) > options.maxScore) continue;
    const indices = result.matches?.[0]?.indices ?? [];
    if (indices.length === 0) continue;
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const [first, last] of indices) {
      start = Math.min(start, first);
      end = Math.max(end, last + 1);
    }
    const text = result.item.text.slice(start, end);
    matches.push({ pageIndex: result.item.pageIndex, start, end, text });
  }
  return matches.sort((a, b) => a.pageIndex - b.pageIndex);
}

/** Page indices of `[first, last]` ordered by distance from `nearPage`, ties earlier-first. */
export function pagesNearestFirst(
  first: number,
  last: number,
  nearPage: number | undefined,
): number[] {
  const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  if (nearPage === undefined) return pages;
  return pages.sort(
    (a, b) => Math.abs(a - nearPage) - Math.abs(b - nearPage) || a - b,
  );
}

/** Index of the match closest to `nearPage`; the first match when there is no hint. */
export function nearestMatchIndex(
  matches: readonly SearchMatch[],
  nearPage: number | undefined,
): number {
  if (matches.length === 0) return -1;
  if (nearPage === undefined) return 0;
  let best = 0;
  for (let index = 1; index < matches.length; index += 1)
    if (
      Math.abs(matches[index]!.pageIndex - nearPage) <
      Math.abs(matches[best]!.pageIndex - nearPage)
    )
      best = index;
  return best;
}

function unitInterval(value: number | undefined, fallback: number): number {
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
