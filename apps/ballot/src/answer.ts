// Reading an answer from one of the API's routes the client calls with a
// body (registration, backups, ballots, intake): only up to a few
// kilobytes, or the size the caller knows the answer has, so a hostile or
// broken answer can't make the client buffer without bound (T-52).

// The largest answer read by default: the routes' error objects are a few hundred bytes.
export const MAX_ANSWER = 4096;

/** The body's bytes, read only up to `maxBytes`; `undefined` past it, for no body, or if it fails. */
export async function readBytes(
  response: Response,
  maxBytes = MAX_ANSWER,
): Promise<Uint8Array | undefined> {
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
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The body as JSON, read only up to `maxBytes`; `undefined` for anything else. */
export async function readJson(response: Response, maxBytes = MAX_ANSWER): Promise<unknown> {
  const bytes = await readBytes(response, maxBytes);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
