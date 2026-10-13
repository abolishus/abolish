#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/keyed-nullifier-hashes.json.

A second implementation of docs/spec/keyed-nullifier-hashes.md: the Poseidon2
permutation over BN254's scalar field (width 4, as Noir's standard library and
bb implement it) and its sponge, the Tier 2 scope field, H1 (RFC 9380's
hash_to_curve structure: two field elements from the sponge, each mapped by
Elligator 2 to the Montgomery form of Baby Jubjub and by the rational map of
RFC 9380 Appendix D.1 to its twisted Edwards form, summed, times the
cofactor) and H2. It is written from the spec, from the Poseidon2 paper
(Grassi, Khovratovich and Schofnegger, AFRICACRYPT 2023) and from RFC 9380,
in Python's integers and hashlib.

Poseidon2's round constants are derived here with the Poseidon paper's Grain
LFSR (eprint 2019/458, Appendix F), as the Poseidon2 reference code does for
Poseidon2 (one constant per partial round). The four diagonal entries of the
internal matrix are chosen, not derived, so they are copied from Noir's
bn254_blackbox_solver at v1.0.0-beta.22 (source in DIAGONAL_SOURCE); the
permutation is then checked against that crate's published known answer
before anything is printed. Baby Jubjub's arithmetic is keyed-nullifier-vectors.py's,
which checks itself against EIP-2494 first, and tag fields are
circuit-vectors.py's. Nothing here shares code with packages/crypto,
packages/circuits, any @noble library or TACEO's gadgets.

Every input comes from SHA-256 over a fixed label, so any implementation
reproduces the vectors. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/keyed-nullifier-hashes-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bjj = _load("keyed_nullifier_vectors", "keyed-nullifier-vectors.py")
circuit = _load("circuit_vectors", "circuit-vectors.py")

P = bjj.P  # = r, BN254's scalar field order, Baby Jubjub's base field
L = bjj.L
ID = bjj.ID
G = bjj.G

SCOPE_TAG = b"abolish/v1/keyed-nullifier/scope"
H1_TAG = "abolish/v1/keyed-nullifier/h1"
H2_TAG = "abolish/v1/keyed-nullifier/h2"
TWO_64 = 1 << 64

# --- Poseidon2 (width 4) -------------------------------------------------------------

T = 4
ROUNDS_F = 8
ROUNDS_P = 56
ALPHA = 5
# The Poseidon2 paper's M4 (Section 5.1), the external matrix for width 4.
M4 = [[5, 7, 1, 3], [4, 6, 1, 1], [1, 3, 5, 7], [1, 1, 4, 6]]
DIAGONAL_SOURCE = (
    "https://github.com/noir-lang/noir/blob/v1.0.0-beta.22/"
    "acvm-repo/bn254_blackbox_solver/src/poseidon2_constants.rs (INTERNAL_MATRIX_DIAGONAL)"
)
DIAGONAL = [
    0x10DC6E9C006EA38B04B1E03B4BD9490C0D03F98929CA1D7FB56821FD19D3B6E7,
    0x0C28145B6A44DF3E0149B3D0A30B3BB599DF9756D4DD9B84A86B38CFB45A740B,
    0x00544B8338791518B2C7645A50392798B21F75BB60E3596170067D00141CAC15,
    0x222C01175718386F2E2E82EB122789E352E105A3B8FA852613BC534433EE428B,
]
# The same crate's known answer (poseidon2.rs, smoke_test): the permutation of [0, 0, 0, 0].
KAT_ZERO = [
    0x18DFB8DC9B82229CFF974EFEFC8DF78B1CE96D9D844236B496785C698BC6732E,
    0x095C230D1D37A246E8D2D5A63B165FE0FADE040D442F61E25F0590E5FB76F839,
    0x0BB9545846E1AFA4FA3C97414A60A20FC4949F537A68CCECA34C5CE71E28AA59,
    0x18A4F34C9C6F99335FF7638B82AEED9018026618358873C982BBDDE265B2ED6D,
]


def grain_bits(n, t, rounds_f, rounds_p):
    """The Poseidon paper's Grain LFSR (eprint 2019/458, Appendix F) for a prime field and x^alpha."""
    init = []
    for value, width in ((1, 2), (0, 4), (n, 12), (t, 12), (rounds_f, 10), (rounds_p, 10)):
        init += [(value >> (width - 1 - i)) & 1 for i in range(width)]
    state = init + [1] * 30
    assert len(state) == 80

    def step():
        bit = state[62] ^ state[51] ^ state[38] ^ state[23] ^ state[13] ^ state[0]
        state.pop(0)
        state.append(bit)
        return bit

    for _ in range(160):
        step()
    while True:
        # Self-shrinking: of each pair of bits, the second is output when the first is 1.
        first = step()
        second = step()
        if first == 1:
            yield second


def round_constants(t=T):
    """R_F * t + R_P field elements, in round order, each read from 254 bits MSB first and
    rejected when not below P; partial rounds take one constant each (Poseidon2)."""
    bits = grain_bits(254, t, ROUNDS_F, ROUNDS_P)
    flat = []
    while len(flat) < ROUNDS_F * t + ROUNDS_P:
        v = 0
        for _ in range(254):
            v = (v << 1) | next(bits)
        if v < P:
            flat.append(v)
    rounds, i = [], 0
    for r in range(ROUNDS_F + ROUNDS_P):
        if ROUNDS_F // 2 <= r < ROUNDS_F // 2 + ROUNDS_P:
            rounds.append([flat[i]] + [0] * (t - 1))
            i += 1
        else:
            rounds.append(flat[i : i + t])
            i += t
    return rounds


RC = round_constants()


def permutation(state, matrix=M4, diagonal=DIAGONAL, rc=RC):
    t = len(matrix)
    assert len(state) == t and all(0 <= v < P for v in state)

    def external(st):
        return [sum(matrix[i][j] * st[j] for j in range(t)) % P for i in range(t)]

    def internal(st):
        total = sum(st) % P
        return [(st[i] * diagonal[i] + total) % P for i in range(t)]

    state = external(state)
    for r in range(ROUNDS_F + ROUNDS_P):
        if ROUNDS_F // 2 <= r < ROUNDS_F // 2 + ROUNDS_P:
            state[0] = pow((state[0] + rc[r][0]) % P, ALPHA, P)
            state = internal(state)
        else:
            state = [pow((state[i] + rc[r][i]) % P, ALPHA, P) for i in range(t)]
            state = external(state)
    return state


def sponge(inputs, outputs=1):
    """Rate 3, capacity 1, IV = len(inputs) * 2^64 in the capacity element; absorb three
    elements per permutation (added into the rate), the last block zero-padded; squeeze the
    first `outputs` rate elements of the last state (at most 3)."""
    assert 1 <= len(inputs) and 1 <= outputs <= 3
    state = [0, 0, 0, len(inputs) * TWO_64 % P]
    for i in range(0, len(inputs), 3):
        block = inputs[i : i + 3]
        for j, v in enumerate(block):
            state[j] = (state[j] + v) % P
        state = permutation(state)
    return state[:outputs]


# --- Elligator 2 and the rational map (RFC 9380 §6.7.1, Appendix D.1) --------------

MONT_J = 168698  # Baby Jubjub's Montgomery form K * t^2 = s^3 + J * s^2 + s
MONT_K = 1


def find_z():
    """RFC 9380 Appendix H.5's find_z_ell2: the first non-square of 1, -1, 2, -2, ..."""
    ctr = 1
    while True:
        for z in (ctr % P, (-ctr) % P):
            if not bjj.is_square(z):
                return z
        ctr += 1


Z = find_z()


def sgn0(v):
    return v % 2


def inv0(v):
    return 0 if v % P == 0 else pow(v, -1, P)


def elligator2(u):
    """RFC 9380 §6.7.1 map_to_curve_elligator2, with every intermediate value."""
    jk, k2 = MONT_J * inv0(MONT_K) % P, inv0(MONT_K * MONT_K)
    x1 = (-jk) * inv0(1 + Z * u * u) % P
    if x1 == 0:
        x1 = (-jk) % P
    gx1 = (x1 * x1 * x1 + jk * x1 * x1 + x1 * k2) % P
    x2 = (-x1 - jk) % P
    gx2 = (x2 * x2 * x2 + jk * x2 * x2 + x2 * k2) % P
    square = bjj.is_square(gx1)
    if square:
        x, y = x1, bjj.sqrt(gx1)
        if sgn0(y) != 1:
            y = (-y) % P
    else:
        x, y = x2, bjj.sqrt(gx2)
        if sgn0(y) != 0:
            y = (-y) % P
    s, t = x * MONT_K % P, y * MONT_K % P
    assert (MONT_K * t * t - (s * s * s + MONT_J * s * s + s)) % P == 0
    return {"x1": x1, "gx1": gx1, "x2": x2, "gx2": gx2, "gx1Square": square, "s": s, "t": t}


def rational_map(s, t):
    """RFC 9380 Appendix D.1: (v, w) = (s / t, (s - 1) / (s + 1)), and (0, 1) where
    t = 0 or s = -1."""
    if t % P == 0 or (s + 1) % P == 0:
        return ID, True
    return ((s * inv0(t)) % P, ((s - 1) * inv0(s + 1)) % P), False


def map_to_curve(u):
    m = elligator2(u)
    pt, exceptional = rational_map(m["s"], m["t"])
    assert bjj.on_curve(pt)
    return m, pt, exceptional


# --- The scope field, H1 and H2 ------------------------------------------------------


def scope_field(chain_id, registry):
    digest = bjj.sha256(bjj.ds(SCOPE_TAG, chain_id.to_bytes(8, "big") + registry))
    value = int.from_bytes(digest, "big") >> 8
    assert value < P
    return digest, value


def h1(sigma, x):
    tag = circuit.tag_field(H1_TAG)[1]
    u0, u1 = sponge([tag, sigma, x], outputs=2)
    m0, q0, e0 = map_to_curve(u0)
    m1, q1, e1 = map_to_curve(u1)
    q = bjj.add(q0, q1)
    out = bjj.mul(8, q)
    assert bjj.in_subgroup(out)
    steps = {
        "u0": u0,
        "u1": u1,
        "map0": (m0, q0, e0),
        "map1": (m1, q1, e1),
        "sum": q,
    }
    return out, steps


def h2(sigma, x, u_point):
    tag = circuit.tag_field(H2_TAG)[1]
    return sponge([tag, sigma, x, u_point[0], u_point[1]])[0]


# --- Cross-check against the authors' answers ------------------------------------------

# Poseidon2's width-3 instance over BN254, from the Poseidon2 reference code
# (https://github.com/HorizenLabs/poseidon2 at 055bde3, plain_implementations/src/poseidon2/
# poseidon2_instance_bn256.rs and poseidon2.rs): M3 = circ(2, 1, 1), internal diagonal
# minus one [1, 1, 2], and its known answer for [0, 1, 2].
M3 = [[2, 1, 1], [1, 2, 1], [1, 1, 2]]
DIAGONAL3 = [1, 1, 2]
RC3_FIRST = 0x1D066A255517B7FD8BDDD3A93F7804EF7F8FCDE48BB4C37A59A09A1A97052816
KAT3 = [
    0x0BB61D24DACA55EEBCB1929A82650F328134334DA98EA4F847F760054F4A3033,
    0x303B6F7C86D043BFCBCC80214F26A30277A15D3F74CA654992DEFE7FF8D03570,
    0x1ED25194542B12EEF8617361C3BA7C52E660B145994427CC86296242CF766EC8,
]
# TACEO's encode (https://github.com/TaceoLabs/oprf-nr at e4984d6, v1.0.0,
# babyjubjub/src/hash_to_curve.nr): u = Poseidon2_3([DS, input, 0])[1], the same
# Elligator 2 map and rational map, times the cofactor, with the file's three known answers.
TACEO_DS = 32627786498498119128812045057993354633158048678109587794777765218
TACEO_KATS = [
    (
        0x03E4070110668921A99C37627DEDDDB5AB65FAE33C19E24D9EE19D7065FDECA8,
        10317659717708787122683977912952208883341451354299498236440964928299898571531,
        2771878628977713302835201233169750856073682825638128695522023521672351725258,
    ),
    (
        0x42,
        16453178030699411958341692808730701741568100876455568813278163225032347056514,
        5447922750205248208490261749483809853022174346498064122782172531486866662376,
    ),
    (
        0,
        16605852874433019712683889710166313607515083375138125349412270828059484170936,
        12075050546928691602283582412953179086742727007172364313655633055645374686589,
    ),
]


def taceo_cross_check():
    """Our Elligator 2 and rational map give TACEO's encode answers, so the map this spec
    defines is the one their gadget computes (with their single-map structure and tag)."""
    rc3 = round_constants(3)
    assert rc3[0][0] == RC3_FIRST
    assert permutation([0, 1, 2], M3, DIAGONAL3, rc3) == KAT3, "Poseidon2 width-3 known answer"
    for value, ex, ey in TACEO_KATS:
        u = permutation([TACEO_DS, value, 0], M3, DIAGONAL3, rc3)[1]
        _, pt, _ = map_to_curve(u)
        assert bjj.mul(8, pt) == (ex, ey), "TACEO encode known answer"


# --- Self-checks ---------------------------------------------------------------------


def self_check():
    # Baby Jubjub's twisted Edwards form is the Montgomery form's image under the rational
    # map with no scaling: a = (J + 2) / K and d = (J - 2) / K (RFC 9380 Appendix D.1).
    assert (MONT_J + 2) * inv0(MONT_K) % P == bjj.A and (MONT_J - 2) * inv0(MONT_K) % P == bjj.D
    # The addition law is complete: a is a square and d isn't.
    assert bjj.is_square(bjj.A) and not bjj.is_square(bjj.D)
    assert Z == 5
    # 1 + Z * u^2 is never 0 (-1/Z is a non-square, since -1 is a square), so x1 != 0 always.
    assert bjj.is_square(P - 1) and not bjj.is_square((P - 1) * inv0(Z) % P)
    assert permutation([0, 0, 0, 0]) == KAT_ZERO, "Poseidon2 known answer"
    taceo_cross_check()
    for fixed in (RC[0], RC[ROUNDS_F // 2], RC[-1]):
        assert all(0 <= v < P for v in fixed)


def field(label):
    return int.from_bytes(hashlib.sha256(label.encode()).digest(), "big") % P


def bjj_scalar(label):
    return int.from_bytes(hashlib.sha256(label.encode()).digest(), "big") % L


def hexf(v):
    return f"0x{v:064x}"


def point(pt):
    return {"x": hexf(pt[0]), "y": hexf(pt[1])}


def map_json(u, m, pt, exceptional):
    return {
        "u": hexf(u),
        "x1": hexf(m["x1"]),
        "gx1": hexf(m["gx1"]),
        "gx1Square": m["gx1Square"],
        "x2": hexf(m["x2"]),
        "gx2": hexf(m["gx2"]),
        "montgomery": {"s": hexf(m["s"]), "t": hexf(m["t"])},
        "exceptional": exceptional,
        "edwards": point(pt),
    }


def main():
    out = pathlib.Path(sys.argv[1])
    self_check()

    permutations = []
    for inputs in (
        [0, 0, 0, 0],
        [0, 1, 2, 3],
        [P - 1, P - 2, P - 3, P - 4],
        [field(f"abolish/test/poseidon2/{i}") for i in range(4)],
    ):
        permutations.append({"input": [hexf(v) for v in inputs], "output": [hexf(v) for v in permutation(inputs)]})

    sponges = []
    for n in (1, 2, 3, 4, 5, 6, 7):
        inputs = [field(f"abolish/test/sponge/{n}/{i}") for i in range(n)]
        sponges.append({"input": [hexf(v) for v in inputs], "output": [hexf(v) for v in sponge(inputs, 3)]})

    maps = []
    us = [0, 1, P - 1, 2, Z] + [field(f"abolish/test/elligator2/{i}") for i in range(6)]
    for u in us:
        m, pt, e = map_to_curve(u)
        maps.append(map_json(u, m, pt, e))
    assert {m["gx1Square"] for m in maps} == {True, False}

    # The rational map's exceptional inputs: the Montgomery point (0, 0) (t = 0, of order 2)
    # and the points with s = -1 (where w's denominator is 0), each mapped to the identity.
    exceptional = [{"s": hexf(0), "t": hexf(0)}]
    t2 = (-1 + MONT_J - 1) % P  # t^2 = s^3 + J s^2 + s at s = -1
    if bjj.is_square(t2):
        t = bjj.sqrt(t2)
        exceptional += [{"s": hexf(P - 1), "t": hexf(t)}, {"s": hexf(P - 1), "t": hexf((-t) % P)}]
    for e in exceptional:
        pt, flag = rational_map(int(e["s"], 16), int(e["t"], 16))
        assert flag and pt == ID
        e["edwards"] = point(pt)

    scopes = []
    for chain_id, registry in (
        (84532, bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")),
        (31337, bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")),
        ((1 << 64) - 1, bytes(20)),
    ):
        digest, value = scope_field(chain_id, registry)
        scopes.append({"l2ChainId": str(chain_id), "groupRegistry": registry.hex(), "digest": digest.hex(), "field": hexf(value)})

    sigma = int(scopes[0]["field"], 16)
    sigma_other = int(scopes[1]["field"], 16)
    hashes = []
    cases = [("x zero", sigma, 0), ("x one", sigma, 1), ("x p - 1", sigma, P - 1)]
    cases += [(f"document {i}", sigma, field(f"abolish/test/h1/x/{i}")) for i in range(4)]
    cases += [("document 0, other scope", sigma_other, field("abolish/test/h1/x/0"))]
    sk = bjj_scalar("abolish/test/h1/sk")
    for name, s, x in cases:
        p_out, steps = h1(s, x)
        u_point = bjj.mul(sk, p_out)
        n = h2(s, x, u_point)
        m0, q0, e0 = steps["map0"]
        m1, q1, e1 = steps["map1"]
        hashes.append(
            {
                "name": name,
                "sigma": hexf(s),
                "x": hexf(x),
                "u0": hexf(steps["u0"]),
                "u1": hexf(steps["u1"]),
                "map0": map_json(steps["u0"], m0, q0, e0),
                "map1": map_json(steps["u1"], m1, q1, e1),
                "sum": point(steps["sum"]),
                "h1": point(p_out),
                "h1Encoded": bjj.enc_point(p_out).hex(),
                "sk": str(sk),
                "u": point(u_point),
                "n": hexf(n),
            }
        )
    assert len({h["h1Encoded"] for h in hashes}) == len(hashes)
    assert len({h["n"] for h in hashes}) == len(hashes)

    data = {
        "format": "abolish-keyed-nullifier-hashes-vectors/1",
        "title": (
            "Tier 2's in-circuit hashes: Poseidon2 (width 4) and its sponge, Elligator 2 and the "
            "rational map into Baby Jubjub, the scope field, H1 and H2"
        ),
        "spec": "docs/spec/keyed-nullifier-hashes.md",
        "generator": (
            "packages/crypto/scripts/keyed-nullifier-hashes-vectors.py: an independent Python "
            "implementation from the Poseidon2 paper, RFC 9380 and the spec, with round constants "
            "from the Grain LFSR and the internal diagonal from " + DIAGONAL_SOURCE + ", checked "
            "against that crate's known answer, the Poseidon2 reference code's width-3 answer and "
            "TACEO's encode answers first"
        ),
        "poseidon2": {
            "t": T,
            "roundsFull": ROUNDS_F,
            "roundsPartial": ROUNDS_P,
            "alpha": ALPHA,
            "externalMatrix": M4,
            "internalDiagonal": [hexf(v) for v in DIAGONAL],
            "roundConstants": [[hexf(v) for v in r] for r in RC],
            "permutations": permutations,
            "sponges": sponges,
        },
        "tags": {
            "h1": {"tag": H1_TAG, "field": hexf(circuit.tag_field(H1_TAG)[1])},
            "h2": {"tag": H2_TAG, "field": hexf(circuit.tag_field(H2_TAG)[1])},
        },
        "map": {
            "montgomeryJ": str(MONT_J),
            "montgomeryK": str(MONT_K),
            "z": str(Z),
            "cases": maps,
            "exceptional": exceptional,
        },
        "scopes": scopes,
        "hashes": hashes,
    }
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "keyed-nullifier-hashes.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
