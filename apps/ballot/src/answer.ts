// Reading a JSON answer from one of the API's routes the client calls with
// a body (registration, backups, ballots): only up to a few kilobytes, or the
// size the caller knows the answer has, so a hostile or broken answer can't
// make the client buffer without bound (T-52).

// The largest answer read by default: the routes' error objects are a few hundred bytes.
export const MAX_ANSWER = 4096;

/** The body as JSON, read only up to `maxBytes`; `undefined` for anything else. */
export async function readJson(response: Response, maxBytes = MAX_ANSWER): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
