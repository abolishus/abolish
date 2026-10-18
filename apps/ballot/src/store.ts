// One IndexedDB transaction on one of this origin's stores (the voting
// identity's, the casts'), each database holding a single object store.

/**
 * Runs `use` on the object store `store` of the database `database`, in one
 * transaction that ends before it resolves, with what the function `use`
 * returned gives once it has.
 */
export async function withStore<T>(
  factory: IDBFactory,
  database: string,
  store: string,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => () => T,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(database, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error(`${database} didn't open`));
    open.onblocked = () => reject(new Error(`${database} is blocked`));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      // Strict durability for writes: completion then means on disk, not
      // only in the browser's cache, so what a request was sent after
      // survives a crash right after (T-18).
      const transaction = db.transaction(
        store,
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
      const result = use(transaction.objectStore(store));
      // Resolved on completion, so a write is durable before the caller goes on.
      transaction.oncomplete = () => resolve(result());
      // The failed request's own error (a ConstraintError, say), which bubbles
      // here before the transaction's is set.
      transaction.onerror = ({ target }) =>
        reject(
          (target instanceof IDBRequest ? target.error : null) ??
            transaction.error ??
            new Error(`${database} failed`),
        );
      transaction.onabort = () => reject(transaction.error ?? new Error(`${database} failed`));
    });
  } finally {
    db.close();
  }
}
