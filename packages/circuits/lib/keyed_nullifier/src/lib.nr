// The keyed nullifier's hashes (docs/spec/keyed-nullifier-hashes.md): the
// Poseidon2 sponge, `H1` into Baby Jubjub's prime-order subgroup and `H2`.
// The query and output circuits compute them here and nowhere else; off-circuit
// code computes only `σ` and the tags' field elements (T-30, T-36, T-39).
//
// The curve gadgets are TACEO's audited `babyjubjub` library, vendored under
// vendor/oprf-nr, never a map of our own ([[0022-tier2-keyed-nullifier]],
// Amendment). Only what the spec's review covers is used: `map_to_curve_elligator2`,
// the rational map (copied, src/rational_map.nr) and the complete twisted
// Edwards law behind `add`, `multiply_by_cofactor`, `is_on_curve` and
// `check_sub_group`. TACEO's `encode` hashes under its own tag and maps once,
// which isn't a random oracle, so it is never called (T-36).

pub mod rational_map;

use babyjubjub::BabyJubJubPoint;
use babyjubjub::hash_to_curve::map_to_curve_elligator2;

/// `tag_field("abolish/v1/keyed-nullifier/h1")` (docs/spec/vectors/circuit.json).
pub global H1_TAG: Field = 0x003832c6e2c8f00c0274cde4a5553f3c0ae33489e2efa7deda7a87e1c241378c;
/// `tag_field("abolish/v1/keyed-nullifier/h2")` (docs/spec/vectors/circuit.json).
pub global H2_TAG: Field = 0x009950fce47e12fcc845981d3ea8e18001b74da98d79ab9da77656a8c714349c;

global RATE: u32 = 3;

/// The spec's rate-3, capacity-1 sponge over Noir's width-4 Poseidon2: the
/// input count times 2⁶⁴ in the capacity element, `N` absorbed three at a time
/// with the last block zero-padded, and the rate of the last state out. Not
/// `std::hash::poseidon2::Poseidon2Hasher`, which permutes once more when `N`
/// is a multiple of 3. `N` is fixed by each caller, so the count separates
/// `H1`'s inputs from `H2`'s as well as the tags do (T-30).
pub fn sponge<let N: u32>(inputs: [Field; N]) -> [Field; 3] {
    std::static_assert(N > 0, "the sponge takes at least one input");
    let mut s = [0, 0, 0, (N as Field) * 0x10000000000000000];
    for b in 0..(N + RATE - 1) / RATE {
        for i in 0..RATE {
            let at = b * RATE + i;
            if at < N {
                s[i] += inputs[at];
            }
        }
        s = std::hash::poseidon2_permutation(s);
    }
    [s[0], s[1], s[2]]
}

/// RFC 9380's Elligator 2 onto the Montgomery form, then Appendix D.1's
/// rational map to the twisted Edwards form, before the cofactor is cleared.
/// The result is on the curve: the map asserts `t² = g(s)` and the rational
/// map is algebraic, so `add` may take it (TACEO's audit, finding B).
pub fn map(u: Field) -> BabyJubJubPoint {
    let (s, t) = map_to_curve_elligator2(u);
    let (x, y) = rational_map::mont_to_edwards(s, t);
    BabyJubJubPoint::new(x, y)
}

/// `H1(σ, x) = 8 · (map(u_0) + map(u_1))` with `u_0, u_1` the first two outputs
/// of `Sponge(tag_field(h1), σ, x)`: RFC 9380's `hash_to_curve`, two maps
/// summed with the complete Edwards law (never Montgomery addition, finding
/// B), so `H1` lands in the prime-order subgroup. `x = 0` is the query
/// circuit's to refuse, not `H1`'s (T-03).
pub fn h1(sigma: Field, x: Field) -> BabyJubJubPoint {
    let u = sponge([H1_TAG, sigma, x]);
    map(u[0]).add(map(u[1])).multiply_by_cofactor()
}

/// The blinding scalar's bits for `scalar_mul_bits`, with `0 < r < l`
/// (docs/spec/nullifier-query.md). `validate_babyjubjub_field` gives `r < l`;
/// `scalar_mul` alone bounds its scalar only below `2²⁵¹`, so `r` and `r + l`
/// would both open one `B`, and the output circuit's one `r` for `B` and `Z`
/// would be two (T-03). `r ≠ 0` keeps `B` off the identity. Both circuits
/// multiply by these bits, so the bound can't be skipped by one of them.
pub fn blinding_bits(r: Field) -> [bool; 251] {
    assert(r != 0, "r is zero");
    BabyJubJubPoint::validate_scalar_field_with_bits(r)
}

/// `B = r · H1(σ, x)`, the blinded point both circuits fix, for `x ≠ 0`:
/// `H1` is defined at 0, so the refusal is here, where both circuits take it
/// (T-03).
pub fn blind(sigma: Field, x: Field, r_bits: [bool; 251]) -> BabyJubJubPoint {
    assert(x != 0, "x is zero");
    h1(sigma, x).scalar_mul_bits(r_bits)
}

/// `N = H2(σ, x, U) = Sponge(tag_field(h2), σ, x, U.x, U.y)[0]`. `H2` is
/// defined only for `U` in the prime-order subgroup, so it asserts that here
/// rather than trusting each caller: otherwise `U + T` for a small-order `T`
/// could satisfy `Z = r · U` for an even `r` and give one document a second
/// `N` (TACEO's audit, finding A; T-03). `check_sub_group` needs the point on
/// the curve, so that is checked first.
pub fn h2(sigma: Field, x: Field, u: BabyJubJubPoint) -> Field {
    assert(u.is_on_curve(), "U is not on the curve");
    assert(u.check_sub_group(), "U is not in the prime-order subgroup");
    sponge([H2_TAG, sigma, x, u.x, u.y])[0]
}
