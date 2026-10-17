// The output circuit (docs/spec/nullifier-query.md, Output circuit; T-03,
// T-21, T-30).
//
// Public inputs, in order: σ, q, B.x, B.y, Z.x, Z.y; then the output N.
// Private inputs: x, r, U.x, U.y.
//
//     x ≠ 0
//     0 < r < l
//     B = r · H1(σ, x)
//     U is on the curve, l · U = (0, 1) and U ≠ (0, 1)
//     Z = r · U
//     N = H2(σ, x, U)
//
// One `r`, as one set of bits, multiplies both `H1(σ, x)` and `U`: with two,
// every `U′ ∈ 𝔾` would fit `Z` for some `r′` and the client could choose `N`.
// `U` in the prime-order subgroup is `h2`'s assertion (on the curve first,
// then `check_sub_group`, finding A); without it `U + T` for a small-order `T`
// fits `Z` for an even `r`. `q` enters no constraint: the proof binds it.

use babyjubjub::BabyJubJubPoint;
use keyed_nullifier::{blind, blinding_bits, h2};

fn main(
    sigma: pub Field,
    q: pub Field,
    b_x: pub Field,
    b_y: pub Field,
    z_x: pub Field,
    z_y: pub Field,
    x: Field,
    r: Field,
    u_x: Field,
    u_y: Field,
) -> pub Field {
    let _ = q;
    let r_bits = blinding_bits(r);
    let b = blind(sigma, x, r_bits);
    assert((b.x, b.y) == (b_x, b_y), "B does not match");
    let u = BabyJubJubPoint::new(u_x, u_y);
    assert(u.is_not_identity(), "U is the identity");
    let z = u.scalar_mul_bits(r_bits);
    assert((z.x, z.y) == (z_x, z_y), "Z does not match");
    h2(sigma, x, u)
}

// Soundness: each test breaks exactly one constraint of an otherwise honest
// witness (circuits skill, Tests). Completeness against the spec's vectors is
// test/nullifier-circuits.test.ts.
mod tests {
    use super::main;
    use babyjubjub::BabyJubJubPoint;
    use keyed_nullifier::{h1, h2, H2_TAG, sponge};

    global SIGMA: Field = 0x00dbed508ef1a8d98bbcb1a2225d7d53314c0d132b9f87556642f70e1ba50a44;
    global Q: Field = 0x0086a933032cd5cfb91ae19304dba5b3f1920dd311b45338ea0f01ed491bec8b;
    global X: Field = 22;
    // Even, so that U plus the point of order 2 fits the same Z.
    global R: Field = 24;
    global SK: Field = 31;
    global L: Field = 2736030358979909402780800718157159386076813972158567259200215660948447373041;

    struct Witness {
        b: BabyJubJubPoint,
        z: BabyJubJubPoint,
        u: BabyJubJubPoint,
    }

    fn honest(x: Field, r: Field) -> Witness {
        let h = h1(SIGMA, x);
        let u = h.scalar_mul(SK);
        Witness { b: h.scalar_mul(r), z: u.scalar_mul(r), u }
    }

    fn run(x: Field, r: Field, w: Witness) -> Field {
        main(SIGMA, Q, w.b.x, w.b.y, w.z.x, w.z.y, x, r, w.u.x, w.u.y)
    }

    #[test]
    fn an_honest_witness_passes() {
        let w = honest(X, R);
        assert(run(X, R, w) == h2(SIGMA, X, w.u));
    }

    #[test]
    fn q_is_free() {
        let w = honest(X, R);
        let n = main(SIGMA, Q + 1, w.b.x, w.b.y, w.z.x, w.z.y, X, R, w.u.x, w.u.y);
        assert(n == h2(SIGMA, X, w.u));
    }

    #[test(should_fail_with = "x is zero")]
    fn refuses_x_zero() {
        let _ = run(0, R, honest(0, R));
    }

    #[test(should_fail_with = "r is zero")]
    fn refuses_r_zero() {
        let _ = run(X, 0, honest(X, 0));
    }

    #[test]
    fn r_plus_l_opens_the_same_b_and_z() {
        let (w, v) = (honest(X, R), honest(X, R + L));
        assert((w.b.x, w.b.y, w.z.x, w.z.y) == (v.b.x, v.b.y, v.z.x, v.z.y));
    }

    // bn254::assert_lt fails without a message; nothing else in main can
    // fail on these witnesses (r + l and l both fit in 251 bits).
    #[test(should_fail)]
    fn refuses_r_plus_l() {
        let _ = run(X, R + L, honest(X, R));
    }

    #[test(should_fail)]
    fn refuses_r_equal_to_l() {
        let _ = run(X, L, honest(X, L));
    }

    #[test(should_fail_with = "B does not match")]
    fn refuses_a_b_of_another_x() {
        // Another document's B, with this one's U and Z.
        let w = honest(X, R);
        let other = honest(X + 1, R);
        let _ = run(X, R, Witness { b: other.b, z: w.z, u: w.u });
    }

    #[test(should_fail_with = "B does not match")]
    fn refuses_a_b_of_another_r() {
        // B = r′ · H1 with Z = r · U: two scalars would let any U′ fit Z.
        let w = honest(X, R);
        let other = honest(X, R + 2);
        let _ = run(X, R, Witness { b: other.b, z: w.z, u: w.u });
    }

    #[test(should_fail_with = "Z does not match")]
    fn refuses_another_z() {
        let w = honest(X, R);
        let _ = run(X, R, Witness { b: w.b, z: w.z.double(), u: w.u });
    }

    #[test(should_fail_with = "U is the identity")]
    fn refuses_u_the_identity() {
        // Z is then the identity too, and h2 alone accepts it.
        let w = honest(X, R);
        let id = BabyJubJubPoint::identity();
        let _ = run(X, R, Witness { b: w.b, z: id, u: id });
    }

    // The one test that can't break a single constraint: an off-curve U also
    // misses Z and h2's own on-curve assertion. It shows the first on-curve
    // check fires before any add, which an off-curve point could under-constrain.
    #[test(should_fail_with = "Point must be on curve")]
    fn refuses_u_off_the_curve() {
        let w = honest(X, R);
        let _ = run(
            X,
            R,
            Witness { b: w.b, z: w.z, u: BabyJubJubPoint::new(w.u.x, w.u.y + 1) },
        );
    }

    #[test]
    fn u_plus_a_point_of_order_two_fits_z_for_an_even_r() {
        let w = honest(X, R);
        let t = BabyJubJubPoint::new(0, -1);
        let z = w.u.add(t).scalar_mul(R);
        assert((z.x, z.y) == (w.z.x, w.z.y));
        let n = sponge([H2_TAG, SIGMA, X, w.u.add(t).x, w.u.add(t).y])[0];
        assert(n != h2(SIGMA, X, w.u));
    }

    #[test(should_fail_with = "U is not in the prime-order subgroup")]
    fn refuses_u_plus_a_point_of_order_two() {
        // The second N the previous test shows is refused.
        let w = honest(X, R);
        let u = w.u.add(BabyJubJubPoint::new(0, -1));
        let _ = run(X, R, Witness { b: w.b, z: w.z, u });
    }
}
