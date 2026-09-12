import type { SearchMatch } from "./contracts.js";
import { ViewerError } from "./errors.js";
import type { FuzzyPageText } from "./fuzzy-search.js";
import type {
  FuzzyWorkerReply,
  FuzzyWorkerRequest,
} from "./fuzzy-worker-protocol.js";

/** The slice of `Worker` the client needs; tests pass a fake. */
export interface FuzzyWorkerTransport {
  postMessage(message: FuzzyWorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FuzzyWorkerReply>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  terminate(): void;
}

/**
 * Main-thread side of the fuzzy-search worker. Bitap over a long document
 * is CPU work that used to run on the main thread and freeze the page; the
 * worker keeps the document's index and answers each search off-thread.
 */
export class FuzzyWorkerClient {
  readonly #worker: FuzzyWorkerTransport;
  readonly #pending = new Map<
    number,
    {
      resolve: (reply: FuzzyWorkerReply) => void;
      reject: (error: Error) => void;
    }
  >();
  #nextId = 1;
  #dead: Error | undefined;

  constructor(worker: FuzzyWorkerTransport) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      pending.resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.#fail(
        new ViewerError("worker-crashed", "Fuzzy search worker crashed", {
          details: { message: (event as ErrorEvent).message },
        }),
      );
    });
  }

  /** Spawn the bundled worker script; `undefined` where workers do not exist. */
  static create(workerUrl: URL): FuzzyWorkerClient | undefined {
    if (typeof Worker === "undefined") return undefined;
    return new FuzzyWorkerClient(
      new Worker(workerUrl, { type: "module", name: "fuzzy-search" }),
    );
  }

  async index(
    pages: readonly FuzzyPageText[],
    options: {
      readonly threshold: number;
      readonly maxPageTextLength: number;
      readonly caseSensitive: boolean;
    },
  ): Promise<number> {
    const reply = await this.#send({ kind: "index", id: 0, pages, ...options });
    if (reply.kind !== "indexed") throw unexpected(reply);
    return reply.pageCount;
  }

  async search(
    query: string,
    maxScore: number,
    pageIndices?: readonly number[],
  ): Promise<readonly SearchMatch[]> {
    const reply = await this.#send({
      kind: "search",
      id: 0,
      query,
      maxScore,
      ...(pageIndices ? { pageIndices } : {}),
    });
    if (reply.kind !== "matches") throw unexpected(reply);
    return reply.matches;
  }

  terminate(): void {
    this.#fail(
      new ViewerError("lifecycle-error", "Fuzzy search worker was terminated"),
    );
    this.#worker.terminate();
  }

  #send(request: FuzzyWorkerRequest): Promise<FuzzyWorkerReply> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id });
    });
  }

  #fail(error: Error): void {
    this.#dead = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function unexpected(reply: FuzzyWorkerReply): ViewerError {
  return new ViewerError(
    "render-failed",
    reply.kind === "failure"
      ? reply.message
      : `Unexpected worker reply: ${reply.kind}`,
  );
}
