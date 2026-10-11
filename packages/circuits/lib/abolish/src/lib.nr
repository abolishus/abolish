// Shared rules for Abolish's Noir circuits (docs/spec/notation.md,
// Circuit-facing values; docs/spec/domain-separation.md, In-circuit hashes).
// Every circuit that takes protocol bytes packs them with these functions, so
// the in-circuit and off-circuit packings can't drift (T-31). Tags enter a
// circuit only as the constant `tag_field(tag)`, computed off-circuit
// (`circuitTagField` in @abolishus/crypto, vectors in circuit.json), never
// recomputed here.

pub mod pack;
