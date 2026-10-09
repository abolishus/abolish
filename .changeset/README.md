# Changesets

Add one with `vp exec changeset` in every PR that changes a published package (`@abolishus/crypto`, `@abolishus/verifier`, `@abolishus/sdk`), and explain the semver bump from a consumer's point of view. `release.yml` publishes each merge to `main` as a `next` snapshot (`<version>-next-<commit>`); only the maintainer cuts and promotes real releases. See the `releases` skill.
