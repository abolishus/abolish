-- Database roles (packages/core/README.md). Run once per cluster by an
-- administrator, before any migration; idempotent, and safe to run
-- concurrently. Both are group roles without LOGIN: deployments log in as
-- their own users and are granted one of them, so no running service holds
-- the owner's privileges (T-23).
--   abolish_migrator  owns the schema and runs migrations (DDL)
--   abolish_app       runtime: on board tables, SELECT and INSERT only
-- One transaction under a cluster-wide advisory lock: concurrent ALTER ROLEs
-- on the same role fail with "tuple concurrently updated", so runs queue.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('abolish/roles.sql'));
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
-- A role that already existed keeps whatever it had, so pin the attributes
-- and refuse a runtime role that can act as the owner.
ALTER ROLE abolish_migrator NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
ALTER ROLE abolish_app NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
DO $$
BEGIN
  IF pg_has_role('abolish_app', 'abolish_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'abolish_app must not be a member of abolish_migrator';
  END IF;
END
$$;
COMMIT;
