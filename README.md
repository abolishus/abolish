# Abolish

An open-source, publicly auditable voting platform. Every result can be verified by anyone, without trusting us.

Status: early development. See [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) for the full brief and [`docs/STATUS.md`](docs/STATUS.md) for current progress. Contributors and agents start with [`AGENTS.md`](AGENTS.md).

## Development

Requires [Vite+](https://viteplus.dev) (`vp`), which manages the pinned Node.js and pnpm versions:

```sh
vp env on                      # use the pinned Node.js (.node-version) and pnpm (devEngines)
vp install
vp check                       # format, lint, typecheck
vp run -r test                 # every package's tests
.github/scripts/install-toolchain.sh   # nargo, bb and Foundry at pinned, hash-verified versions
```

## Releases

Every merge to `main` that carries a changeset publishes `next` prereleases of the published packages (`<version>-next-<commit>`) from [`release.yml`](.github/workflows/release.yml): built twice and compared byte for byte, signed with Sigstore (cosign keyless), with SLSA build provenance, and published to npm by trusted publishing (no tokens). `latest` is only ever moved by the maintainer (the packages must exist on npm before this workflow first publishes, since a first publish sets `latest` whatever its tag). To check a tarball:

```sh
cosign verify-blob --bundle <tarball>.sigstore.json \
  --certificate-identity https://github.com/abolishus/abolish/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com <tarball>
gh attestation verify <tarball> --repo abolishus/abolish \
  --signer-workflow abolishus/abolish/.github/workflows/release.yml --source-ref refs/heads/main
```

Add a changeset with `vp exec changeset` in any PR that changes a published package.

## License

`@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/sdk` are [Apache-2.0](packages/crypto/LICENSE), each with its own `LICENSE`. They are what third parties embed to verify elections or build clients, so they carry a permissive license that any verifier, in any project, can use without conditions on its own code.

Everything else (apps, servers, the UI and internal packages) is [AGPL-3.0-only](LICENSE): anyone who runs a modified copy of the platform as a network service must publish their changes, so a fork can't quietly alter how votes are handled while claiming to be the same system.
