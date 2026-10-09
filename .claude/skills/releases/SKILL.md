---
name: releases
description: Rules for versioning, reproducible signed builds and npm publishing (Changesets, vp pack, Sigstore/cosign, SLSA, IPFS-pinned ballot client, trusted publishing). Load before touching release tooling, package metadata of published packages, or anything in the build pipeline.
---

# releases

## Published packages

`@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/sdk`: Apache-2.0, built with `vp pack` (ESM + d.ts). Everything else is private and AGPL-3.0-only.

## Versioning

- Changesets: every PR that changes a published package adds a changeset (`vp exec changeset`). Explain the semver bump from the consumer's view.
- Every merge to `main` publishes `next` prereleases, **always with an explicit** `npm publish --tag next`.
- **Never move the `latest` dist-tag.** The owner promotes releases.

## release.yml (rules for when it is written; it is a `ci:` PR)

- Runs on GitHub-hosted runners only, in the `npm` environment, with `permissions: id-token: write` (trusted publishing over OIDC). npm tokens are not allowed.
- Uses a pinned npm CLI ≥ 11.5, installed by exact version. The `npm publish` step is the one place npm is called directly.
- Builds twice and fails on any hash mismatch (the same comparison as `repro-build`). Signs artifacts and container images with Sigstore/cosign keyless signing and emits SLSA provenance.
- Ballot-client release: build the static `apps/ballot` bundle reproducibly, publish its sha256 and CID, pin it to IPFS (and the permanent archive per ADR), and attach the cosign bundle to the GitHub release. The verifier checks that a served client matches a signed release.
- Generates and publishes the OpenAPI spec from `packages/api-contract` with each release.

## Reproducibility rules

- `SOURCE_DATE_EPOCH` is the commit time. No timestamps, absolute paths, hostnames or random IDs in outputs.
- Sorted file lists, fixed locale and timezone in build scripts, and pinned toolchains (Node via `.node-version`, pnpm via devEngines, Vite+ via the catalog, nargo/bb/forge via `.github/scripts/install-toolchain.sh`).
- Solidity bytecode is built with `bytecode_hash = "none"`. Docker images are built from pinned digests, with `--provenance` and reproducible layer timestamps.
- `repro-build` hashes every untracked or ignored file the build produces (outside `node_modules`), and requires each package with a `build` script to declare `abolish.buildOutputs`. Caches written into the checkout must be deterministic or written elsewhere.
- When `repro-build` fails, find the nondeterminism. Never relax the comparison.

## Never

- Change npm settings, the `npm` environment, rulesets or CODEOWNERS.
- Publish from a session.
- Promote `latest`.
