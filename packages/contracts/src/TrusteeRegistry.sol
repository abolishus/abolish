// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator, EventAccumulatorLib} from "./EventAccumulator.sol";
import {ITrusteeRegistry} from "./ITrusteeRegistry.sol";
import {ITrusteePanels} from "./NullifierKey.sol";

/// @title Trustee identity keys, panels and signatures on chain
/// (docs/spec/trustee-identity.md, On chain).
/// @notice Signatures are checked only through OpenZeppelin's audited `P256`
/// (vendored, see the package README), which uses the `P256VERIFY`
/// precompile where it exists. No curve arithmetic is implemented here.
library TrusteeIdentityLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/panel` (0x10 = 16).
    bytes internal constant DS_PANEL = "\x10abolish/v1/panel";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/ceremony-registration-2` (0x26 = 38).
    bytes internal constant DS_CEREMONY_REGISTRATION = "\x26abolish/v1/sig/ceremony-registration-2";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/key-set` (0x12 = 18).
    bytes internal constant DS_KEY_SET = "\x12abolish/v1/key-set";

    /// P-256's group order `n`.
    uint256 internal constant N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    /// `(n − 1) / 2`, the largest `s` the low-s rule allows.
    uint256 internal constant HALF_N =
        0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;
    /// The largest panel ([[parameters]], `MAX_TRUSTEES`).
    uint256 internal constant MAX_TRUSTEES = 16;
    /// A `p256-key` is 33 bytes; a `p256-sig` 64.
    uint256 internal constant KEY_LENGTH = 33;
    /// A key-set seat in a registration record: `u8(index) ‖ kem_key_hash ‖ x ‖ y`.
    uint256 internal constant SEAT_LENGTH = 97;

    /// Whether `key` (33 bytes at `offset` in `keys`) is the `p256-key`
    /// encoding of the point `(x, y)`: prefix `0x02 + (y mod 2)`, the same `x`,
    /// and `(x, y)` on the curve with both coordinates below `p`. Exactly the
    /// encodings the crypto package's `p256Key` accepts have such a point,
    /// so a deployment pins exactly the keys a verifier would decode.
    function keyMatches(bytes memory keys, uint256 offset, uint256 x, uint256 y)
        internal
        pure
        returns (bool)
    {
        uint8 prefix = uint8(keys[offset]);
        bytes32 encodedX;
        assembly ("memory-safe") {
            encodedX := mload(add(add(keys, 0x21), offset))
        }
        return prefix == 2 + (y & 1) && uint256(encodedX) == x
            && P256.isValidPublicKey(bytes32(x), bytes32(y));
    }

    /// `H(DS("abolish/v1/panel", u8(k) ‖ u8(n) ‖ Q_1 ‖ … ‖ Q_n))`.
    function panelId(uint8 threshold, uint8 size, bytes memory keys)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(DS_PANEL, threshold, size, keys));
    }

    /// The digest `H(DS(tag, m))` of a ceremony registration, with `m` the
    /// 157-byte layout of docs/spec/trustee-identity.md (Ceremony registration).
    function registrationDigest(
        uint64 chainId,
        address registry,
        bytes32 panel,
        uint8 index,
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 keySetHash
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_CEREMONY_REGISTRATION,
                chainId,
                registry,
                panel,
                index,
                stubHash,
                transcriptHash,
                keySetHash
            )
        );
    }

    /// `key_set_hash = H(DS("abolish/v1/key-set", encode(key_set)))` of the
    /// `count` seats starting at `from` in a registration record, each
    /// `u8(index) ‖ kem_key_hash ‖ x ‖ y` (docs/spec/ceremony.md, Key set
    /// hash). Each entry's signing key is the point's `p256-key` encoding,
    /// `u8(0x02 + (y mod 2)) ‖ x`, the only one it has; the caller checks the
    /// points and seats.
    function hashKeySet(bytes calldata record, uint256 from, uint256 count)
        internal
        pure
        returns (bytes32)
    {
        bytes memory encoded = abi.encodePacked(uint32(count));
        for (uint256 i; i < count; i++) {
            uint256 at = from + i * SEAT_LENGTH;
            uint256 y = uint256(bytes32(record[at + 65:at + 97]));
            encoded = bytes.concat(
                encoded, record[at:at + 33], bytes1(uint8(2 + (y & 1))), record[at + 33:at + 65]
            );
        }
        return sha256(bytes.concat(DS_KEY_SET, encoded));
    }

    /// ECDSA verification of `r ‖ s` on `digest` under `(x, y)`. The range
    /// and low-s rules are checked here as well as in `P256.verify`, as
    /// defence in depth against a library change (trustee-identity.md, On chain).
    function verify(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y)
        internal
        view
        returns (bool)
    {
        if (r == 0 || r >= N || s == 0 || s > HALF_N) return false;
        return P256.verify(digest, bytes32(r), bytes32(s), bytes32(x), bytes32(y));
    }
}

/// @title The trustee key registry (docs/spec/contracts.md, Trustee registry).
/// @notice Pins the deployment's trustee panels at construction and records,
/// write-once, which ceremony transcript a quorum of distinct seats of a
/// panel approved for a definition stub. Anyone may submit a registration:
/// it counts only through the seats' signatures, never through who sent it
/// (T-71, T-37). A seat counts at most once, so one key can't reach a quorum
/// by signing twice (T-14). There is no admin, proxy, pause or upgrade path,
/// and no way to add, change or remove a panel after deployment.
contract TrusteeRegistry is EventAccumulator, ITrusteeRegistry, ITrusteePanels {
    /// A panel as the deployment pins it.
    struct PanelInput {
        uint8 threshold;
        /// How many distinct seats must sign a ceremony registration,
        /// `threshold ≤ quorum ≤ n` (docs/spec/contracts.md, Trustee registry).
        uint8 quorum;
        /// The seats' `p256-key` encodings, in seat order (`n × 33` bytes).
        bytes keys;
        /// Each seat's key as `(x, y)`, checked against its encoding.
        uint256[2][] points;
    }

    struct Panel {
        uint8 threshold;
        uint8 size;
        uint8 quorum;
    }

    /// Why a deployment's panel was refused, in the order the checks run.
    /// The first four are trustee-identity.md's panel rules and codes.
    enum PanelError {
        None,
        Size,
        Threshold,
        Key,
        DuplicateKey,
        Quorum,
        DuplicatePanel
    }

    /// @notice A panel is pinned: its threshold, quorum and keys, so the board
    /// and any verifier read the deployment's panels from the chain alone.
    event PanelPinned(bytes32 indexed panelId, uint8 threshold, uint8 quorum, bytes keys);

    /// @notice A quorum of the panel approved `transcriptHash` for `stubHash`.
    /// `registration` is the whole submitted record, signatures included, so
    /// anyone can check the approvals against the pinned keys.
    event CeremonyRegistered(
        bytes32 indexed stubHash,
        bytes32 indexed panelId,
        bytes32 indexed transcriptHash,
        bytes registration
    );

    error NoPanels();
    error InvalidPanel(uint256 position, PanelError reason);
    error MalformedRegistration();
    error UnknownPanel(bytes32 panelId);
    error ZeroTranscriptHash();
    error KeySetTooSmall(uint256 seats, uint8 threshold);
    error KeySetSeatsOutOfOrder(uint8 index);
    error InvalidSigningKey(uint8 index);
    error DuplicateSigningKey(uint8 index);
    error SeatsOutOfOrder(uint8 index);
    error BelowQuorum(uint256 seats, uint8 quorum);
    error InvalidSignature(uint8 index);
    error AlreadyRecorded(bytes32 stubHash, bytes32 panelId);

    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(seats)`.
    uint256 private constant HEADER_LENGTH = 97;
    /// `u8(index) ‖ p256-sig`.
    uint256 private constant APPROVAL_LENGTH = 65;

    /// A key set as the registry records it: its hash, which every approval
    /// signed, and its seats as a bitmask (bit `i` for seat `i`).
    struct KeySet {
        bytes32 hash;
        uint256 seats;
    }

    /// The pinned panels' identifiers, in deployment order.
    bytes32[] public panelIds;
    mapping(bytes32 panelId => Panel) public panelOf;
    mapping(bytes32 panelId => mapping(uint256 index => uint256[2])) private _keyOf;
    mapping(bytes32 stubHash => mapping(bytes32 panelId => bytes32)) public transcriptOf;
    mapping(bytes32 stubHash => mapping(bytes32 panelId => KeySet)) private _keySetOf;
    mapping(
        bytes32 stubHash => mapping(bytes32 panelId => mapping(uint256 index => uint256[2]))
    ) private _signingKeyOf;

    constructor(PanelInput[] memory panels) {
        if (panels.length == 0) revert NoPanels();
        for (uint256 i; i < panels.length; i++) {
            _pin(i, panels[i]);
        }
    }

    /// @notice How many panels the deployment pins.
    function panelCount() external view returns (uint256) {
        return panelIds.length;
    }

    /// @notice Seat `index`'s identity key as `(x, y)`; zero outside the panel.
    function keyOf(bytes32 panelId, uint256 index) external view returns (uint256 x, uint256 y) {
        uint256[2] storage q = _keyOf[panelId][index];
        return (q[0], q[1]);
    }

    /// @notice The registered key set recorded for a stub and panel: its
    /// `key_set_hash` and its seats as a bitmask (bit `i` set for seat `i`).
    /// Both zero when nothing is recorded. The board takes an election's
    /// qualified seats from here, never from a submitter (ADR 0028, 2B).
    function keySetOf(bytes32 stubHash, bytes32 panelId)
        external
        view
        returns (bytes32 keySetHash, uint256 seats)
    {
        KeySet storage k = _keySetOf[stubHash][panelId];
        return (k.hash, k.seats);
    }

    /// @notice Seat `index`'s per-election signing key as `(x, y)` in the key
    /// set recorded for a stub and panel; zero for a seat outside it.
    function signingKeyOf(bytes32 stubHash, bytes32 panelId, uint256 index)
        external
        view
        returns (uint256 x, uint256 y)
    {
        uint256[2] storage q = _signingKeyOf[stubHash][panelId][index];
        return (q[0], q[1]);
    }

    /// @notice Records a ceremony transcript and its registered key set for a
    /// definition stub. The argument is the record of docs/spec/contracts.md
    /// (Trustee registry, Registration):
    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(seats) ‖
    /// seats × (u8(index) ‖ kem_key_hash ‖ x ‖ y) ‖ u8(count) ‖
    /// count × (u8(index) ‖ p256-sig)`, seats in strictly increasing order in
    /// both lists. Reverts unless the panel is pinned, the transcript hash is
    /// non-zero, at least `quorum` seats sign, nothing is recorded yet for
    /// this stub and panel, the key set has at least `threshold` seats with
    /// distinct valid signing keys, none an identity key, and every signature
    /// verifies under its seat's pinned key over the key set's hash.
    function registerCeremony(bytes calldata registration) external {
        CanonicalCalldata.requireOneBytesArgument(registration);
        if (registration.length < HEADER_LENGTH) revert MalformedRegistration();
        uint256 seats = uint8(registration[96]);
        uint256 approvalsAt = HEADER_LENGTH + seats * TrusteeIdentityLib.SEAT_LENGTH + 1;
        if (registration.length < approvalsAt) revert MalformedRegistration();
        uint256 count = uint8(registration[approvalsAt - 1]);
        if (registration.length != approvalsAt + count * APPROVAL_LENGTH) {
            revert MalformedRegistration();
        }

        bytes32 panel = bytes32(registration[0:32]);
        bytes32 stub = bytes32(registration[32:64]);
        Panel memory p = panelOf[panel];
        if (p.size == 0) revert UnknownPanel(panel);
        // Zero is the stub's own transcript field, never a transcript.
        if (bytes32(registration[64:96]) == bytes32(0)) revert ZeroTranscriptHash();
        if (count < p.quorum) revert BelowQuorum(count, p.quorum);
        // At most one transcript per stub and panel, first come: a quorum
        // can't hold a second set of keys in reserve (ceremony.md, Approval).
        if (transcriptOf[stub][panel] != bytes32(0)) revert AlreadyRecorded(stub, panel);

        KeySet memory k = _checkKeySet(registration, panel, p, seats);
        _checkApprovals(registration, approvalsAt, count, p, k.hash);
        _record(registration, k, seats);
    }

    /// Records the transcript, the key set and each of its seats' signing
    /// keys for the record's stub and panel, once every check has passed.
    function _record(bytes calldata registration, KeySet memory k, uint256 seats) private {
        bytes32 panel = bytes32(registration[0:32]);
        bytes32 stub = bytes32(registration[32:64]);
        bytes32 transcript = bytes32(registration[64:96]);
        transcriptOf[stub][panel] = transcript;
        _keySetOf[stub][panel] = k;
        for (uint256 i; i < seats; i++) {
            uint256 at = HEADER_LENGTH + i * TrusteeIdentityLib.SEAT_LENGTH;
            _signingKeyOf[stub][panel][uint8(registration[at])] = [
                uint256(bytes32(registration[at + 33:at + 65])),
                uint256(bytes32(registration[at + 65:at + 97]))
            ];
        }
        _log4(CeremonyRegistered.selector, stub, panel, transcript, abi.encode(registration));
    }

    /// @inheritdoc ITrusteeRegistry
    function ceremonyRecorded(
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 panelId,
        uint8 threshold,
        uint8 panelSize
    ) external view returns (bool) {
        Panel memory p = panelOf[panelId];
        bytes32 recorded = transcriptOf[stubHash][panelId];
        return p.size != 0 && p.threshold == threshold && p.size == panelSize
            && recorded != bytes32(0) && recorded == transcriptHash;
    }

    /// The key set's checks (contracts.md, Registration, 7 and 8), seat by
    /// seat, then its `key_set_hash` and seat bitmask. Nothing is stored yet:
    /// the signatures over the hash are checked first.
    function _checkKeySet(bytes calldata registration, bytes32 panel, Panel memory p, uint256 seats)
        private
        view
        returns (KeySet memory)
    {
        uint256 mask;
        // At least k seats, so the panel can open a ballot (ceremony.md,
        // Transcript check, 5).
        if (seats < p.threshold) revert KeySetTooSmall(seats, p.threshold);
        uint256[2][] memory identity = new uint256[2][](p.size);
        for (uint256 j; j < p.size; j++) {
            identity[j] = _keyOf[panel][j + 1];
        }
        uint256[2][] memory points = new uint256[2][](seats);
        uint8 previous;
        for (uint256 i; i < seats; i++) {
            uint256 at = HEADER_LENGTH + i * TrusteeIdentityLib.SEAT_LENGTH;
            uint8 index = uint8(registration[at]);
            if (index <= previous || index > p.size) revert KeySetSeatsOutOfOrder(index);
            previous = index;
            uint256 x = uint256(bytes32(registration[at + 33:at + 65]));
            uint256 y = uint256(bytes32(registration[at + 65:at + 97]));
            if (!P256.isValidPublicKey(bytes32(x), bytes32(y))) revert InvalidSigningKey(index);
            // One key never signs for two seats, and an identity key never
            // signs as a per-election key (trustee-identity.md, Which key
            // signs what; T-37). An honest set always passes: the transcript
            // check disqualifies such a seat (duplicate-key).
            for (uint256 j; j < i; j++) {
                if (points[j][0] == x && points[j][1] == y) revert DuplicateSigningKey(index);
            }
            for (uint256 j; j < identity.length; j++) {
                if (identity[j][0] == x && identity[j][1] == y) revert DuplicateSigningKey(index);
            }
            points[i] = [x, y];
            mask |= 1 << index;
        }
        return KeySet(TrusteeIdentityLib.hashKeySet(registration, HEADER_LENGTH, seats), mask);
    }

    /// The approvals' checks (contracts.md, Registration, 9 and 10), approval
    /// by approval: its seat, then its signature over the statement with the
    /// key set's hash.
    function _checkApprovals(
        bytes calldata registration,
        uint256 approvalsAt,
        uint256 count,
        Panel memory p,
        bytes32 keySetHash
    ) private view {
        uint8 previous;
        for (uint256 i; i < count; i++) {
            uint256 at = approvalsAt + i * APPROVAL_LENGTH;
            uint8 index = uint8(registration[at]);
            // Strictly increasing seats: each counts once, so one seat (or
            // one stolen key) signing twice never makes a quorum (T-14).
            if (index <= previous || index > p.size) revert SeatsOutOfOrder(index);
            previous = index;
            uint256[2] storage q = _keyOf[bytes32(registration[0:32])][index];
            if (!TrusteeIdentityLib.verify(
                    _digest(registration, index, keySetHash),
                    uint256(bytes32(registration[at + 1:at + 33])),
                    uint256(bytes32(registration[at + 33:at + 65])),
                    q[0],
                    q[1]
                )) {
                revert InvalidSignature(index);
            }
        }
    }

    /// The digest seat `index` signs for this record: the statement over
    /// this chain, this registry, the record's panel, stub and transcript,
    /// and `keySetHash` computed from its seats.
    function _digest(bytes calldata registration, uint8 index, bytes32 keySetHash)
        private
        view
        returns (bytes32)
    {
        return TrusteeIdentityLib.registrationDigest(
            EventAccumulatorLib.chainId64(block.chainid),
            address(this),
            bytes32(registration[0:32]),
            index,
            bytes32(registration[32:64]),
            bytes32(registration[64:96]),
            keySetHash
        );
    }

    /// Checks one panel in trustee-identity.md's order (size, threshold, each
    /// key and its duplicates), then its quorum and that it is new, and
    /// stores it.
    function _pin(uint256 position, PanelInput memory input) private {
        uint256 n = input.points.length;
        if (n > TrusteeIdentityLib.MAX_TRUSTEES) revert InvalidPanel(position, PanelError.Size);
        if (input.threshold < 2 || input.threshold > n) {
            revert InvalidPanel(position, PanelError.Threshold);
        }
        if (input.keys.length != n * TrusteeIdentityLib.KEY_LENGTH) {
            revert InvalidPanel(position, PanelError.Key);
        }
        for (uint256 i; i < n; i++) {
            uint256[2] memory q = input.points[i];
            if (!TrusteeIdentityLib.keyMatches(
                    input.keys, i * TrusteeIdentityLib.KEY_LENGTH, q[0], q[1]
                )) {
                revert InvalidPanel(position, PanelError.Key);
            }
            // One point has one encoding, so equal points are equal keys.
            for (uint256 j; j < i; j++) {
                if (input.points[j][0] == q[0] && input.points[j][1] == q[1]) {
                    revert InvalidPanel(position, PanelError.DuplicateKey);
                }
            }
        }
        if (input.quorum < input.threshold || input.quorum > n) {
            revert InvalidPanel(position, PanelError.Quorum);
        }

        // n ≤ 16, so it fits a u8.
        bytes32 id = TrusteeIdentityLib.panelId(input.threshold, uint8(n), input.keys);
        if (panelOf[id].size != 0) revert InvalidPanel(position, PanelError.DuplicatePanel);
        panelOf[id] = Panel({threshold: input.threshold, size: uint8(n), quorum: input.quorum});
        panelIds.push(id);
        for (uint256 i; i < n; i++) {
            _keyOf[id][i + 1] = input.points[i];
        }
        _log2(PanelPinned.selector, id, abi.encode(input.threshold, input.quorum, input.keys));
    }
}
