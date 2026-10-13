// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title Membership proofs on chain (docs/spec/contracts.md, Board, Membership proofs).
/// @notice Semaphore v4's Groth16 membership proofs, checked as
/// docs/spec/membership.md specifies: strict decoding of the proof's three
/// points, every public signal below `r`, a root other than 0, and Groth16's
/// equation (Groth, EUROCRYPT 2016, §3.2) under the pinned depth-32 key, which
/// is a constant here and never an input (T-05, T-31). The curve arithmetic,
/// the pairing and G2's subgroup check are the EVM's BN254 precompiles
/// (EIP-196, EIP-197): this library composes them and implements no
/// primitive (ADR 0028, option 4C). It also computes the nullifier scope `ŝ`
/// and Semaphore's field mapping `F`, so a contract derives the signals from
/// the registered definition rather than from the submitter (T-12).
library MembershipProofLib {
    /// BN254's base field order `p`.
    uint256 internal constant P =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    /// BN254's scalar field order `r`.
    uint256 internal constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// `membership_proof` is `A ‖ B ‖ C`: 64 + 128 + 64 bytes.
    uint256 internal constant PROOF_LENGTH = 256;
    /// The protocol-wide tree depth the pinned key is for (membership.md, Tree depth).
    uint8 internal constant DEPTH = 32;
    /// The gas `ecPairing` gets: four pairs cost 45,000 + 4 × 34,000 =
    /// 181,000 under EIP-1108, with margin for a repricing. A pairing that
    /// came to cost more would fail every proof, so an increase past this
    /// needs a new contract (docs/spec/contracts.md, Board, Known-weak).
    uint256 internal constant PAIRING_GAS = 300_000;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/nullifier-scope` (0x1a = 26).
    bytes internal constant DS_SCOPE = "\x1aabolish/v1/nullifier-scope";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/membership-vk` (0x18 = 24).
    bytes internal constant DS_VK = "\x18abolish/v1/membership-vk";
    /// sha256 of `semaphore-32.zkey`, the proving key the reference-string
    /// check covered (membership.md, Verification key).
    bytes32 internal constant ZKEY_SHA256 =
        0x2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650;

    // Semaphore v4.14.3's depth-32 verification key (membership.md,
    // Verification key), in the proof's point encoding: G1 as `x ‖ y`, G2 as
    // `x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0`, the imaginary part first, as EIP-197 takes
    // it. The tests compare `vkEncoding()` and its hash with
    // vectors/membership-proof.json.
    uint256 private constant ALPHA_X =
        0x245229d9b076b3c0e8a4d70bde8c1cccffa08a9fae7557b165b3b0dbd653e2c7;
    uint256 private constant ALPHA_Y =
        0x253ec85988dbb84e46e94b5efa3373b47a000b4ac6c86b2d4b798d274a182302;
    uint256 private constant BETA_X1 =
        0x07090a82e8fabbd39299be24705b92cf208ee8b3487f6f2b39ff27978a29a1db;
    uint256 private constant BETA_X0 =
        0x2424bcc1f60a5472685fd50705b2809626e170120acaf441e133a2bd5e61d244;
    uint256 private constant BETA_Y1 =
        0x0ae1135cffdaf227c5dc266740607aa930bc3bd92ddc2b135086d9da2dfd3e2a;
    uint256 private constant BETA_Y0 =
        0x2b86859fd3d55c9d150fb3f0aeba798826493dd73d357ab0f9fdaced9fc81829;
    uint256 private constant GAMMA_X1 =
        0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2;
    uint256 private constant GAMMA_X0 =
        0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed;
    uint256 private constant GAMMA_Y1 =
        0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b;
    uint256 private constant GAMMA_Y0 =
        0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa;
    uint256 private constant DELTA_X1 =
        0x2aeea52c33986c164976c52dfb73b8524b9e12650cc2e6614eb1efd1d3134f58;
    uint256 private constant DELTA_X0 =
        0x25ca08820ba2a38dcd2561640ae9935ef47b5da8a801641a7066f7dbc52ff365;
    uint256 private constant DELTA_Y1 =
        0x1d8489971cf0f77a525cae847acd5056502177b00ca5b72b3f0fb32e0bb85bb8;
    uint256 private constant DELTA_Y0 =
        0x16d389fa12477aa6c862499500c516228cd9ae7c652c3f61f641b6590b800671;
    uint256 private constant IC0_X =
        0x16569eaf77c8ec57e85b52ee30cd6212133a17ca3a4e87bcfd7507598616214d;
    uint256 private constant IC0_Y =
        0x0e2b188f173ee86cce1a411c0d2ff80e1ead326474358dbf412f8e540c01aa91;
    uint256 private constant IC1_X =
        0x173f752e069ecc268a7427e0935db3acd27fb7bc097e2b2c58d5a6acdd1fb4c1;
    uint256 private constant IC1_Y =
        0x0ef703b9687c4c6f9deddc9c9d3ef5ba1d9a87529d0a7387bc569c6c642913c4;
    uint256 private constant IC2_X =
        0x25fa7538cb83e2a689d5caeac55b325d3597547ef6c8dc122a2a6d000c344eec;
    uint256 private constant IC2_Y =
        0x023e56786b482a73477d0fd36701f0eddd08298e43913144c3f7b879d0988761;
    uint256 private constant IC3_X =
        0x2efec260abd0d45688e61558f0288cbddd8b5774e48466f164d5e522b5441314;
    uint256 private constant IC3_Y =
        0x14d6f2fe1a75dc3f898674bca43b786b3eebb0e2ac53ea6336d2d0496f23399c;
    uint256 private constant IC4_X =
        0x133eef87007a5128b3f86d3ff94bdd1a0143b28d4b72e7b02b2022147764b03a;
    uint256 private constant IC4_Y =
        0x20a11d5fb29aa2ab37f2917d0b42ef10170b5f8614bc6e4decda4186dfafba37;

    /// The public signals in the circuit's order `[ρ, ν, m̂, ŝ]`.
    struct Signals {
        uint256 root;
        uint256 nullifier;
        uint256 message;
        uint256 scope;
    }

    /// A proof's verdict, in the order the checks run (contracts.md, Board,
    /// Membership proofs). The decode verdicts carry the offset of the
    /// failure within the proof, as [[notation]]'s decode errors do.
    enum Verdict {
        Valid,
        Truncated,
        TrailingBytes,
        NonCanonical,
        Signal,
        Root,
        Pairing
    }

    /// The scope's tier isn't 0, 1 or 2.
    error UnknownTier(uint8 tier);
    /// A scope's root of 0, which any secret can prove membership of.
    error ZeroRoot();
    /// A scope's root at or above `r`: not a canonical `field<bn254>`.
    error NonCanonicalRoot(uint256 root);
    /// `ecAdd` or `ecMul` failed on points the library itself made, which
    /// only running out of gas can cause.
    error PrecompileFailed();
    /// Less gas left than the pairing check is given.
    error InsufficientGas();

    /// `F(x) = int(keccak256(x)) >> 8`, Semaphore v4's `hash` of a 32-byte
    /// word (membership.md, Field mapping). Below 2^248, so below `r`.
    function field(bytes32 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(x))) >> 8;
    }

    /// `S = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(tier) ‖ encode(root)))`
    /// (membership.md, Scope). Reverts on a tier other than 0, 1 or 2, a root
    /// of 0, or a root at or above `r`, in that order.
    function scopeBytes(bytes32 definitionHash, uint8 tier, uint256 root)
        internal
        pure
        returns (bytes32)
    {
        if (tier > 2) revert UnknownTier(tier);
        if (root == 0) revert ZeroRoot();
        if (root >= R) revert NonCanonicalRoot(root);
        return sha256(abi.encodePacked(DS_SCOPE, definitionHash, tier, root));
    }

    /// `ŝ = F(S)`, the scope as the circuit's public input.
    function scope(bytes32 definitionHash, uint8 tier, uint256 root)
        internal
        pure
        returns (uint256)
    {
        return field(scopeBytes(definitionHash, tier, root));
    }

    /// The 768-byte `vk`: `alpha`, `beta`, `gamma`, `delta`, then `IC_0` to `IC_4`.
    function vkEncoding() internal pure returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                ALPHA_X, ALPHA_Y, BETA_X1, BETA_X0, BETA_Y1, BETA_Y0, GAMMA_X1, GAMMA_X0
            ),
            abi.encodePacked(GAMMA_Y1, GAMMA_Y0, DELTA_X1, DELTA_X0, DELTA_Y1, DELTA_Y0),
            abi.encodePacked(IC0_X, IC0_Y, IC1_X, IC1_Y, IC2_X, IC2_Y),
            abi.encodePacked(IC3_X, IC3_Y, IC4_X, IC4_Y)
        );
    }

    /// `membership_vk_hash = H(DS("abolish/v1/membership-vk", u8(32) ‖ vk ‖ zkey_sha256))`.
    function vkHash() internal pure returns (bytes32) {
        return sha256(abi.encodePacked(DS_VK, DEPTH, vkEncoding(), ZKEY_SHA256));
    }

    /// Checks a membership proof under the pinned key with the given signals,
    /// in this order: the proof's length; `A`'s and `C`'s coordinates below
    /// `p`, not the identity and on `y² = x³ + 3`; `B`'s coordinates below
    /// `p` and not the identity; every signal below `r`; a root other than 0;
    /// and the pairing equation, in which a `B` off the twist or outside the
    /// order-`r` subgroup makes `ecPairing` fail and is reported as `B`'s
    /// decode failure. So it accepts exactly the proofs `packages/crypto`'s
    /// decoder and verifier accept, and rejects each vector of a broken point
    /// at its offset (membership.md, Proof encoding and Verification). It
    /// needs more than `PAIRING_GAS` left, or reverts. Proofs are
    /// malleable, so a caller never compares proof
    /// bytes to detect a replay (T-38).
    function check(bytes calldata proof, Signals memory s)
        internal
        view
        returns (Verdict verdict, uint256 offset)
    {
        if (proof.length < PROOF_LENGTH) return (Verdict.Truncated, 0);
        if (proof.length > PROOF_LENGTH) return (Verdict.TrailingBytes, PROOF_LENGTH);
        (uint256 ax, uint256 ay) = _word2(proof, 0);
        if (!_g1Valid(ax, ay)) return (Verdict.NonCanonical, 0);
        (uint256 bx1, uint256 bx0) = _word2(proof, 64);
        (uint256 by1, uint256 by0) = _word2(proof, 128);
        if (bx1 >= P || bx0 >= P || by1 >= P || by0 >= P || (bx1 | bx0 | by1 | by0) == 0) {
            return (Verdict.NonCanonical, 64);
        }
        (uint256 cx, uint256 cy) = _word2(proof, 192);
        if (!_g1Valid(cx, cy)) return (Verdict.NonCanonical, 192);
        if (s.root >= R || s.nullifier >= R || s.message >= R || s.scope >= R) {
            return (Verdict.Signal, 0);
        }
        if (s.root == 0) return (Verdict.Root, 0);
        (uint256 lx, uint256 ly) = _linearCombination(s);
        // e(A, B) = e(alpha, beta) · e(L, gamma) · e(C, delta), checked as
        // e(−A, B) · e(alpha, beta) · e(L, gamma) · e(C, delta) = 1.
        bytes memory input = abi.encodePacked(
            abi.encodePacked(ax, (P - ay) % P, bx1, bx0, by1, by0),
            abi.encodePacked(ALPHA_X, ALPHA_Y, BETA_X1, BETA_X0, BETA_Y1, BETA_Y0),
            abi.encodePacked(lx, ly, GAMMA_X1, GAMMA_X0, GAMMA_Y1, GAMMA_Y0),
            abi.encodePacked(cx, cy, DELTA_X1, DELTA_X0, DELTA_Y1, DELTA_Y0)
        );
        // A failed precompile call consumes all the gas it was given, so the
        // pairing gets exactly PAIRING_GAS, and only once that much is
        // available: then every input but B being a valid point by now, a
        // failed call can only mean B isn't on the twist or isn't in the
        // order-r subgroup (EIP-197), never a lack of gas.
        if (gasleft() < PAIRING_GAS + PAIRING_GAS / 63 + 1_000) revert InsufficientGas();
        (bool ok, bytes memory out) = address(8).staticcall{gas: PAIRING_GAS}(input);
        if (!ok || out.length != 32) return (Verdict.NonCanonical, 64);
        if (abi.decode(out, (uint256)) != 1) return (Verdict.Pairing, 0);
        return (Verdict.Valid, 0);
    }

    /// Whether a membership proof passes `check`.
    function verify(bytes calldata proof, Signals memory s) internal view returns (bool) {
        (Verdict verdict,) = check(proof, s);
        return verdict == Verdict.Valid;
    }

    /// Two big-endian words of the proof at `at`.
    function _word2(bytes calldata proof, uint256 at) private pure returns (uint256, uint256) {
        return (uint256(bytes32(proof[at:at + 32])), uint256(bytes32(proof[at + 32:at + 64])));
    }

    /// A G1 point with canonical coordinates, other than the identity and on
    /// the curve (G1 has cofactor 1, so that is the whole group).
    function _g1Valid(uint256 x, uint256 y) private pure returns (bool) {
        if (x >= P || y >= P || (x | y) == 0) return false;
        return mulmod(y, y, P) == addmod(mulmod(mulmod(x, x, P), x, P), 3, P);
    }

    /// `L = IC_0 + ρ·IC_1 + ν·IC_2 + m̂·IC_3 + ŝ·IC_4`.
    function _linearCombination(Signals memory s) private view returns (uint256 x, uint256 y) {
        (x, y) = (IC0_X, IC0_Y);
        (x, y) = _add(x, y, IC1_X, IC1_Y, s.root);
        (x, y) = _add(x, y, IC2_X, IC2_Y, s.nullifier);
        (x, y) = _add(x, y, IC3_X, IC3_Y, s.message);
        (x, y) = _add(x, y, IC4_X, IC4_Y, s.scope);
    }

    /// `(x, y) + k·(px, py)` through `ecMul` and `ecAdd`.
    function _add(uint256 x, uint256 y, uint256 px, uint256 py, uint256 k)
        private
        view
        returns (uint256, uint256)
    {
        (bool ok, bytes memory m) = address(7).staticcall(abi.encode(px, py, k));
        if (!ok || m.length != 64) revert PrecompileFailed();
        (uint256 mx, uint256 my) = abi.decode(m, (uint256, uint256));
        bytes memory sum;
        (ok, sum) = address(6).staticcall(abi.encode(x, y, mx, my));
        if (!ok || sum.length != 64) revert PrecompileFailed();
        return abi.decode(sum, (uint256, uint256));
    }
}
