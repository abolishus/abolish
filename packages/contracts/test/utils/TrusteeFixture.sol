// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {TrusteeIdentityLib, TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {Vm} from "./Vm.sol";

/// Exposes the library's internal functions to the tests.
contract TrusteeHarness {
    function keyMatches(bytes memory key, uint256 x, uint256 y) external pure returns (bool) {
        return TrusteeIdentityLib.keyMatches(key, 0, x, y);
    }

    function verify(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y)
        external
        view
        returns (bool)
    {
        return TrusteeIdentityLib.verify(digest, r, s, x, y);
    }

    function panelId(uint8 threshold, uint8 size, bytes memory keys)
        external
        pure
        returns (bytes32)
    {
        return TrusteeIdentityLib.panelId(threshold, size, keys);
    }

    function registrationDigest(
        uint64 chainId,
        address registry,
        bytes32 panel,
        uint8 index,
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 keySetHash
    ) external pure returns (bytes32) {
        return TrusteeIdentityLib.registrationDigest(
            chainId, registry, panel, index, stubHash, transcriptHash, keySetHash
        );
    }

    /// `key_set_hash` of `seats`, `count × (u8(index) ‖ kem_key_hash ‖ x ‖ y)`.
    function keySetHash(bytes calldata seats) external pure returns (bytes32) {
        return
            TrusteeIdentityLib.hashKeySet(seats, 0, seats.length / TrusteeIdentityLib.SEAT_LENGTH);
    }
}

/// Keys, panels and signed registrations for the trustee registry tests,
/// taken from docs/spec/vectors/trustee.json (produced by an independent
/// Python implementation), with signatures made by Foundry's `signP256`.
library TrusteeFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant VECTORS = "../../docs/spec/vectors/trustee.json";
    string internal constant KEY_SET_VECTORS = "../../docs/spec/vectors/key-set.json";

    uint256 internal constant P =
        0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 internal constant B =
        0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b;

    /// A signature by `seat`, as the registration record carries it.
    struct Approval {
        uint8 index;
        uint256 r;
        uint256 s;
    }

    /// A seat of the registered key set, as the registration record carries it.
    struct Seat {
        uint8 index;
        bytes32 kemKeyHash;
        uint256 x;
        uint256 y;
    }

    /// The key set `id` of docs/spec/vectors/key-set.json (an independent
    /// Python implementation), with its seats' points.
    function keySet(string memory json, string memory id)
        internal
        view
        returns (Seat[] memory seats)
    {
        uint256 i = _find(json, ".keySets", id);
        string memory at = string.concat(".keySets[", vm.toString(i), "].entries");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(at, "[", vm.toString(n), "]"))) n++;
        seats = new Seat[](n);
        for (uint256 k; k < n; k++) {
            string memory e = string.concat(at, "[", vm.toString(k), "]");
            seats[k] = Seat({
                index: uint8(vm.parseJsonUint(json, string.concat(e, ".index"))),
                kemKeyHash: bytes32(
                    vm.parseBytes(vm.parseJsonString(json, string.concat(e, ".kemKeyHash")))
                ),
                x: uint256(
                    bytes32(vm.parseBytes(vm.parseJsonString(json, string.concat(e, ".x"))))
                ),
                y: uint256(bytes32(vm.parseBytes(vm.parseJsonString(json, string.concat(e, ".y")))))
            });
        }
    }

    /// `seats × (u8(index) ‖ kem_key_hash ‖ x ‖ y)`, without the count.
    function seatBytes(Seat[] memory seats) internal pure returns (bytes memory out) {
        for (uint256 i; i < seats.length; i++) {
            out = abi.encodePacked(out, seats[i].index, seats[i].kemKeyHash, seats[i].x, seats[i].y);
        }
    }

    /// The point a 33-byte encoding names, decompressed here (test code, not
    /// protocol code) so the deployment's check can be fed coordinates:
    /// `y = (x³ − 3x + b)^((p + 1) / 4)`, which is a square root because
    /// `p ≡ 3 (mod 4)`, with the parity the prefix asks for (or the prefix's
    /// low bit for a prefix that isn't 2 or 3). `onCurve` is false when
    /// `x ≥ p` or no root exists; `(x, y)` is then meaningless.
    function point(bytes memory enc) internal view returns (uint256 x, uint256 y, bool onCurve) {
        require(enc.length >= 33, "short key");
        x = uint256(bytes32(_slice(enc, 1, 32)));
        if (x >= P) return (x, 0, false);
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), addmod(B, P - mulmod(3, x, P), P), P);
        y = _modExp(rhs, (P + 1) / 4, P);
        if (mulmod(y, y, P) != rhs) return (x, y, false);
        if ((y & 1) != (uint8(enc[0]) & 1)) y = P - y;
        onCurve = true;
    }

    /// The panel `id` of the vectors, as a deployment input with quorum `quorum`.
    function panel(string memory json, string memory id, uint8 quorum)
        internal
        view
        returns (TrusteeRegistry.PanelInput memory input)
    {
        uint256 i = _find(json, ".panels", id);
        string memory at = string.concat(".panels[", vm.toString(i), "]");
        string[] memory keys = vm.parseJsonStringArray(json, string.concat(at, ".keys"));
        input.threshold = uint8(vm.parseJsonUint(json, string.concat(at, ".threshold")));
        input.quorum = quorum;
        input.points = new uint256[2][](keys.length);
        for (uint256 k; k < keys.length; k++) {
            bytes memory enc = vm.parseBytes(keys[k]);
            input.keys = bytes.concat(input.keys, enc);
            (uint256 x, uint256 y,) = point(enc);
            input.points[k] = [x, y];
        }
    }

    /// The secret key of vector `key-<seat>` (seats 1 to 7 of `panel-4-of-7`).
    function secret(string memory json, uint8 seat) internal view returns (uint256) {
        uint256 i = _find(json, ".keys", string.concat("key-", vm.toString(uint256(seat))));
        return vm.parseUint(
            string.concat(
                "0x",
                vm.parseJsonString(json, string.concat(".keys[", vm.toString(i), "].secretKey"))
            )
        );
    }

    /// A low-s signature by `sk` on `digest` (the low-s rule of trustee-identity.md).
    function sign(uint256 sk, bytes32 digest) internal pure returns (uint256 r, uint256 s) {
        (bytes32 rb, bytes32 sb) = vm.signP256(sk, digest);
        (r, s) = (uint256(rb), uint256(sb));
        if (s > TrusteeIdentityLib.HALF_N) s = TrusteeIdentityLib.N - s;
    }

    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(seats) ‖
    /// seats × (u8(index) ‖ kem_key_hash ‖ x ‖ y) ‖ u8(count) ‖
    /// count × (u8(index) ‖ r ‖ s)`.
    function encode(
        bytes32 panelId,
        bytes32 stub,
        bytes32 transcript,
        Seat[] memory seats,
        Approval[] memory a
    ) internal pure returns (bytes memory) {
        return encode(panelId, stub, transcript, uint8(seats.length), seatBytes(seats), a);
    }

    /// The same, with the key set's seats already encoded.
    function encode(
        bytes32 panelId,
        bytes32 stub,
        bytes32 transcript,
        uint8 seatCount,
        bytes memory seats,
        Approval[] memory a
    ) internal pure returns (bytes memory out) {
        out = abi.encodePacked(panelId, stub, transcript, seatCount, seats, uint8(a.length));
        for (uint256 i; i < a.length; i++) {
            out = abi.encodePacked(out, a[i].index, a[i].r, a[i].s);
        }
    }

    function _find(string memory json, string memory list, string memory id)
        private
        view
        returns (uint256 i)
    {
        for (;; i++) {
            string memory key = string.concat(list, "[", vm.toString(i), "].id");
            require(vm.keyExistsJson(json, key), string.concat("no vector ", id));
            if (keccak256(bytes(vm.parseJsonString(json, key))) == keccak256(bytes(id))) return i;
        }
    }

    function _modExp(uint256 base, uint256 e, uint256 m) private view returns (uint256 result) {
        (bool ok, bytes memory out) = address(0x05)
            .staticcall(abi.encodePacked(uint256(32), uint256(32), uint256(32), base, e, m));
        require(ok, "modexp");
        result = abi.decode(out, (uint256));
    }

    function _slice(bytes memory b, uint256 from, uint256 len)
        private
        pure
        returns (bytes memory out)
    {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[from + i];
        }
    }
}
