// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator} from "./EventAccumulator.sol";

/// @title The board checkpoint hash (docs/spec/board.md, Segments and checkpoints).
library CheckpointLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/board-checkpoint-2` (0x1d = 29).
    bytes internal constant DS_BOARD_CHECKPOINT = "\x1dabolish/v1/board-checkpoint-2";

    /// `encode(checkpoint)`: `election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖
    /// root ‖ object_cid ‖ hashes_cid`, each CID 36 bytes.
    uint256 internal constant ENCODED_LENGTH = 180;

    /// A binary CID: `0x01 ‖ codec ‖ 0x12 ‖ 0x20 ‖ sha256(block)`
    /// (docs/spec/content-addressing.md).
    uint256 internal constant CID_LENGTH = 36;

    /// `H(DS("abolish/v1/board-checkpoint-2", encode(checkpoint)))`.
    function hash(bytes memory encoded) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(DS_BOARD_CHECKPOINT, encoded));
    }

    /// Whether `cid` is framed as the content-addressing spec's CIDs are:
    /// CIDv1, a raw (0x55) or dag-pb (0x70) block, and a 32-byte sha2-256
    /// digest. Only the digest is then the authority's choice, as a head or
    /// root is (T-17); whether it names the right bytes is the verifier's
    /// check (`checkpoint-cid`).
    function isFramedCid(bytes calldata cid) internal pure returns (bool) {
        bytes4 prefix = bytes4(cid[0:4]);
        return prefix == 0x01551220 || prefix == 0x01701220;
    }
}

/// @title The L1 board anchor (docs/spec/contracts.md, Board anchor).
/// @notice Records, once per election and segment, the hash of the board's
/// checkpoint after that segment, and publishes the checkpoint itself in the
/// same log, so every result traces to L1 (T-23, T-24). It takes checkpoints
/// only from the anchoring authority fixed at deployment, so no one else can
/// front-run an election's checkpoint with a bogus one (T-52); only inside
/// the window after the period ends, so a late anchor can neither fail a
/// closed election nor hide a fork (T-24, T-53); and only one per election and
/// segment, so it holds no equivocation. Each call may also carry an archive
/// locator naming where the board is archived (docs/adr/0005-permanent-archive.md),
/// so the archive can be found from L1 alone (T-49, T-51). It also keeps the
/// append-only record of receipt keys (docs/adr/0023-receipt-evidence.md), so
/// the keys that judge an election's receipts are fixed by the same authority
/// on L1 (T-26, T-71). There is no admin, proxy, pause or upgrade path: the
/// clock and the authority are fixed at deployment.
contract BoardAnchor is EventAccumulator {
    /// The anchoring clock: period `s` is `[epoch + s·period, epoch + (s+1)·period)`,
    /// and its checkpoint is taken from the period's end to `deadline` seconds after.
    struct Clock {
        uint64 epoch;
        uint64 period;
        uint64 deadline;
    }

    /// @notice A checkpoint was anchored: its hash is now stored for
    /// `(electionId, segment)`. The data is `(size, head, root, objectCid,
    /// hashesCid)`, so with the topics it is the full checkpoint, and the
    /// segment's bytes can be fetched by CID from L1 alone
    /// (docs/adr/0029-board-data-availability.md).
    event CheckpointAnchored(
        bytes32 indexed electionId,
        uint32 indexed segment,
        bytes32 indexed checkpointHash,
        uint64 size,
        bytes32 head,
        bytes32 root,
        bytes objectCid,
        bytes hashesCid
    );

    /// @notice An archive locator: `u16(version) ‖ body`, naming the latest
    /// confirmed archive manifest. The anchor fixes no storage scheme: each
    /// version's body is specified by P4-3, and verifiers ignore versions they
    /// don't know.
    event ArchiveLocated(uint16 indexed version, bytes locator);

    /// @notice A receipt key `prefix ‖ x` (a compressed P-256 key) was
    /// registered; its `registeredAt` is now the block's time.
    event ReceiptKeyRegistered(bytes32 indexed x, uint8 prefix);

    /// @notice A registered receipt key was retired; its `retiredAt` is now
    /// the block's time.
    event ReceiptKeyRetired(bytes32 indexed x, uint8 prefix);

    /// The longest locator accepted, so the authority's chosen bytes on L1 stay bounded (T-17).
    uint256 public constant MAX_LOCATOR_LENGTH = 128;

    /// A compressed P-256 key: `0x02` or `0x03`, then `x`.
    uint256 internal constant RECEIPT_KEY_LENGTH = 33;

    error InvalidDeployment();
    error EmptyCall();
    error MalformedLocator(uint256 length);
    error NotAuthority(address caller);
    error MalformedCheckpoints(uint256 length);
    error EmptyBoard(bytes32 electionId, uint32 segment);
    error MalformedCid(bytes32 electionId, uint32 segment);
    error PeriodNotOver(uint32 segment, uint256 periodEnd, uint256 timestamp);
    error PastDeadline(uint32 segment, uint256 periodEnd, uint256 timestamp);
    error AlreadyAnchored(bytes32 electionId, uint32 segment);
    error MalformedReceiptKey();
    error ReceiptKeyAlreadyRegistered(uint8 prefix, bytes32 x);
    error ReceiptKeyNotActive(uint8 prefix, bytes32 x);

    /// A receipt key's record: when it was registered and retired, in L1
    /// time; zero means never. One storage word, so a verifier proves both
    /// with one storage proof (docs/spec/contracts.md, Receipt keys).
    struct ReceiptKeyRecord {
        uint64 registeredAt;
        uint64 retiredAt;
    }

    /// @custom:storage-location erc7201:abolish.board-anchor
    struct AnchorStorage {
        mapping(bytes32 electionId => mapping(uint32 segment => bytes32)) checkpointHash;
        /// One more than the lowest segment anchored for the election; 0 if none.
        mapping(bytes32 electionId => uint256) lowestSegmentPlusOne;
        /// The last locator posted, and how many have been: state, so the
        /// archive is found from a storage proof even once the logs that
        /// carried locators have expired from L1 history (EIP-4444).
        bytes latestLocator;
        uint256 locatorCount;
        /// Receipt keys by prefix and `x`, at `A + 4`: written only by
        /// `registerReceiptKey` and `retireReceiptKey`, never cleared.
        mapping(uint8 prefix => mapping(bytes32 x => ReceiptKeyRecord)) receiptKeys;
    }

    /// keccak256(abi.encode(uint256(keccak256("abolish.board-anchor")) - 1)) & ~bytes32(uint256(0xff)):
    /// fixed, so a verifier can prove each election's anchors by slot
    /// (docs/spec/contracts.md, Board anchor).
    bytes32 internal constant ANCHOR_SLOT =
        0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00;

    uint64 public immutable epoch;
    uint64 public immutable period;
    uint64 public immutable deadline;
    /// The anchoring authority: a multisig, never a single key (T-53, T-69).
    address public immutable authority;

    constructor(Clock memory clock, address authority_) {
        // An address without code, or with only an EIP-7702 delegation
        // (`0xef0100 ‖ address`), is a single key. Code doesn't prove a
        // multisig, so the deployment record names the Safe, but the plain
        // mistake is refused here.
        if (clock.period == 0 || !_isContract(authority_)) revert InvalidDeployment();
        epoch = clock.epoch;
        period = clock.period;
        deadline = clock.deadline;
        authority = authority_;
    }

    /// @notice The stored checkpoint hash for an election's segment, or zero.
    /// A verifier uses a storage proof of the slot instead.
    function checkpointHashOf(bytes32 electionId, uint32 segment) external view returns (bytes32) {
        return _anchorStorage().checkpointHash[electionId][segment];
    }

    /// @notice One more than the lowest segment anchored for an election, or
    /// 0 if none. With it, a verifier knows which per-segment slots to prove.
    function lowestSegmentPlusOne(bytes32 electionId) external view returns (uint256) {
        return _anchorStorage().lowestSegmentPlusOne[electionId];
    }

    /// @notice The last archive locator posted, and how many have been.
    /// A verifier uses a storage proof of the slots instead.
    function latestLocator() external view returns (bytes memory locator, uint256 count) {
        AnchorStorage storage s = _anchorStorage();
        return (s.latestLocator, s.locatorCount);
    }

    /// @notice A receipt key's record, `(registeredAt, retiredAt)`, zero
    /// where never. A verifier and the ballot client use a storage proof of
    /// the word instead.
    function receiptKeyRecord(uint8 prefix, bytes32 x)
        external
        view
        returns (uint64 registeredAt, uint64 retiredAt)
    {
        ReceiptKeyRecord storage r = _anchorStorage().receiptKeys[prefix][x];
        return (r.registeredAt, r.retiredAt);
    }

    /// @notice The L1 time at which period `segment` ends.
    function periodEnd(uint32 segment) public view returns (uint256) {
        // At most 2^64 + 2^32·2^64: no overflow in 256 bits.
        return uint256(epoch) + (uint256(segment) + 1) * period;
    }

    /// @notice Anchors zero or more checkpoints, each `encode(checkpoint)` of
    /// docs/spec/board.md, concatenated, and publishes an archive locator if
    /// `locator` is non-empty. Reverts, anchoring none, unless the caller is
    /// the authority, the call carries at least one of the two, every
    /// checkpoint has framed CIDs, is non-empty, inside its window and the first for its
    /// election and segment, and the locator is well framed.
    function anchor(bytes calldata checkpoints, bytes calldata locator) external {
        if (msg.sender != authority) revert NotAuthority(msg.sender);
        CanonicalCalldata.requireTwoBytesArguments(checkpoints, locator);
        uint256 len = checkpoints.length;
        if (len == 0 && locator.length == 0) revert EmptyCall();
        if (len % CheckpointLib.ENCODED_LENGTH != 0) revert MalformedCheckpoints(len);
        uint16 version;
        if (locator.length != 0) {
            // A version, then a body of at least one byte; version 0 is
            // reserved so a zero word never reads as a locator.
            if (locator.length < 3 || locator.length > MAX_LOCATOR_LENGTH) {
                revert MalformedLocator(locator.length);
            }
            version = uint16(bytes2(locator[0:2]));
            if (version == 0) revert MalformedLocator(locator.length);
        }
        AnchorStorage storage s = _anchorStorage();
        for (uint256 at; at < len; at += CheckpointLib.ENCODED_LENGTH) {
            _anchorOne(s, checkpoints[at:at + CheckpointLib.ENCODED_LENGTH]);
        }
        if (locator.length != 0) {
            s.latestLocator = locator;
            s.locatorCount += 1;
            _log2(ArchiveLocated.selector, bytes32(uint256(version)), abi.encode(locator));
        }
    }

    /// Checks and stores one checkpoint, `encode(checkpoint)`, reverting on
    /// any rule it breaks.
    function _anchorOne(AnchorStorage storage s, bytes calldata cp) private {
        bytes32 id = bytes32(cp[0:32]);
        uint32 segment = uint32(bytes4(cp[32:36]));
        uint64 size = uint64(bytes8(cp[36:44]));

        if (!CheckpointLib.isFramedCid(cp[108:144]) || !CheckpointLib.isFramedCid(cp[144:180])) {
            revert MalformedCid(id, segment);
        }
        // A checkpoint of an empty board fails the election
        // (`checkpoint-size`), so it is never anchored.
        if (size == 0) revert EmptyBoard(id, segment);
        // The window of docs/spec/board.md, Timing: the verifier ignores
        // an anchor outside it, so it is never stored.
        uint256 end = periodEnd(segment);
        if (block.timestamp < end) revert PeriodNotOver(segment, end, block.timestamp);
        if (block.timestamp - end > deadline) {
            revert PastDeadline(segment, end, block.timestamp);
        }
        // One checkpoint per election and segment, even an equal one, so
        // L1 never holds an equivocation (T-24).
        if (s.checkpointHash[id][segment] != bytes32(0)) revert AlreadyAnchored(id, segment);

        bytes32 h = CheckpointLib.hash(cp);
        s.checkpointHash[id][segment] = h;
        // Lowered only, never raised: the verifier proves every slot from
        // it to the seal, so no anchored checkpoint goes unread (T-24).
        uint256 lowest = s.lowestSegmentPlusOne[id];
        if (lowest == 0 || segment < lowest - 1) {
            s.lowestSegmentPlusOne[id] = uint256(segment) + 1;
        }
        _log4(CheckpointAnchored.selector, id, bytes32(uint256(segment)), h, _eventData(cp));
    }

    /// `CheckpointAnchored`'s data: `(size, head, root, objectCid, hashesCid)`.
    function _eventData(bytes calldata cp) private pure returns (bytes memory) {
        return abi.encode(
            uint64(bytes8(cp[36:44])),
            bytes32(cp[44:76]),
            bytes32(cp[76:108]),
            cp[108:144],
            cp[144:180]
        );
    }

    /// @notice Registers a receipt key, a compressed P-256 key, so elections
    /// opening later may list it (docs/spec/election-definition.md, Receipt
    /// keys). Reverts unless the caller is the authority, the calldata is
    /// exactly one 33-byte `bytes` argument, the key is framed as compressed,
    /// and neither the key nor its twin (the other prefix with the same `x`)
    /// has ever been registered: a retired key never comes back, so a seized
    /// one can't be listed again by a hostile creator, and nor can its
    /// negation, whose secret key is the seized one's negated (T-69).
    function registerReceiptKey(bytes calldata key) external {
        (uint8 prefix, bytes32 x) = _receiptKey(key);
        AnchorStorage storage s = _anchorStorage();
        ReceiptKeyRecord storage r = s.receiptKeys[prefix][x];
        if (r.registeredAt != 0 || s.receiptKeys[prefix ^ 1][x].registeredAt != 0) {
            revert ReceiptKeyAlreadyRegistered(prefix, x);
        }
        r.registeredAt = uint64(block.timestamp);
        _log2(ReceiptKeyRegistered.selector, x, abi.encode(prefix));
    }

    /// @notice Retires a registered receipt key: no election opening at or
    /// after this block is judged by it. Reverts unless the caller is the
    /// authority, the calldata is framed as for `registerReceiptKey`, and the
    /// key is registered and not yet retired, so `retiredAt` is written once.
    function retireReceiptKey(bytes calldata key) external {
        (uint8 prefix, bytes32 x) = _receiptKey(key);
        ReceiptKeyRecord storage r = _anchorStorage().receiptKeys[prefix][x];
        if (r.registeredAt == 0 || r.retiredAt != 0) revert ReceiptKeyNotActive(prefix, x);
        r.retiredAt = uint64(block.timestamp);
        _log2(ReceiptKeyRetired.selector, x, abi.encode(prefix));
    }

    /// The caller and framing checks both receipt-key calls share. The key
    /// isn't checked on the curve, which would need a modular square root:
    /// a definition lists only canonical keys, so a registered non-key judges
    /// nothing (docs/spec/contracts.md, Known-weak; T-17).
    function _receiptKey(bytes calldata key) private view returns (uint8 prefix, bytes32 x) {
        if (msg.sender != authority) revert NotAuthority(msg.sender);
        CanonicalCalldata.requireOneBytesArgument(key);
        if (key.length != RECEIPT_KEY_LENGTH) revert MalformedReceiptKey();
        prefix = uint8(key[0]);
        if (prefix != 0x02 && prefix != 0x03) revert MalformedReceiptKey();
        x = bytes32(key[1:]);
    }

    function _isContract(address a) private view returns (bool) {
        bytes memory code = a.code;
        if (code.length == 0) return false;
        return !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
    }

    function _anchorStorage() private pure returns (AnchorStorage storage s) {
        assembly ("memory-safe") {
            s.slot := ANCHOR_SLOT
        }
    }
}
