// Strict JSON for request bodies. `JSON.parse` keeps the last of two equal
// keys in an object, so `{"ballot": A, "ballot": B}` reads as B here while a
// proxy, a log filter or another parser in front may read A: two components
// would judge different inputs from the same bytes (T-31). A body with a
// duplicate key is refused before anything reads it.

/**
 * Whether any object in `text` has two keys that are equal once unescaped
 * (`"a"` and `"\u0061"` are the same key). `text` must already have parsed
 * with `JSON.parse`: the scan relies on it being well-formed and checks
 * nothing else. It keeps its own stack rather than recursing, so nesting
 * depth costs memory, never the call stack.
 */
export function hasDuplicateKey(text: string): boolean {
  // One entry per open container: the keys seen so far for an object, or
  // `undefined` for an array.
  const stack: (Set<string> | undefined)[] = [];
  // Whether the next string in the innermost object is a key.
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    switch (text[i]) {
      case "{":
        stack.push(new Set());
        expectKey = true;
        break;
      case "[":
        stack.push(undefined);
        expectKey = false;
        break;
      case "}":
      case "]":
        stack.pop();
        expectKey = false;
        break;
      case ",":
        expectKey = stack.at(-1) !== undefined;
        break;
      case '"': {
        const start = i;
        // Skip the character after every backslash, so an escaped quote never
        // ends the string; a `\u` escape's hex digits are never quotes.
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
        if (expectKey) {
          const keys = stack.at(-1) as Set<string>;
          const key = JSON.parse(text.slice(start, i + 1)) as string;
          if (keys.has(key)) return true;
          keys.add(key);
          expectKey = false;
        }
        break;
      }
      // Anything else is whitespace, a colon, or part of a number or literal.
    }
  }
  return false;
}
