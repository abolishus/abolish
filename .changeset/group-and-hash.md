---
"@abolishus/crypto": minor
---

Adds the group and hash layer of `docs/spec/group.md` (ADR 0007):

- the ristretto255 `scalar` and `element` / `elementOrIdentity` codecs, which reject non-canonical input and never reduce it;
- `H` (SHA-256);
- `challenge` (RFC 9497 `HashToScalar` under a Fiat–Shamir tag) and `hashToGroup` (RFC 9380 `hash_to_ristretto255`);
- `G`, `GENERATOR_H`, `IDENTITY` and `GROUP_ORDER`.

`@noble/curves` is a new runtime dependency, and `@noble/hashes` moves from a dev dependency to a runtime one. `TAG_REGISTRY` entries gain a `primitive` field, and `ds` now accepts only plain-hash and KDF tags (`DsTag`). It already rejected every tag except `abolish/v1/display-text`, so no working call breaks.
