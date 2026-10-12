// The ballot worker's entry point. It answers the page's requests and does
// nothing else: no network, storage or code loading (the owner-reviewed bundle
// check bans those APIs from any script the page doesn't load itself, and the
// e2e watches it run; T-43). Errors become a bare "error" response, never a
// message or stack, which could carry a secret.

import { checkElection } from "../election.ts";
import { parseRequest, PROTOCOL_VERSION, requestId, type WorkerResponse } from "./protocol.ts";

// DedicatedWorkerGlobalScope isn't in the DOM library this package compiles with.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = ({ data }) => {
  const request = parseRequest(data);
  if (request === undefined) {
    // Without an id there is no request to answer; the page's timeout ends it.
    const id = requestId(data);
    if (id !== undefined) scope.postMessage({ v: PROTOCOL_VERSION, id, kind: "error" });
    return;
  }
  let response: WorkerResponse;
  try {
    response = {
      v: PROTOCOL_VERSION,
      id: request.id,
      kind: "check-election",
      result: checkElection(request.electionId, request.definition, request.displayText),
    };
  } catch {
    response = { v: PROTOCOL_VERSION, id: request.id, kind: "error" };
  }
  scope.postMessage(response);
};
