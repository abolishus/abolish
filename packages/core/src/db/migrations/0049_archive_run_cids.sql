-- A run's CID bound to its bytes where the table can derive it (docs/spec/
-- archive.md, Contract-event run; P4-3 part 4b-3a's review follow-ups;
-- src/archiving.ts). A run of at most 1 MiB is one raw block, whose CID is
-- fixed by its bytes as a record's is in 0048; a longer one is a dag-pb DAG,
-- whose CID the worker derives again before each upload (post). So a row
-- whose bytes aren't its CID's is never posted under it (T-51).

ALTER TABLE archive_runs ADD CONSTRAINT archive_runs_raw_cid CHECK (
  substring(cid FROM 1 FOR 2) <> '\x0155'::bytea OR cid = '\x01551220'::bytea || sha256(run)
);
