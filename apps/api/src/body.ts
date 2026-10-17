import type { IncomingMessage } from "node:http";

// Request bodies, bounded before they are buffered (T-52): a declared
// length past the bound is refused unread, and an undeclared one is read
// only up to it.

/** A body refused with `status`: 413 too large, 415 another type, 400 unreadable. */
export class BodyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`request body refused: ${status}`);
    this.status = status;
  }
}

/** The body of `req`, of at most `max` bytes and of a content type `type` matches. */
export async function readBody(req: IncomingMessage, type: RegExp, max: number): Promise<Buffer> {
  if (!type.test(req.headers["content-type"] ?? "")) throw new BodyError(415);
  const declared = req.headers["content-length"];
  if (declared !== undefined && !(Number(declared) <= max)) throw new BodyError(413);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      // Stop reading without destroying the socket, so the 413 still reaches
      // the client; the connection closes once it is sent.
      req.off("data", onData);
      req.pause();
      reject(new BodyError(413));
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}
