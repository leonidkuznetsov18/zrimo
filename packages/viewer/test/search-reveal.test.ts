import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TextRun } from "../src/index.js";
import { matchTopInPage, revealScrollTop } from "../src/index.js";

function run(text: string, y: number, logical?: [number, number]): TextRun {
  return {
    text,
    x: 0,
    y,
    width: text.length * 6,
    height: 12,
    ...(logical ? { logicalStart: logical[0], logicalEnd: logical[1] } : {}),
  };
}

describe("matchTopInPage", () => {
  it("returns the y of the first run the match overlaps, counting offsets like the highlight layer", () => {
    const runs = [run("Hello ", 10), run("world ", 30), run("again", 50)];
    assert.equal(
      matchTopInPage(runs, { pageIndex: 0, start: 8, end: 12, text: "orld" }),
      30,
    );
    // A match spanning two runs starts on the first of them.
    assert.equal(
      matchTopInPage(runs, { pageIndex: 0, start: 4, end: 9, text: "o wor" }),
      10,
    );
  });

  it("honours explicit logical offsets and reports nothing for an unmatched range", () => {
    const runs = [run("cell", 5, [100, 104]), run("text", 25, [200, 204])];
    assert.equal(
      matchTopInPage(runs, { pageIndex: 0, start: 201, end: 203, text: "ex" }),
      25,
    );
    assert.equal(
      matchTopInPage(runs, { pageIndex: 0, start: 150, end: 160, text: "" }),
      undefined,
    );
  });
});

describe("revealScrollTop", () => {
  it("places the match a third down the viewport but never scrolls above the page top", () => {
    assert.equal(
      revealScrollTop({ pageTop: 1000, matchTop: 900, viewportHeight: 600 }),
      1700,
    );
    assert.equal(
      revealScrollTop({ pageTop: 1000, matchTop: 50, viewportHeight: 600 }),
      1000,
    );
  });
});
