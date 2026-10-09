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
scripts/install-toolchain.sh   # nargo, bb and Foundry at pinned, hash-verified versions
```

## License

`@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/sdk` are Apache-2.0. Everything else is [AGPL-3.0-only](LICENSE).
