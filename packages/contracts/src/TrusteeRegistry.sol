// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator, EventAccumulatorLib} from "./EventAccumulator.sol";
import {ITrusteeRegistry} from "./ITrusteeRegistry.sol";

/// @title Trustee identity keys, panels and signatures on chain
/// (docs/spec/trustee-identity.md, On chain).
/// @notice Signatures are checked only through OpenZeppelin's audited `P256`
/// (vendored, see the package README), which uses the `P256VERIFY`
/// precompile where it exists. No curve arithmetic is implemented here.
library TrusteeIdentityLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/panel` (0x10 = 16).
    bytes internal constant DS_PANEL = "\x10abolish/v1/panel";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/ceremony-registration` (0x24 = 36).
    bytes internal constant DS_CEREMONY_REGISTRATION = "\x24abolish/v1/sig/ceremony-registration";

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
    /// 125-byte layout of docs/spec/trustee-identity.md (Ceremony registration).
    function registrationDigest(
        uint64 chainId,
        address registry,
        bytes32 panel,
        uint8 index,
        bytes32 stubHash,
        bytes32 transcriptHash
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_CEREMONY_REGISTRATION, chainId, registry, panel, index, stubHash, transcriptHash
            )
        );
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
contract TrusteeRegistry is EventAccumulator, ITrusteeRegistry {
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
    error SeatsOutOfOrder(uint8 index);
    error BelowQuorum(uint256 seats, uint8 quorum);
    error InvalidSignature(uint8 index);
    error AlreadyRecorded(bytes32 stubHash, bytes32 panelId);

    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(count)`.
    uint256 private constant HEADER_LENGTH = 97;
    /// `u8(index) ‖ p256-sig`.
    uint256 private constant APPROVAL_LENGTH = 65;

    /// The pinned panels' identifiers, in deployment order.
    bytes32[] public panelIds;
    mapping(bytes32 panelId => Panel) public panelOf;
    mapping(bytes32 panelId => mapping(uint256 index => uint256[2])) private _keyOf;
    mapping(bytes32 stubHash => mapping(bytes32 panelId => bytes32)) public transcriptOf;

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

    /// @notice Records a ceremony transcript for a definition stub. The
    /// argument is the record of docs/spec/contracts.md (Trustee registry,
    /// Registration):
    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(count) ‖
    /// count × (u8(index) ‖ p256-sig)`, seats in strictly increasing order.
    /// Reverts unless the panel is pinned, the transcript hash is non-zero,
    /// at least `quorum` seats sign, every signature verifies under its
    /// seat's pinned key, and nothing is recorded yet for this stub and panel.
    function registerCeremony(bytes calldata registration) external {
        CanonicalCalldata.requireOneBytesArgument(registration);
        uint256 len = registration.length;
        if (len < HEADER_LENGTH) revert MalformedRegistration();
        bytes32 panel = bytes32(registration[0:32]);
        bytes32 stub = bytes32(registration[32:64]);
        bytes32 transcript = bytes32(registration[64:96]);
        uint256 count = uint8(registration[96]);
        if (len != HEADER_LENGTH + count * APPROVAL_LENGTH) revert MalformedRegistration();

        Panel memory p = panelOf[panel];
        if (p.size == 0) revert UnknownPanel(panel);
        // Zero is the stub's own transcript field, never a transcript.
        if (transcript == bytes32(0)) revert ZeroTranscriptHash();
        if (count < p.quorum) revert BelowQuorum(count, p.quorum);
        // At most one transcript per stub and panel, first come: a quorum
        // can't hold a second set of keys in reserve (ceremony.md, Approval).
        if (transcriptOf[stub][panel] != bytes32(0)) revert AlreadyRecorded(stub, panel);

        uint8 previous;
        for (uint256 i; i < count; i++) {
            uint256 at = HEADER_LENGTH + i * APPROVAL_LENGTH;
            uint8 index = uint8(registration[at]);
            // Strictly increasing seats: each counts once, so one seat (or
            // one stolen key) signing twice never makes a quorum (T-14).
            if (index <= previous || index > p.size) revert SeatsOutOfOrder(index);
            previous = index;
            uint256 r = uint256(bytes32(registration[at + 1:at + 33]));
            uint256 s = uint256(bytes32(registration[at + 33:at + 65]));
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                EventAccumulatorLib.chainId64(block.chainid),
                address(this),
                panel,
                index,
                stub,
                transcript
            );
            uint256[2] storage q = _keyOf[panel][index];
            if (!TrusteeIdentityLib.verify(digest, r, s, q[0], q[1])) {
                revert InvalidSignature(index);
            }
        }

        transcriptOf[stub][panel] = transcript;
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
