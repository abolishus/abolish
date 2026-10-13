// Ponder requires an API module. The indexer serves nothing of its own yet
// beyond Ponder's `/health`, `/ready` and `/status`: no GraphQL and no SQL
// over HTTP, so nothing reaches the database through this process but the
// indexing itself. Readers query Postgres (src/records.ts).

import { Hono } from "hono";

export default new Hono();
