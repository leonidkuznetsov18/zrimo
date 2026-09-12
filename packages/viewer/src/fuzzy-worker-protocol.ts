import type { SearchMatch } from "./contracts.js";
import { FuzzyPageIndex, type FuzzyPageText } from "./fuzzy-search.js";

/**
 * Messages between the viewer and the fuzzy-search worker. The worker holds
 * one {@link FuzzyPageIndex} at a time: `index` replaces it, `search` runs
 * against it. Every request is answered by exactly one reply with its `id`.
 */
export type FuzzyWorkerRequest =
  | {
      readonly kind: "index";
      readonly id: number;
      readonly pages: readonly FuzzyPageText[];
      readonly threshold: number;
      readonly maxPageTextLength: number;
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: "search";
      readonly id: number;
      readonly query: string;
      readonly maxScore: number;
      readonly pageIndices?: readonly number[];
    };

export type FuzzyWorkerReply =
  | {
      readonly kind: "indexed";
      readonly id: number;
      readonly pageCount: number;
    }
  | {
      readonly kind: "matches";
      readonly id: number;
      readonly matches: readonly SearchMatch[];
    }
  | { readonly kind: "failure"; readonly id: number; readonly message: string };

export interface FuzzyWorkerState {
  index?: FuzzyPageIndex;
}

/** Apply one request to the worker's state and produce its reply. */
export function handleFuzzyWorkerRequest(
  state: FuzzyWorkerState,
  request: FuzzyWorkerRequest,
): FuzzyWorkerReply {
  try {
    if (request.kind === "index") {
      state.index = new FuzzyPageIndex(
        request.pages,
        {
          threshold: request.threshold,
          maxPageTextLength: request.maxPageTextLength,
        },
        request.caseSensitive,
      );
      return {
        kind: "indexed",
        id: request.id,
        pageCount: state.index.pageCount,
      };
    }
    if (!state.index)
      return {
        kind: "failure",
        id: request.id,
        message: "No document is indexed",
      };
    return {
      kind: "matches",
      id: request.id,
      matches: state.index.search(
        request.query,
        request.maxScore,
        request.pageIndices,
      ),
    };
  } catch (error) {
    return {
      kind: "failure",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
