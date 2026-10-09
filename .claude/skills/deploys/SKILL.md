---
name: deploys
description: Rules for deploying to Railway (staging, production, PR environments), Cloudflare, IPFS/ENS entry points, and testnet contracts. Load before touching deployment config, Dockerfiles, infra scripts or runbooks.
---

# deploys

## Environments

- **PR environments** (Railway): ephemeral, seeded by the reference election fixture.
- **Staging**: every phase must end deployed here. The reference election runs against staging (`reference-election.yml`, `workflow_dispatch` with `target=staging`) before a phase can be marked done.
- **Production**: only after the owner signs off. Never touch production config from a session.

## Rules

- Railway deploys **prebuilt, signed images** from CI (`RAILWAY_TOKEN` in GitHub Actions). Railway never builds from source. The deploy step verifies the cosign signature and SLSA provenance of the image digest before deploying, and deploys by digest, never by tag.
- Cloudflare sits in front of Railway: WAF and rate limits, Turnstile on Tier 0 actions. Cloudflare must never see plaintext votes. Ballots are encrypted client-side, and API payloads hold only ciphertexts and proofs.
- PostHog only in `apps/web`, proxied through our own domain. `apps/ballot` ships no third-party code, under a strict CSP (`default-src 'self'`, no inline scripts, `connect-src` limited to our API and chain/IPFS gateways).
- Dragonfly in production runs with `--cluster_mode=emulated --lock_on_hashtags`. BullMQ queue names are hashtagged (`{anchor}`, `{pin}`, `{tally}`).
- Secrets come only from GitHub environments and Railway variables. Never print them, never commit `.env` files, and add every new variable to `.env.example` and the env Zod schema.

## Censorship-resistance entry points

The ballot client is published to IPFS, served by `abolishus.eth`, by a non-US-TLD domain (to be chosen by ADR) and by abolish.us. Every surface (app, verifier output, docs) lists all three. A deploy is incomplete until all three serve the same signed client hash; check this in the post-deploy job.

## Contracts

Testnet deploys run only from GitHub Actions with `TESTNET_DEPLOYER_KEY` and explorer verification via `ETHERSCAN_API_KEY`; see the `contracts` skill. Never deploy to mainnet. That waits for the owner.

## Runbooks

Each deployable gets `docs/runbooks/<service>.md` covering: deploy, roll back (by previous image digest), rotate secrets, restore from chain + IPFS after a total Postgres loss, and operate under domain or hosting seizure.
