# Railway

How Abolish runs on Railway: what the owner creates by hand, how images are built, and how to deploy, roll back, rotate secrets, recover from a lost database and keep going if Railway, Cloudflare or a domain is taken from us. Design from [[P2-11]]; the brief's rule is that Railway deploys prebuilt, signed images and never builds from source ([[PROJECT_BRIEF]], Tech stack).

Postgres is not authoritative: wiping it loses no result (T-66). Nothing on Railway holds a ballot's plaintext; the API sees ciphertexts and proofs only (T-09).

Status: the API and web images (this runbook, Building) exist. `.github/workflows/deploy.yml` builds, signs and deploys both to staging on every push to `main` (#69, #74), the API first. Production deploys wait on the reference election against staging (P1-20). The worker (P2-4) and ballot client (P2-8) add their own sections as they land.

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
   CREATE ROLE abolish_web LOGIN PASSWORD '…' IN ROLE abolish_app;
   ALTER ROLE abolish_web SET search_path = abolish;
   ```

3. Only the deploy workflow gets `abolish_migrate`'s URL (the `MIGRATE_DATABASE_URL` secret, below); only the `api` service gets `abolish_api`'s, and only `web` gets `abolish_web`'s. A compromised API can then append to the board but never alter a table, a trigger or a grant (T-23, T-65).
4. The deploy workflow migrates from a GitHub runner, so the database needs Railway's TCP proxy enabled; use its address with `?sslmode=require` in `MIGRATE_DATABASE_URL`. That encrypts the connection but doesn't verify the proxy's certificate, and the database is then reachable from the internet behind its passwords.

### Dragonfly

Not used by the API. The worker (P2-4) needs it: a service from `docker.dragonflydb.io/dragonflydb/dragonfly`, pinned by digest, started with `--cluster_mode=emulated --lock_on_hashtags` and a password (`--requirepass`), on the private network only, with no public domain. Its contents are ephemeral (rate limits, queues); losing them loses no result.

### Services

Each service's source is a container image, set by digest by the deploy workflow, never a repository: Railway never builds (T-61). Each service has no public domain unless listed.

| Service  | Command                            | Variables                                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api`    | image default (`main.mjs`)         | `DATABASE_URL` (`abolish_api`), `API_PORT=8787`                                                                                                                             | Custom domain `api.<domain>` with target port 8787 (the API reads `API_PORT`, not Railway's `PORT`), behind Cloudflare. `API_HOST` is `0.0.0.0` in the image; set `::` if a service must reach it over IPv6 on Railway's private network.                                                                                                                                                                                                                                                        |
| `web`    | image default (`node/main.mjs`)    | `DATABASE_URL` (`abolish_web`), `API_URL=http://api.railway.internal:8787`, `WEB_ORIGIN`, `ACCOUNT_SECRET` (32+ random bytes), `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` | Public domain with target port 3000 (`WEB_PORT`; Railway's `PORT` is ignored); `WEB_ORIGIN` is that domain, `https`. Reaches the API over the private network, so `api` sets `API_HOST=::`. `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` are one widget's pair, for `WEB_ORIGIN`'s host. The secret is a placeholder until the account page renders the widget, so passkey sign-ups fail closed meanwhile; without a site key, the poll editor says polls can't be submitted (P2-22 part 6c). |
| `ballot` | image default (`server/serve.mjs`) | none (`BALLOT_PORT=8080` in the image)                                                                                                                                      | Staging only: the Railway domain `ballot-staging.up.railway.app`, target port 8080, never a name under `abolish.us` ([[0020-entry-points]]). Serves the static client with its CSP also as a header (so the workers get it) plus `frame-ancestors 'none'`. The `api` service's `API_CORS_ORIGINS` lists this origin. Releases are served from IPFS and the entry points, not from Railway.                                                                                                       |

Migrations aren't a Railway service: Railway reports when a deployment is live, not when a one-shot process has exited, so nothing could wait for one, and its pre-deploy command would put the migrator's credential in the API's environment. The deploy workflow runs the same digest's `node migrate.mjs` itself, before pointing `api` at it, so an API never runs against migrations other than its own. No other variable is needed; secrets live only in Railway variables, never in the image or the repository.

There is no health endpoint yet, so Railway's deploy health check stays off: a deploy whose process exits shows as crashed, but one that starts and then fails every query doesn't. Add `/health` and turn the check on with the next API change.

### GitHub environments and the image registry

One Railway project token per environment, scoped to that environment, stored as `RAILWAY_TOKEN` in the matching GitHub environment (`staging`: `main` only, no reviewer; `production`: the `prod` branch only, owner approval). Never a repository secret: a workflow run from a PR branch can read repository secrets but not these (T-65). PR environments, if any, get a token that reaches neither.

Each environment also holds:

- Secret `MIGRATE_DATABASE_URL`: the `abolish_migrate` login over the TCP proxy (Postgres, step 4). `RAILWAY_TOKEN` can read every Railway variable anyway, so keeping this beside it widens nothing.
- Variables `RAILWAY_API_SERVICE_ID` and `RAILWAY_WEB_SERVICE_ID`: the `api` and `web` services' IDs (service settings in Railway). Not secret.

Images go to `ghcr.io/abolishus/abolish-api` and `ghcr.io/abolishus/abolish-web`, tagged `sha-<commit>` for people and deployed by digest. After the first run creates each package, make it public in its GitHub package settings: Railway pulls it without credentials, and anyone can check a running digest against the build (T-49).

### Cloudflare

- DNS: add `api.<domain>` as a custom domain on the `api` service first (Railway routes by host name), then a proxied (orange cloud) CNAME to the target Railway gives; SSL mode Full (strict).
- WAF managed rules on; a rate-limiting rule per client address on `POST /ballots`, a tighter one on `POST /moderation/reports` (a report is anonymous, so the proxy is the only bound on how many one client makes), and one on the whole API host (T-48, T-52). The API also caps requests in flight (`apps/api` README, Transport); per-address limits are Cloudflare's job.
- Logs (T-11): no Logpush job and no Log Explorer. That doesn't make Cloudflare forget addresses: every WAF or rate-limit match is kept as a security event with the client address, path and query string, and analytics keep sampled requests. A rate-limit match on `POST /ballots` thus records an address next to the time of a ballot submission. Cloudflare sees every address in transit anyway; that's T-11's residual, and voters who need more use Tor or direct submit.
- Turnstile on Tier 0 actions comes with the web app (P2-9); never on ballot submission, which must work without our domain (T-25).

Railway's own HTTP logs record request paths and may record client addresses; we can't turn them off. Ballot submission carries no account session, so they can't join an account to a ballot (T-10), but they add one more party that sees addresses (T-11).

## Building

An image is built from a commit twice, on separate runners, and is deployed only if both builds give the same image manifest digest (T-61). From the repository root:

```sh
vp install --frozen-lockfile
vp run --filter @abolishus/crypto build
vp run --filter @abolishus/api build    # type-checks, then bundles into apps/api/dist
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" docker buildx build \
  --platform linux/amd64 --provenance=false --sbom=false \
  --output type=oci,dest=api.tar,rewrite-timestamp=true \
  apps/api
```

- `apps/api/dist` is the whole program: `main.mjs`, `migrate.mjs`, one shared chunk with every dependency inlined, and `migrations/`, the SQL files from `packages/core`. `repro-build` already checks that it's byte-identical across checkouts.
- The image (`apps/api/Dockerfile`) is the Node base pinned by digest, at the version in `.node-version` (a test checks it), with the package managers removed and `dist/` copied in root-owned and read-only, run as `node`. `.dockerignore` lets only `dist/` into the context.
- Attestations are off here (buildx would otherwise wrap the image in an index with them), so the digest compared is the image alone; the deploy workflow adds signatures and provenance afterwards. `rewrite-timestamp` needs BuildKit 0.13 or later.
- `SOURCE_DATE_EPOCH` plus `rewrite-timestamp=true` clamp every file time in the new layers to the commit time, so the digest doesn't depend on when or where it was built. Checked on 2026-10-11: two builds of the same commit, one with a fresh `dist/` built under a different umask, gave the same OCI archive, byte for byte.
- The workflow builds on a BuildKit container pinned by digest (the runner's default driver can't export OCI archives), pushes the archive with `skopeo copy --preserve-digests` so the registry holds exactly the compared digest, signs it with cosign keyless signing and attaches SLSA provenance. Provenance and signatures are separate manifests that refer to the image; they don't change its digest.

## Deploying

Every merge to `main`, once `ci`, `repro-build` and `reference-election` have passed on it: build twice and compare, push, sign, then in the `staging` environment verify the signature and provenance, run the digest's `node migrate.mjs` with `MIGRATE_DATABASE_URL`, and once it exits 0 set the `api` service's source to the digest and deploy, waiting until Railway reports it live. The reference election against staging comes with P1-20. A production deploy (not built yet: it needs that reference election) happens only when the owner fast-forwards `prod` to a commit on `main`; it never rebuilds. It finds that commit's digest, verifies its signature and provenance, checks that the reference election passed on staging for that digest, waits for the owner's approval, and deploys the digest the same way. Agents list release candidates (commit, digest, reference-election result) in STATUS and never touch `prod`.

## Rolling back

Redeploy `api` at the previous digest in Railway, from the service's deployment history (each deploy run's summary also names its digest). Never by tag, and never by re-running an old deploy run: the workflow deploys only `main`'s head and fails such a re-run before it touches staging (its build and publish jobs still push and sign the same digest again, which is harmless) (#74).

Migrations are forward-only (`packages/core`, Database), and `migrate.mjs` refuses to run if an applied file changed or disappeared, so a rollback never migrates: in Railway, redeploy the `api` service's earlier deployment, which keeps its digest. A migration must therefore keep the previous release working: add, never rename or drop, in the release that introduces it, and remove what's unused only in a later one. A release that can't follow that rule says so in its PR, and rolling back past it means restoring the database (below) rather than redeploying.

## Rotating secrets

- The API's database login: create a new login in `abolish_app` with `ALTER ROLE … SET search_path = abolish` (or every query fails), point the `api` service's `DATABASE_URL` at it, redeploy, then `DROP ROLE` the old one. Objects are owned by the group roles, not the logins, so nothing moves.
- The migrator's login: create a new login in `abolish_migrator`, replace `MIGRATE_DATABASE_URL` in each GitHub environment (the TCP proxy's address with `?sslmode=require`), then `DROP ROLE` the old one. Dropping it first fails the next deploy at its migrate step.
- `RAILWAY_TOKEN`: the owner creates a new project token for the environment in Railway, replaces the GitHub environment secret, then revokes the old token.
- If a Railway token leaked: revoke it first, then check the environment's deployment history for digests that no workflow run produced and redeploy the last good one.

## Restoring after losing Postgres

Nothing that decides a result lives only in Postgres (T-66). On a fresh database: repeat the Postgres setup above, run the current digest's `node migrate.mjs` with the migrator's URL (`docker run --rm -e DATABASE_URL ghcr.io/abolishus/abolish-api@<digest> node migrate.mjs`), redeploy `api`. Election definitions and the board are then rebuilt from chain and IPFS by the indexer (P3-5) and the mirror (P4-3); until those exist, a restored database starts empty and the boards of elections in progress must be re-imported from their IPFS mirrors by hand. Operational data with no other copy (moderation log, accounts, voters' recovery backups) is lost unless restored from a Railway backup.

## If Railway, Cloudflare or a domain is taken from us

T-49. The images are public and reproducible, so anyone can rebuild one from a commit, check it against the published digest and run it elsewhere with a Postgres and the variables above. Elections don't depend on us: voters keep the direct-submit path (T-25) and the verifier needs only chain and IPFS (P4-6). The steps for moving hosts, and the ballot client's IPFS and ENS entry points, come with P4-3 to P4-5.
