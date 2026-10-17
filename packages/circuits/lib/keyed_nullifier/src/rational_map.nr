// Copied unchanged from TaceoLabs/oprf-nr v1.0.0 (commit e4984d6),
// babyjubjub/src/hash_to_curve.nr, lines 21-49 and 197-223: the rational map
// from Baby Jubjub's Montgomery form to its twisted Edwards form (RFC 9380,
// Appendix D.1) and the private helpers it calls. The map isn't public in the
// vendored library, and docs/spec/keyed-nullifier-hashes.md (TACEO's gadgets)
// requires TACEO's reviewed text, not a map of our own: `inverse_or_zero` is
// in its post-audit form (finding D), so `map(0)` reaches (0, 0) and maps to
// the identity (T-36). test/keyed-nullifier-hashes.test.ts checks these lines
// still equal the vendored file's.

fn is_zero(x: Field) -> bool {
    x == 0
}

unconstrained fn inverse_or_zero_unconstrained(x: Field) -> Field {
    if x == 0 {
        0
    } else {
        1 / x
    }
}

fn inverse_or_zero(x: Field) -> Field {
    // SAFETY: We constrain the inverse below
    let inv = unsafe { inverse_or_zero_unconstrained(x) };
    let is_zero = 1 - x * inv;
    // Constraint strategy:
    // if x != 0
    //  then is_zero must be 0 due to constraint 1 => x * inv = 1, therefore inv is the inverse of x
    // if x == 0
    //  then is_zero must be 1 due to the definition above, since x = 0. inv could be anything, but we enforce inv = 0 in constraints 2 below

    // These are the two constraints enforcing above logic:
    // One of x or is_zero must be zero
    assert(x * is_zero == 0, "InverseOrZero zero constraint 1 failed");
    // One of inv or is_zero must be zero
    assert(inv * is_zero == 0, "InverseOrZero zero constraint 2 failed");
    inv
}

fn rational_map_mont_to_twisted_edwards(s: Field, t: Field) -> (Field, Field) {
    // tv1 = s + 1
    let tv1 = s + 1;

    // tv2 = InverseOrZero(tv1 * t)
    let tv2 = inverse_or_zero(tv1 * t);

    // v = tv1 * tv2
    let v = tv1 * tv2;

    // w = tv2 * t
    let w = tv2 * t;

    // tv11 = s - 1
    let tv11 = s - 1;

    // e = IsZero(tv2)
    let e = is_zero(tv2);

    // out[0] = s * v
    let out_x = s * v;

    // out[1] = if e then 1 else w * tv11
    let out_y = if e { 1 } else { w * tv11 };

    (out_x, out_y)
}

// Ours: the copied function stays private, as upstream has it.
pub fn mont_to_edwards(s: Field, t: Field) -> (Field, Field) {
    rational_map_mont_to_twisted_edwards(s, t)
}
