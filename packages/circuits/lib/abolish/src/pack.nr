// Byte packing (docs/spec/notation.md, Circuit-facing values).
//
// bytes[N] packs into ceil(N / 31) field elements: chunk i is bytes
// [31i, min(31i + 31, N)) read big-endian. 31 bytes is 248 bits, below the
// BN254 scalar field order r, so no chunk wraps and the packing is injective
// for each N. Inputs are `u8`, so Noir range-checks every byte.

pub global CHUNK: u32 = 31;

/// Packs `N` bytes into `M = ceil(N / 31)` field elements, big-endian per chunk.
pub fn pack_bytes<let N: u32, let M: u32>(bytes: [u8; N]) -> [Field; M] {
    std::static_assert(M == (N + CHUNK - 1) / CHUNK, "M must be ceil(N / 31)");
    let mut out = [0; M];
    for i in 0..N {
        let c = i / CHUNK;
        out[c] = out[c] * 256 + bytes[i] as Field;
    }
    out
}

/// Packs a `bytes<MAX>` or `utf8<MAX>` value: its length, then its content
/// zero-padded to `MAX` bytes and packed as `bytes[MAX]`. `bytes` holds the
/// content followed by padding. The length is at most `MAX` and every padding
/// byte is zero, so each value has exactly one packing: otherwise `"ab"` with
/// length 1 and `"a"` would pack alike apart from the length, and a prover
/// could hide bytes past the length (T-31).
pub fn pack_bounded_bytes<let MAX: u32, let M: u32>(
    bytes: [u8; MAX],
    len: u32,
) -> (Field, [Field; M]) {
    assert(len <= MAX, "length exceeds the maximum");
    for i in 0..MAX {
        if i >= len {
            assert(bytes[i] == 0, "padding byte is not zero");
        }
    }
    (len as Field, pack_bytes(bytes))
}

#[test]
fn packs_nothing_for_no_bytes() {
    let out: [Field; 0] = pack_bytes([]);
    assert(out.len() == 0);
}

#[test]
fn packs_a_full_chunk_big_endian() {
    let mut bytes = [0; 31];
    bytes[0] = 1;
    bytes[30] = 2;
    let out: [Field; 1] = pack_bytes(bytes);
    assert(out[0] == 0x01000000000000000000000000000000000000000000000000000000000002);
}

#[test]
fn starts_a_new_chunk_at_byte_31() {
    let mut bytes = [0xff; 32];
    bytes[31] = 0x07;
    let out: [Field; 2] = pack_bytes(bytes);
    assert(out[0] == 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
    assert(out[1] == 7);
}

#[test]
fn packs_bounded_bytes_with_their_length() {
    let (len, out): (Field, [Field; 1]) = pack_bounded_bytes([0x61, 0x62, 0, 0], 2);
    assert(len == 2);
    assert(out[0] == 0x61620000);
}

#[test]
fn packs_an_empty_bounded_value() {
    let (len, out): (Field, [Field; 1]) = pack_bounded_bytes([0, 0, 0], 0);
    assert(len == 0);
    assert(out[0] == 0);
}

#[test]
fn packs_a_full_bounded_value() {
    let (len, out): (Field, [Field; 1]) = pack_bounded_bytes([1, 2, 3], 3);
    assert(len == 3);
    assert(out[0] == 0x010203);
}

#[test(should_fail_with = "padding byte is not zero")]
fn rejects_a_non_zero_byte_past_the_length() {
    let _: (Field, [Field; 1]) = pack_bounded_bytes([0x61, 0x62, 0, 0], 1);
}

#[test(should_fail_with = "length exceeds the maximum")]
fn rejects_a_length_over_the_maximum() {
    let _: (Field, [Field; 1]) = pack_bounded_bytes([1, 2, 3], 4);
}
