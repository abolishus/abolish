-- Database roles (packages/core/README.md). Run once per cluster by an
-- administrator, before any migration; idempotent, and safe to run
-- concurrently. Both are group roles without LOGIN: deployments log in as
-- their own users and are granted one of them, so no running service holds
-- the owner's privileges (T-23).
--   abolish_migrator  owns the schema and runs migrations (DDL)
--   abolish_app       runtime: on board tables, SELECT and INSERT only
DO $$
BEGIN
  CREATE ROLE abolish_migrator NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
DO $$
BEGIN
  CREATE ROLE abolish_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
