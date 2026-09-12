import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fitInlineImagesToPage } from "../src/index.js";

const LETTER = {
  pageWidth: 612,
  pageHeight: 792,
  marginLeft: 72,
  marginRight: 72,
  marginTop: 72,
  marginBottom: 72,
};

function image(widthPt: number, heightPt: number, anchor = false) {
  return { type: "image", widthPt, heightPt, anchor };
}

describe("fitInlineImagesToPage", () => {
  it("shrinks an inline picture wider than the text area, keeping its aspect ratio", () => {
    const wide = image(1536, 864); // 21.3 x 12 in on a 6.5 in column
    const model = {
      section: LETTER,
      body: [
        { type: "paragraph", runs: [wide, { type: "text", text: "caption" }] },
      ],
    };
    assert.equal(fitInlineImagesToPage(model), 1);
    assert.equal(wide.widthPt, 468);
    assert.equal(Math.round(wide.heightPt), 263);
  });

  it("also bounds a tall picture by the content height", () => {
    const tall = image(400, 1500);
    fitInlineImagesToPage({
      section: LETTER,
      body: [{ type: "paragraph", runs: [tall] }],
    });
    assert.equal(tall.heightPt, 648);
    assert.equal(tall.widthPt, 172.8);
  });

  it("leaves pictures that fit and anchored pictures alone", () => {
    const fits = image(300, 200);
    const floating = image(2000, 500, true);
    const scaled = fitInlineImagesToPage({
      section: LETTER,
      body: [{ type: "paragraph", runs: [fits, floating] }],
    });
    assert.equal(scaled, 0);
    assert.deepEqual([fits.widthPt, floating.widthPt], [300, 2000]);
  });

  it("reaches pictures inside table cells and uses the geometry of the section that ends after them", () => {
    const inCell = image(1000, 500);
    const later = image(1000, 500);
    const narrow = { ...LETTER, marginLeft: 200, marginRight: 200 }; // 212 pt column
    const model = {
      section: LETTER,
      body: [
        {
          type: "table",
          rows: [
            { cells: [{ content: [{ type: "paragraph", runs: [inCell] }] }] },
          ],
        },
        { type: "sectionBreak", kind: "nextPage", geom: narrow },
        { type: "paragraph", runs: [later] },
      ],
    };
    assert.equal(fitInlineImagesToPage(model), 2);
    assert.equal(inCell.widthPt, 212);
    assert.equal(later.widthPt, 468);
  });
});
