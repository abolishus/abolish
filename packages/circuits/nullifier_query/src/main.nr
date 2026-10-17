// The query circuit (docs/spec/nullifier-query.md, Query circuit; T-03, T-13,
// T-21, T-30).
//
// Public inputs, in order: σ, ctx, comm_in; then the output B as B.x, B.y.
// Private inputs: d_1, d_2, d_3, d_4, s_x, x, r.
//
//     comm_in = Sponge(d_1, d_2, d_3, d_4, Sponge(s_x, x)[0])[0]
//     x ≠ 0,  s_x ≠ 0
//     0 < r < l
//     B = r · H1(σ, x)
//
// `comm_in` is zkPassport's commitment with its fifth slot, the private
// nullifier, opened only in the clear-value form: the hash-only form carries
// the value as 0, and every document would share that `x` (0022's Amendment).
// `ctx` enters no constraint: the proof binds every public input, so a proof
// under one context fails under another (tested by the proof round trips).

use keyed_nullifier::{blind, blinding_bits, sponge};

fn main(
    sigma: pub Field,
    ctx: pub Field,
    comm_in: pub Field,
    d: [Field; 4],
    s_x: Field,
    x: Field,
    r: Field,
) -> pub (Field, Field) {
    let _ = ctx;
    assert(s_x != 0, "s_x is zero");
    let slot = sponge([s_x, x])[0];
    assert(sponge([d[0], d[1], d[2], d[3], slot])[0] == comm_in, "comm_in does not open");
    let b = blind(sigma, x, blinding_bits(r));
    (b.x, b.y)
}

// Soundness: each test breaks exactly one constraint of an otherwise honest
// witness (circuits skill, Tests). Completeness against the spec's vectors is
// test/nullifier-circuits.test.ts.
mod tests {
    use super::main;
    use babyjubjub::BabyJubJubPoint;
    use keyed_nullifier::{h1, sponge};

    global SIGMA: Field = 0x00dbed508ef1a8d98bbcb1a2225d7d53314c0d132b9f87556642f70e1ba50a44;
    global CTX: Field = 0x005ca0dd35a459b63ae1abe88f0948fccdbcad9b10e81c45eceaf7010e28fe92;
    global D: [Field; 4] = [11, 12, 13, 14];
    global S_X: Field = 21;
    global X: Field = 22;
    global R: Field = 23;
    global L: Field = 2736030358979909402780800718157159386076813972158567259200215660948447373041;

    fn comm(s_x: Field, x: Field) -> Field {
        sponge([D[0], D[1], D[2], D[3], sponge([s_x, x])[0]])[0]
    }

    fn b(x: Field, r: Field) -> (Field, Field) {
        let p = h1(SIGMA, x).scalar_mul(r);
        (p.x, p.y)
    }

    #[test]
    fn an_honest_witness_passes() {
        assert(main(SIGMA, CTX, comm(S_X, X), D, S_X, X, R) == b(X, R));
    }

    #[test]
    fn ctx_is_free() {
        // ctx is bound by the proof, not by a constraint.
        assert(main(SIGMA, CTX + 1, comm(S_X, X), D, S_X, X, R) == b(X, R));
    }

    #[test(should_fail_with = "comm_in does not open")]
    fn refuses_another_comm_in() {
        let _ = main(SIGMA, CTX, comm(S_X, X) + 1, D, S_X, X, R);
    }

    #[test(should_fail_with = "comm_in does not open")]
    fn refuses_a_slot_that_is_not_the_salted_x() {
        // The fifth slot is Sponge(s_x, x)[0], never x itself or another hash.
        let unsalted = sponge([D[0], D[1], D[2], D[3], X])[0];
        let _ = main(SIGMA, CTX, unsalted, D, S_X, X, R);
    }

    #[test(should_fail_with = "x is zero")]
    fn refuses_x_zero() {
        let _ = main(SIGMA, CTX, comm(S_X, 0), D, S_X, 0, R);
    }

    #[test(should_fail_with = "s_x is zero")]
    fn refuses_s_x_zero() {
        let _ = main(SIGMA, CTX, comm(0, X), D, 0, X, R);
    }

    #[test(should_fail_with = "r is zero")]
    fn refuses_r_zero() {
        let _ = main(SIGMA, CTX, comm(S_X, X), D, S_X, X, 0);
    }

    #[test]
    fn r_plus_l_opens_the_same_b() {
        // r + l < 2²⁵¹, so scalar_mul takes it: only r < l refuses it below.
        let p = h1(SIGMA, X).scalar_mul(R + L);
        assert((p.x, p.y) == b(X, R));
    }

    // bn254::assert_lt fails without a message; nothing else in main can
    // fail on these witnesses (r + l and l both fit in 251 bits).
    #[test(should_fail)]
    fn refuses_r_plus_l() {
        let _ = main(SIGMA, CTX, comm(S_X, X), D, S_X, X, R + L);
    }

    #[test(should_fail)]
    fn refuses_r_equal_to_l() {
        let _ = main(SIGMA, CTX, comm(S_X, X), D, S_X, X, L);
    }

    #[test]
    fn b_is_bound_to_sigma() {
        // Another scope's σ gives another B for the same x and r.
        let other = main(SIGMA + 1, CTX, comm(S_X, X), D, S_X, X, R);
        assert(other != b(X, R));
        let p = BabyJubJubPoint::new(other.0, other.1);
        assert(p.is_on_curve() & p.check_sub_group() & p.is_not_identity());
    }
}
