import {
  handleFuzzyWorkerRequest,
  type FuzzyWorkerRequest,
  type FuzzyWorkerState,
} from "./fuzzy-worker-protocol.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const state: FuzzyWorkerState = {};
workerScope.onmessage = (event: MessageEvent<FuzzyWorkerRequest>) => {
  workerScope.postMessage(handleFuzzyWorkerRequest(state, event.data));
};
