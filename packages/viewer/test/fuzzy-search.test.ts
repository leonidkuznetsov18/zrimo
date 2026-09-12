import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AdapterOpenContext,
  DocumentAdapter,
  DocumentInfo,
  TextRun,
} from "../src/index.js";
import {
  DEFAULT_FUZZY_SEARCH_OPTIONS,
  findFuzzyPageMatches,
  nearestMatchIndex,
  pagesNearestFirst,
  resolveFuzzySearchOptions,
  ViewerClient,
} from "../src/index.js";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\nfuzzy");

const PAGES: readonly string[] = [
  "Intro page with nothing relevant on it. Marketing teams approach AI the way they approach any new software.",
  "Speed enables scale: When you can move from insight to execution in hours instead of days, you can replicate successful workflows across markets.\n\nScale creates space for humanity: When AI agents handle the routine content, your creative team has the bandwidth for breakthrough campaigns.",
  "CHAPTER 3: THE AGENTIC MINDSET\nThe five pillars give you a framework. But frameworks don’t transform organizations — people do.\n\nThis is the agentic mindset: the recognition that you’re not just consuming AI technology. You’re shaping it, directing it, and orchestrating it to do your hardest work.",
  "Appendix. This is the agentic mindset restated on a later page for reference. But agentic marketers think differently.",
];

// The citation as a model reproduces it: straight apostrophes, a missing space
// after the colon and a collapsed line break.
const CITATION =
  "the agentic mindset:the recognition that you're not just consuming AI technology. You're shaping it, directing it, and orchestrating it to do your hardest work.";

describe("findFuzzyPageMatches", () => {
  it("maps the passage back to verbatim offsets as one span per page", () => {
    const pages = PAGES.map((text, pageIndex) => ({ pageIndex, text }));
    const [match, ...rest] = findFuzzyPageMatches(
      pages,
      CITATION,
      DEFAULT_FUZZY_SEARCH_OPTIONS,
    );
    assert.equal(rest.length, 0);
    assert.equal(match?.pageIndex, 2);
    assert.equal(
      match?.text,
      "the agentic mindset: the recognition that you’re not just consuming AI technology. You’re shaping it, directing it, and orchestrating it to do your hardest work.",
    );
    assert.equal(PAGES[2]!.slice(match!.start, match!.end), match!.text);
  });

  it("tolerates list markers and table separators around the passage", () => {
    const pages = PAGES.map((text, pageIndex) => ({ pageIndex, text }));
    const matches = findFuzzyPageMatches(
      pages,
      "• Speed enables scale | When you can move from insight to execution in hours instead of days",
      DEFAULT_FUZZY_SEARCH_OPTIONS,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.pageIndex, 1);
    assert.equal(
      matches[0]?.text,
      "Speed enables scale: When you can move from insight to execution in hours instead of days",
    );
  });

  it("rejects pages above the score ceiling and honours a raised one", () => {
    const pages = PAGES.map((text, pageIndex) => ({ pageIndex, text }));
    const spanning =
      "This is the agentic mindset: the recognition that you're not just consuming AI technology. Then a sentence the model invented that appears nowhere in this document at all.";
    assert.equal(
      findFuzzyPageMatches(pages, spanning, DEFAULT_FUZZY_SEARCH_OPTIONS)
        .length,
      0,
    );
    const lenient = findFuzzyPageMatches(pages, spanning, {
      ...DEFAULT_FUZZY_SEARCH_OPTIONS,
      maxScore: 0.7,
    });
    assert.equal(lenient.length, 1);
    assert.equal(lenient[0]?.pageIndex, 2);
    assert.equal(
      lenient[0]?.text.startsWith("This is the agentic mindset"),
      true,
    );
  });

  it("finds nothing for an absent passage or a blank query", () => {
    const pages = PAGES.map((text, pageIndex) => ({ pageIndex, text }));
    assert.equal(
      findFuzzyPageMatches(
        pages,
        "quarterly revenue forecast for the fiscal year",
        DEFAULT_FUZZY_SEARCH_OPTIONS,
      ).length,
      0,
    );
    assert.equal(
      findFuzzyPageMatches(pages, "   ", DEFAULT_FUZZY_SEARCH_OPTIONS).length,
      0,
    );
  });
});

describe("option layering and ordering helpers", () => {
  it("layers viewer defaults under per-call options", () => {
    assert.equal(resolveFuzzySearchOptions(undefined, undefined), undefined);
    assert.equal(resolveFuzzySearchOptions(true, false), undefined);
    assert.deepEqual(
      resolveFuzzySearchOptions(false, true),
      DEFAULT_FUZZY_SEARCH_OPTIONS,
    );
    const resolved = resolveFuzzySearchOptions(
      { maxScore: 0.6 },
      { threshold: 0.5, pagesPerBatch: 0 },
    );
    assert.deepEqual(resolved, {
      threshold: 0.5,
      maxScore: 0.6,
      maxQueryLength: 600,
      maxPageTextLength: 20_000,
      pagesPerBatch: 2,
      pageWindow: 12,
    });
  });

  it("orders pages by distance from the hint and picks the nearest match", () => {
    assert.deepEqual(pagesNearestFirst(0, 5, 3), [3, 2, 4, 1, 5, 0]);
    assert.deepEqual(pagesNearestFirst(2, 4, undefined), [2, 3, 4]);
    const matches = [
      { pageIndex: 0, start: 0, end: 1, text: "a" },
      { pageIndex: 4, start: 0, end: 1, text: "a" },
      { pageIndex: 7, start: 0, end: 1, text: "a" },
    ];
    assert.equal(nearestMatchIndex(matches, 5), 1);
    assert.equal(nearestMatchIndex(matches, undefined), 0);
    assert.equal(nearestMatchIndex([], 5), -1);
  });
});

describe("viewer search with a page hint and fuzzy fallback", () => {
  it("activates the exact match nearest to the hint and clamps an overshooting hint", async () => {
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter()],
    }).createViewer();
    await viewer.load(pdfBytes, { fileName: "pages.pdf" });

    // Page 2 carries the phrase twice (chapter title and body), page 3 once.
    const result = await viewer.search("the agentic mindset", { nearPage: 3 });
    assert.deepEqual(
      result.matches.map((match) => match.pageIndex),
      [2, 2, 3],
    );
    assert.equal(result.activeIndex, 2);
    assert.equal(result.strategy, "exact");
    assert.equal(viewer.state.pageIndex, 3);

    const overshoot = await viewer.search("the agentic mindset", {
      nearPage: 99,
    });
    assert.equal(overshoot.activeIndex, 2);
    const before = await viewer.search("the agentic mindset", { nearPage: 1 });
    assert.equal(before.activeIndex, 0);
    assert.equal(viewer.state.pageIndex, 2);
  });

  it("is exact only unless fuzzy matching is enabled", async () => {
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter()],
    }).createViewer();
    await viewer.load(pdfBytes, { fileName: "pages.pdf" });

    assert.equal((await viewer.search(CITATION)).matches.length, 0);

    const fuzzy = await viewer.search(CITATION, { fuzzy: true, nearPage: 0 });
    assert.equal(fuzzy.strategy, "fuzzy");
    assert.equal(fuzzy.matches.length, 1);
    assert.equal(fuzzy.matches[0]?.pageIndex, 2);
    assert.equal(
      fuzzy.matches[0]?.text.startsWith("the agentic mindset: the recognition"),
      true,
    );
    assert.equal(viewer.state.pageIndex, 2);
  });

  it("applies the viewer's search defaults and lets a call override them", async () => {
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter()],
    }).createViewer({ search: { fuzzy: true } });
    await viewer.load(pdfBytes, { fileName: "pages.pdf" });

    const byDefault = await viewer.search(
      "speed enables scale:when you can move",
    );
    assert.equal(byDefault.strategy, "fuzzy");
    assert.equal(byDefault.matches[0]?.pageIndex, 1);

    const disabled = await viewer.search(
      "speed enables scale:when you can move",
      {
        fuzzy: false,
      },
    );
    assert.equal(disabled.matches.length, 0);
    assert.equal(disabled.strategy, undefined);
  });

  it("stops at the batch nearest to the hint and keeps matches inside a page range", async () => {
    const reads: number[] = [];
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter(reads)],
    }).createViewer();
    await viewer.load(pdfBytes, { fileName: "pages.pdf" });

    // Both page 2 and page 3 carry the phrase; with one page per batch the
    // scan from the hint must end on page 3 without touching page 2.
    const nearest = await viewer.search("agentic   mindset restated", {
      fuzzy: { pagesPerBatch: 1 },
      nearPage: 3,
    });
    assert.deepEqual(
      nearest.matches.map((match) => match.pageIndex),
      [3],
    );
    assert.equal(viewer.state.pageIndex, 3);

    const scoped = await viewer.search("agentic   mindset restated", {
      fuzzy: true,
      pageRange: [0, 2],
    });
    assert.equal(scoped.matches.length, 0);

    // The page window bounds the fuzzy scan around the hint: page 3 holds
    // the phrase but sits outside a one-page window around page 0.
    const windowed = await viewer.search("agentic   mindset restated", {
      fuzzy: { pageWindow: 1 },
      nearPage: 0,
    });
    assert.equal(windowed.matches.length, 0);
  });
});

function pagesAdapter(reads: number[] = []): DocumentAdapter {
  const info: DocumentInfo = {
    format: "pdf",
    unit: "page",
    pageCount: PAGES.length,
  };
  return {
    id: "pages-test",
    formats: ["pdf"],
    open: async (_data, _context: AdapterOpenContext) => ({}),
    getInfo: async () => info,
    render: async () => {},
    getTextMap: async (_handle, pageIndex) => {
      reads.push(pageIndex);
      return [run(PAGES[pageIndex] ?? "")];
    },
    close: () => {},
  };
}

function run(text: string): TextRun {
  return {
    text,
    x: 0,
    y: 0,
    width: text.length * 8,
    height: 16,
    direction: "ltr",
  };
}
