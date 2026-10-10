---
"@abolishus/crypto": minor
---

First API: strict canonical encoders and decoders for the primitive types of the Abolish protocol spec (`docs/spec/notation.md`). That covers the integers, `bool`, `enum8`, fixed and length-prefixed bytes, UTF-8 text, BN254 field elements, lists and structures, plus record framing with profile-pinned versions, the `DS(tag, m)` framing and the spec's tag and record-type registries. Decoders reject malformed input with the spec's error codes and never repair it. Nothing existed before, so nothing breaks.
