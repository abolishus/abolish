# Railway

How Abolish runs on Railway: what the owner creates by hand, how images are built, and how to deploy, roll back, rotate secrets, recover from a lost database and keep going if Railway, Cloudflare or a domain is taken from us. Design from [[P2-11]]; the brief's rule is that Railway deploys prebuilt, signed images and never builds from source ([[PROJECT_BRIEF]], Tech stack).

Postgres is not authoritative: wiping it loses no result (T-66). Nothing on Railway holds a ballot's plaintext; the API sees ciphertexts and proofs only (T-09).

Status: the API image (this runbook, Building) exists. The `ci: deploy` workflow that builds, signs and deploys it is P2-11 part 2; until it merges, nothing deploys, and the steps below marked _(part 2)_ describe what it will do. The worker (P2-4), web (P2-9) and ballot client (P2-8) add their own sections as they land.

## What the owner creates by hand

Agents can't reach Railway or Cloudflare. Everything here is a one-time setup in the Railway dashboard (one project, two environments: `staging` and `production`) and in Cloudflare.

### Postgres

One Railway Postgres per environment. Its default user is the cluster owner: use it only for the setup below and keep its URL out of every service's variables.

1. As the owner user, run `packages/core/src/db/roles.sql` once. It creates the `NOLOGIN` group roles `abolish_migrator` (owns the schema, runs migrations) and `abolish_app` (runtime: `SELECT` and `INSERT` only on board tables).
2. Create the schema and one login per job, each with its own generated password:

   ```sql
   CREATE SCHEMA abolish AUTHORIZATION abolish_migrator;
   CREATE ROLE abolish_migrate LOGIN PASSWORD '…' IN ROLE abolish_migrator;
   CREATE ROLE abolish_api LOGIN PASSWORD '…' IN ROLE abolish_app;
   ALTER ROLE abolish_api SET search_path = abolish;
   ```

3. Only the `api-migrate` service gets `abolish_migrate`'s URL; only `api` gets `abolish_api`'s. A compromised API can then append to the board but never alter a table, a trigger or a grant (T-23, T-65).

### Dragonfly

Not used by the API. The worker (P2-4) needs it: a service from `docker.dragonflydb.io/dragonflydb/dragonfly`, pinned by digest, started with `--cluster_mode=emulated --lock_on_hashtags` and a password (`--requirepass`), on the private network only, with no public domain. Its contents are ephemeral (rate limits, queues); losing them loses no result.

### Services

Each service's source is a container image, set by digest by the deploy workflow _(part 2)_, never a repository: Railway never builds (T-61). Each service has no public domain unless listed.

| Service       | Command                    | Variables                                                     | Notes                                                                                                                                            |
| ------------- | -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-migrate` | `node migrate.mjs`         | `DATABASE_URL` (`abolish_migrate`), `DATABASE_SCHEMA=abolish` | Restart policy: never. Applies pending migrations and exits; deployed before `api`, which waits for it to succeed.                               |
| `api`         | image default (`main.mjs`) | `DATABASE_URL` (`abolish_api`), `API_PORT=8787`               | Public domain, behind Cloudflare. `API_HOST` is `0.0.0.0` in the image; set `::` if a service must reach it over Railway's IPv6 private network. |

Both use the same image digest, so a deploy never runs an API against migrations other than its own. No other variable is needed; secrets live only in Railway variables, never in the image or the repository.

There is no health endpoint yet, so Railway's deploy health check stays off: a deploy whose process exits shows as crashed, but one that starts and then fails every query doesn't. Add `/health` and turn the check on with the next API change.

### Railway tokens

One Railway project token per environment, scoped to that environment, stored as `RAILWAY_TOKEN` in the matching GitHub environment (`staging`: `main` only, no reviewer; `production`: the `prod` branch only, owner approval). Never a repository secret: a workflow run from a PR branch can read repository secrets but not these (T-65). PR environments, if any, get a token that reaches neither.

### Cloudflare

- DNS: `api.<domain>` proxied (orange cloud) to the `api` service's Railway domain; SSL mode Full (strict).
- WAF managed rules on; a rate-limiting rule per client address on `POST /ballots` and on the whole API host (T-48, T-52). The API also caps requests in flight (`apps/api` README, Transport); per-address limits are Cloudflare's job.
- Logs (T-11): no Logpush job, no Log Explorer, nothing that retains client addresses or query strings. Cloudflare still sees every address in transit; that's T-11's residual.
- Turnstile on Tier 0 actions comes with the web app (P2-9); never on ballot submission, which must work without our domain (T-25).

Railway's own HTTP logs record request paths and may record client addresses; we can't turn them off. Ballot submission carries no account session, so they can't join an account to a ballot (T-10), but they add one more party that sees addresses (T-11).

## Building

An image is built from a commit twice, on separate runners, and is deployed only if both builds give the same image manifest digest (T-61). From the repository root:

```sh
vp install --frozen-lockfile
vp run --filter @abolishus/crypto build
vp run --filter @abolishus/api build    # type-checks, then bundles into apps/api/dist
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" docker buildx build \
  --platform linux/amd64 \
  --output type=oci,dest=api.tar,rewrite-timestamp=true \
  apps/api
```

- `apps/api/dist` is the whole program: `main.mjs`, `migrate.mjs`, one shared chunk with every dependency inlined, and `migrations/`, the SQL files from `packages/core`. `repro-build` already checks that it's byte-identical across checkouts.
- The image (`apps/api/Dockerfile`) is the Node base pinned by digest, at the version in `.node-version` (a test checks it), with the package managers removed and `dist/` copied in root-owned and read-only, run as `node`. `.dockerignore` lets only `dist/` into the context.
- `SOURCE_DATE_EPOCH` plus `rewrite-timestamp=true` clamp every file time in the new layers to the commit time, so the digest doesn't depend on when or where it was built. Checked on 2026-10-11: two builds of the same commit, one with a fresh `dist/` built under a different umask, gave the same OCI archive, byte for byte.
- _(part 2)_ The workflow pushes the image to `ghcr.io/abolishus/abolish-api`, signs the digest with cosign keyless signing and attaches SLSA provenance. Provenance and signatures are separate manifests that refer to the image; they don't change its digest.

## Deploying

_(part 2)_ Every merge to `main`: build twice and compare, push, sign, then in the `staging` environment set `api-migrate` to the new digest and run it; once it exits 0, set `api` to the same digest. Then the reference election runs against staging. A production deploy happens only when the owner fast-forwards `prod` to a commit on `main`; it never rebuilds. It finds that commit's digest, verifies its signature and provenance, checks that the reference election passed on staging for that digest, waits for the owner's approval, and deploys the digest the same way. Agents list release candidates (commit, digest, reference-election result) in STATUS and never touch `prod`.

## Rolling back

Redeploy `api` at the previous digest, from the last successful deploy run or the service's deployment history in Railway. Never by tag.

Migrations are forward-only (`packages/core`, Database), and `api-migrate` refuses to run if an applied file changed or disappeared, so a rollback never runs `api-migrate`. A migration must therefore keep the previous release working: add, never rename or drop, in the release that introduces it, and remove what's unused only in a later one. A release that can't follow that rule says so in its PR, and rolling back past it means restoring the database (below) rather than redeploying.

## Rotating secrets

- A database login: create a new login in the same group role, point the service's `DATABASE_URL` at it, redeploy, then `DROP ROLE` the old one. Objects are owned by the group roles, not the logins, so nothing moves.
- `RAILWAY_TOKEN`: the owner creates a new project token for the environment in Railway, replaces the GitHub environment secret, then revokes the old token.
- If a Railway token leaked: revoke it first, then check the environment's deployment history for digests that no workflow run produced and redeploy the last good one.

## Restoring after losing Postgres

Nothing that decides a result lives only in Postgres (T-66). On a fresh database: repeat the Postgres setup above, run `api-migrate`, redeploy `api`. Election definitions and the board are then rebuilt from chain and IPFS by the indexer (P3-5) and the mirror (P4-3); until those exist, a restored database starts empty and the boards of elections in progress must be re-imported from their IPFS mirrors by hand. Operational data with no other copy (moderation log, accounts, voters' recovery backups) is lost unless restored from a Railway backup.

## If Railway, Cloudflare or a domain is taken from us

T-49. The images are public and reproducible, so anyone can rebuild one from a commit, check it against the published digest and run it elsewhere with a Postgres and the variables above. Elections don't depend on us: voters keep the direct-submit path (T-25) and the verifier needs only chain and IPFS (P4-6). The steps for moving hosts, and the ballot client's IPFS and ENS entry points, come with P4-3 to P4-5.
