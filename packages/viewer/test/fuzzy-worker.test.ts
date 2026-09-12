import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type {
  AdapterOpenContext,
  DocumentAdapter,
  DocumentInfo,
  FuzzyWorkerReply,
  FuzzyWorkerRequest,
  FuzzyWorkerState,
  FuzzyWorkerTransport,
  TextRun,
} from "../src/index.js";
import {
  FuzzyPageIndex,
  FuzzyWorkerClient,
  handleFuzzyWorkerRequest,
  ViewerClient,
} from "../src/index.js";

const PAGES = [
  { pageIndex: 0, text: "Intro page with nothing relevant on it." },
  {
    pageIndex: 1,
    text: "Speed enables scale: When you can move from insight to execution in hours instead of days.",
  },
  {
    pageIndex: 2,
    text: "This is the agentic mindset: the recognition that you’re not just consuming AI technology.",
  },
  {
    pageIndex: 3,
    text: "Appendix. This is the agentic mindset restated on a later page.",
  },
];
const CITATION =
  "the agentic mindset:the recognition that you're not just consuming";

describe("FuzzyPageIndex", () => {
  it("reuses one index for the whole document and for a page window", () => {
    const index = new FuzzyPageIndex(PAGES, {
      threshold: 0.3,
      maxPageTextLength: 20_000,
    });
    assert.equal(index.pageCount, 4);
    assert.deepEqual(
      index.search("agentic   mindset", 0.4).map((match) => match.pageIndex),
      [2, 3],
    );
    assert.deepEqual(
      index
        .search("agentic   mindset", 0.4, [3])
        .map((match) => match.pageIndex),
      [3],
    );
    assert.equal(index.search(CITATION, 0.4, [0, 1]).length, 0);
  });
});

describe("handleFuzzyWorkerRequest", () => {
  it("indexes once and answers searches, failing cleanly without an index", () => {
    const state: FuzzyWorkerState = {};
    const unindexed = handleFuzzyWorkerRequest(state, {
      kind: "search",
      id: 1,
      query: "x",
      maxScore: 0.4,
    });
    assert.equal(unindexed.kind, "failure");

    const indexed = handleFuzzyWorkerRequest(state, {
      kind: "index",
      id: 2,
      pages: PAGES,
      threshold: 0.3,
      maxPageTextLength: 20_000,
      caseSensitive: false,
    });
    assert.deepEqual(indexed, { kind: "indexed", id: 2, pageCount: 4 });

    const found = handleFuzzyWorkerRequest(state, {
      kind: "search",
      id: 3,
      query: CITATION,
      maxScore: 0.4,
      pageIndices: [2, 3],
    });
    assert.equal(found.kind, "matches");
    assert.equal(found.kind === "matches" && found.matches[0]?.pageIndex, 2);
  });
});

/** A transport that runs the worker's handler inline, one reply per request. */
function inlineTransport(log: FuzzyWorkerRequest[] = []) {
  const state: FuzzyWorkerState = {};
  let onMessage: ((event: MessageEvent<FuzzyWorkerReply>) => void) | undefined;
  let terminated = 0;
  const transport: FuzzyWorkerTransport = {
    postMessage(message) {
      log.push(message);
      const reply = handleFuzzyWorkerRequest(state, message);
      queueMicrotask(() =>
        onMessage?.({ data: reply } as MessageEvent<FuzzyWorkerReply>),
      );
    },
    addEventListener(type: string, listener: unknown) {
      if (type === "message") onMessage = listener as typeof onMessage;
    },
    terminate() {
      terminated += 1;
    },
  };
  return { transport, log, terminated: () => terminated };
}

describe("FuzzyWorkerClient", () => {
  it("correlates replies by id and rejects everything once terminated", async () => {
    const { transport, log, terminated } = inlineTransport();
    const client = new FuzzyWorkerClient(transport);
    assert.equal(
      await client.index(PAGES, {
        threshold: 0.3,
        maxPageTextLength: 20_000,
        caseSensitive: false,
      }),
      4,
    );
    const matches = await client.search(CITATION, 0.4, [2]);
    assert.equal(matches[0]?.pageIndex, 2);
    assert.deepEqual(
      log.map((request) => request.id),
      [1, 2],
    );
    client.terminate();
    assert.equal(terminated(), 1);
    await assert.rejects(client.search("x", 0.4));
  });
});

describe("viewer fuzzy search through the worker", () => {
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = originalWorker;
  });

  it("indexes the document once, searches off-thread, and releases the worker on close", async () => {
    const spawned: {
      url: string;
      log: FuzzyWorkerRequest[];
      terminated: () => number;
    }[] = [];
    (globalThis as { Worker?: unknown }).Worker = class {
      readonly #inline;
      constructor(url: URL) {
        const log: FuzzyWorkerRequest[] = [];
        this.#inline = inlineTransport(log);
        spawned.push({
          url: url.href,
          log,
          terminated: this.#inline.terminated,
        });
      }
      postMessage(message: FuzzyWorkerRequest) {
        this.#inline.transport.postMessage(message);
      }
      addEventListener(type: "message" | "error", listener: unknown) {
        this.#inline.transport.addEventListener(
          type as "message",
          listener as never,
        );
      }
      terminate() {
        this.#inline.transport.terminate();
      }
    };
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter()],
      assetBaseUrl: "https://cdn.example.com/web-doc/",
    }).createViewer();
    await viewer.load(new TextEncoder().encode("%PDF-1.7\nworker"), {
      fileName: "pages.pdf",
    });

    const first = await viewer.search(CITATION, { fuzzy: true, nearPage: 3 });
    assert.equal(first.strategy, "fuzzy");
    assert.equal(first.matches[0]?.pageIndex, 2);
    const second = await viewer.search(
      "speed enables scale:when you can move",
      { fuzzy: true, nearPage: 1 },
    );
    assert.equal(second.matches[0]?.pageIndex, 1);

    assert.equal(spawned.length, 1);
    assert.equal(
      spawned[0]?.url,
      "https://cdn.example.com/web-doc/workers/fuzzy-search-worker.js",
    );
    // One index for both searches; the searches carry their page windows.
    assert.deepEqual(
      spawned[0]?.log.map((request) => request.kind),
      ["index", "search", "search"],
    );
    const windowed = spawned[0]?.log[1];
    assert.equal(windowed?.kind === "search" && windowed.pageIndices?.[0], 3);

    await viewer.close();
    assert.equal(spawned[0]?.terminated(), 1);
  });

  it("falls back to the main thread when the worker cannot be created", async () => {
    (globalThis as { Worker?: unknown }).Worker = class {
      constructor() {
        throw new Error("no workers here");
      }
    };
    const viewer = ViewerClient.create({
      adapters: [pagesAdapter()],
    }).createViewer();
    await viewer.load(new TextEncoder().encode("%PDF-1.7\nworker"), {
      fileName: "pages.pdf",
    });
    const result = await viewer.search(CITATION, { fuzzy: true, nearPage: 2 });
    assert.equal(result.strategy, "fuzzy");
    assert.equal(result.matches[0]?.pageIndex, 2);
  });
});

function pagesAdapter(): DocumentAdapter {
  const info: DocumentInfo = {
    format: "pdf",
    unit: "page",
    pageCount: PAGES.length,
  };
  return {
    id: "pages-worker-test",
    formats: ["pdf"],
    open: async (_data, _context: AdapterOpenContext) => ({}),
    getInfo: async () => info,
    render: async () => {},
    getTextMap: async (_handle, pageIndex) => [
      run(PAGES[pageIndex]?.text ?? ""),
    ],
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
