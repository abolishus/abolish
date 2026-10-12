// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator} from "./EventAccumulator.sol";

/// @title The group registry's EIP-712 messages and constants
/// (docs/spec/contracts.md, Group registry, Signed messages).
/// @notice EIP-712 is an external format (docs/spec/domain-separation.md),
/// used so a registrar's signer, and anyone auditing it, sees what is signed
/// in the standard's readable form. Signatures are recovered only through OpenZeppelin's audited
/// `ECDSA` (vendored, see the package README); no curve arithmetic is
/// implemented here.
library GroupRegistryLib {
    /// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// keccak256("Abolish group registry")
    bytes32 internal constant NAME_HASH = keccak256("Abolish group registry");
    /// keccak256("1")
    bytes32 internal constant VERSION_HASH = keccak256("1");
    /// keccak256("AddMembers(uint64 groupId,uint8 tier,uint64 firstIndex,uint256[] commitments)")
    bytes32 internal constant ADD_MEMBERS_TYPEHASH =
        keccak256("AddMembers(uint64 groupId,uint8 tier,uint64 firstIndex,uint256[] commitments)");
    /// keccak256("RemoveMembers(uint64 groupId,uint8 tier,uint64 size,uint64[] indices)")
    bytes32 internal constant REMOVE_MEMBERS_TYPEHASH =
        keccak256("RemoveMembers(uint64 groupId,uint8 tier,uint64 size,uint64[] indices)");

    /// secp256k1's group order `N`.
    uint256 internal constant N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    /// `(N − 1) / 2`, the largest `s` the low-s rule of EIP-2 allows.
    uint256 internal constant HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    /// BN254's scalar field modulus `r`: a `field<bn254>` is below it.
    uint256 internal constant R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    /// `Poseidon2(0, 1)`, circomlib's two-input Poseidon, the tier tree's hash
    /// (docs/spec/membership.md, Commitments and removals).
    uint256 internal constant POSEIDON2_0_1 =
        0x1bd20834f5de9830c643778a2e88a3a1363c8b9ac083d36d75bf87c49953e65e;

    /// The largest registrar set (`MAX_REGISTRARS`).
    uint256 internal constant MAX_REGISTRARS = 16;
    /// The most commitments or indices in one record (`MAX_BATCH`).
    uint256 internal constant MAX_BATCH = 256;
    /// The leaves of a tier tree, `2³²` (docs/spec/membership.md, Tier tree).
    uint256 internal constant MAX_MEMBERS = 1 << 32;

    /// `hashStruct(domain)` for the registry at `registry` on chain `chainId`.
    function domainSeparator(uint256 chainId, address registry) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, registry));
    }

    /// `hashStruct(AddMembers)`, given `keccak256` of the commitments' words.
    function addMembersHash(uint64 groupId, uint8 tier, uint64 firstIndex, bytes32 commitmentsHash)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(abi.encode(ADD_MEMBERS_TYPEHASH, groupId, tier, firstIndex, commitmentsHash));
    }

    /// `hashStruct(RemoveMembers)`, given `keccak256` of the indices' words.
    function removeMembersHash(uint64 groupId, uint8 tier, uint64 size, bytes32 indicesHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(REMOVE_MEMBERS_TYPEHASH, groupId, tier, size, indicesHash));
    }

    /// `keccak256(0x19 ‖ 0x01 ‖ hashStruct(domain) ‖ hashStruct(message))`.
    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    /// Whether `c` may not be a member: not a canonical `field<bn254>`, or
    /// `0`, `1` or `Poseidon2(0, 1)` (docs/spec/membership.md, Commitments
    /// and removals).
    function forbidden(uint256 c) internal pure returns (bool) {
        return c >= R || c <= 1 || c == POSEIDON2_0_1;
    }
}

/// @title The group registry (docs/spec/contracts.md, Group registry).
/// @notice Holds the deployment's Semaphore groups: fixes each group's tier
/// when it creates the group, and logs every addition and removal with the
/// registrars' signatures, so a verifier rebuilds each tier tree from the
/// chain alone (verifier 2.4). It keeps no Merkle tree. Anyone may submit a
/// record: it counts only through at least `threshold` distinct registrars'
/// signatures, never through who sent it (T-71, T-62, T-06). Each addition
/// lands at the position it was signed for, at most once, so no relay can
/// replay, reorder or inflate a group (T-06, T-13). It takes no election
/// identifier, definition or nullifier, so nothing here links a member to a
/// poll (T-12). There is no admin, proxy, pause or upgrade path, and the
/// registrars can't change after deployment.
contract GroupRegistry is EventAccumulator {
    /// A group's record: `exists` tells group 0's tier 0 from no group.
    struct Group {
        uint64 memberCount;
        uint8 tier;
        bool exists;
    }

    /// Why a deployment's registrars were refused, in the order the checks run.
    enum RegistrarError {
        Size,
        Threshold,
        Order
    }

    /// @notice The registrars and threshold this deployment pins, its first event.
    event RegistrarsPinned(uint8 threshold, address[] registrars);

    /// @notice Group `groupId` was created with `tier`, fixed for good.
    event GroupCreated(uint64 indexed groupId, uint8 indexed tier);

    /// @notice Commitments were added to `groupId` from `firstIndex` on.
    /// `record` is the whole addition record, signatures included, so anyone
    /// can recheck it against the pinned registrars.
    event MembersAdded(uint64 indexed groupId, uint64 indexed firstIndex, bytes record);

    /// @notice Members of `groupId` were removed; `record` is the whole
    /// removal record, signatures included.
    event MembersRemoved(uint64 indexed groupId, bytes record);

    error InvalidRegistrars(RegistrarError reason);
    error UnsupportedTier(uint8 tier);
    error TooManyGroups();
    error MalformedRecord();
    error UnknownGroup(uint64 groupId);
    error WrongTier(uint64 groupId, uint8 tier);
    error BatchSize(uint256 count);
    error WrongPosition(uint64 firstIndex, uint64 memberCount);
    error GroupFull(uint64 firstIndex, uint256 count);
    error ForbiddenCommitment(uint256 position);
    error IndicesOutOfOrder(uint256 position);
    error SizeBeyondCount(uint64 size, uint64 memberCount);
    error IndexBeyondSize(uint64 index);
    error AlreadyRemoved(uint64 index);
    error TooFewApprovals(uint256 approvals, uint8 threshold);
    error InvalidSeat(uint8 seat);
    error InvalidSignature(uint8 seat);

    /// `u64(group_id) ‖ u64(first_index) ‖ u16(count)`.
    uint256 private constant ADD_HEADER = 18;
    /// `u64(group_id) ‖ u64(size) ‖ u16(count)`.
    uint256 private constant REMOVE_HEADER = 18;
    /// `u8(seat) ‖ bytes[32](r) ‖ bytes[32](s) ‖ u8(v)`.
    uint256 private constant APPROVAL_LENGTH = 66;

    // The three immutables are the ones verifier 1.2 masks and compares with
    // its release's values; the registrars are in storage and checked
    // through `RegistrarsPinned` (docs/spec/contracts.md, Group registry).

    /// How many registrar signatures a record needs, `2 ≤ threshold ≤ n`.
    uint8 public immutable threshold;
    /// The domain separator at deployment, and the chain it was computed for.
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// The registrars, in ascending order: seat `i` is `_registrars[i − 1]`.
    address[] private _registrars;
    /// How many groups this registry created; the next group's `group_id`.
    /// Wider than `u64` so that group `2⁶⁴ − 1` can exist.
    uint256 public groupCount;
    mapping(uint64 groupId => Group) private _groups;
    /// One bit per removed index, 256 indices to a word.
    mapping(uint64 groupId => mapping(uint256 word => uint256 bits)) private _removed;

    /// Pins `registrars` (ascending, non-zero, 2 to 16 of them) and
    /// `threshold_` (2 to their number). EventAccumulator's constructor has
    /// already refused a chain ID above `u64`.
    constructor(uint8 threshold_, address[] memory registrars_) {
        uint256 n = registrars_.length;
        if (n < 2 || n > GroupRegistryLib.MAX_REGISTRARS) {
            revert InvalidRegistrars(RegistrarError.Size);
        }
        // No single key adds or removes members (T-62).
        if (threshold_ < 2 || threshold_ > n) revert InvalidRegistrars(RegistrarError.Threshold);
        // Strictly ascending from above zero: none is zero, none repeats, and
        // the set has one encoding.
        address previous;
        for (uint256 i; i < n; i++) {
            if (registrars_[i] <= previous) revert InvalidRegistrars(RegistrarError.Order);
            previous = registrars_[i];
        }
        threshold = threshold_;
        _registrars = registrars_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = GroupRegistryLib.domainSeparator(block.chainid, address(this));
        _log1(RegistrarsPinned.selector, abi.encode(threshold_, registrars_));
    }

    /// @notice The registrars, in seat order (seat 1 first).
    function registrars() external view returns (address[] memory) {
        return _registrars;
    }

    /// @notice A group's tier, whether it exists, and how many commitments
    /// were added to it (removals don't lower the count).
    function groupOf(uint64 groupId)
        external
        view
        returns (uint8 tier, bool exists, uint64 memberCount)
    {
        Group memory g = _groups[groupId];
        return (g.tier, g.exists, g.memberCount);
    }

    /// @notice Whether member `index` of `groupId` was removed.
    function isRemoved(uint64 groupId, uint64 index) external view returns (bool) {
        return _removed[groupId][index >> 8] & (1 << (index & 0xff)) != 0;
    }

    /// @notice The EIP-712 domain separator, for `block.chainid` and this registry.
    function domainSeparator() public view returns (bytes32) {
        // The cached value unless the chain ID changed since deployment (a
        // fork): the domain is always the current chain's.
        if (block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return GroupRegistryLib.domainSeparator(block.chainid, address(this));
    }

    /// @notice Creates the next group with `tier`, fixed for good. Anyone may:
    /// a group has no members until the registrars add some. Only Tier 0 is
    /// accepted until the Tier 1 and Tier 2 addition paths exist.
    function createGroup(uint8 tier) external returns (uint64 groupId) {
        // The selector and one word: no bytes the call doesn't define (T-17).
        if (msg.data.length != 36) revert CanonicalCalldata.NonCanonicalCalldata();
        if (tier != 0) revert UnsupportedTier(tier);
        uint256 next = groupCount;
        // group_id stays in the u64 range: after group 2⁶⁴ − 1, creation reverts.
        if (next > type(uint64).max) revert TooManyGroups();
        groupId = uint64(next);
        groupCount = next + 1;
        _groups[groupId] = Group({memberCount: 0, tier: tier, exists: true});
        _log3(GroupCreated.selector, bytes32(uint256(groupId)), bytes32(uint256(tier)), "");
    }

    /// @notice Adds commitments to a group. The record is
    /// `u64(group_id) ‖ u64(first_index) ‖ u16(count) ‖ field<bn254> × count ‖
    /// u8(approvals) ‖ approvals × (u8(seat) ‖ r ‖ s ‖ u8(v))`, checked in the
    /// order of docs/spec/contracts.md (Group registry, Additions).
    function addMembers(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        uint256 len = record.length;
        if (len < ADD_HEADER + 1) revert MalformedRecord();
        uint256 count = uint16(bytes2(record[16:18]));
        uint256 commitmentsEnd = ADD_HEADER + 32 * count;
        if (len < commitmentsEnd + 1) revert MalformedRecord();
        uint256 approvals = uint8(record[commitmentsEnd]);
        if (len != commitmentsEnd + 1 + APPROVAL_LENGTH * approvals) revert MalformedRecord();

        uint64 groupId = uint64(bytes8(record[0:8]));
        Group storage g = _groups[groupId];
        Group memory group = g;
        _requireTierZeroGroup(groupId, group);
        if (count == 0 || count > GroupRegistryLib.MAX_BATCH) revert BatchSize(count);
        // The position was signed: each batch lands at one place, at most
        // once, so no replay or reordering changes the group (T-06, T-13).
        uint64 firstIndex = uint64(bytes8(record[8:16]));
        if (firstIndex != group.memberCount) revert WrongPosition(firstIndex, group.memberCount);
        if (firstIndex + count > GroupRegistryLib.MAX_MEMBERS) revert GroupFull(firstIndex, count);
        for (uint256 i; i < count; i++) {
            uint256 at = ADD_HEADER + 32 * i;
            if (GroupRegistryLib.forbidden(uint256(bytes32(record[at:at + 32])))) {
                revert ForbiddenCommitment(i);
            }
        }

        // The commitments are already 32-byte big-endian words: their
        // concatenation is EIP-712's encoding of the uint256[].
        bytes32 structHash = GroupRegistryLib.addMembersHash(
            groupId, group.tier, firstIndex, keccak256(record[ADD_HEADER:commitmentsEnd])
        );
        _requireApprovals(record, commitmentsEnd, approvals, structHash);

        // count ≤ 256 and firstIndex + count ≤ 2³², so this fits a u64.
        g.memberCount = uint64(firstIndex + count);
        _log3(
            MembersAdded.selector,
            bytes32(uint256(groupId)),
            bytes32(uint256(firstIndex)),
            abi.encode(record)
        );
    }

    /// @notice Removes members of a group. The record is
    /// `u64(group_id) ‖ u64(size) ‖ u16(count) ‖ u64(index) × count ‖
    /// u8(approvals) ‖ approvals × (u8(seat) ‖ r ‖ s ‖ u8(v))`, checked in the
    /// order of docs/spec/contracts.md (Group registry, Removals). `size` is
    /// the member count the registrars signed at: each index must be below
    /// it, so a removal can only name members that existed when it was
    /// signed, and not be removed yet, so a replay reverts.
    function removeMembers(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        uint256 len = record.length;
        if (len < REMOVE_HEADER + 1) revert MalformedRecord();
        uint256 count = uint16(bytes2(record[16:18]));
        uint256 indicesEnd = REMOVE_HEADER + 8 * count;
        if (len < indicesEnd + 1) revert MalformedRecord();
        uint256 approvals = uint8(record[indicesEnd]);
        if (len != indicesEnd + 1 + APPROVAL_LENGTH * approvals) revert MalformedRecord();

        uint64 groupId = uint64(bytes8(record[0:8]));
        Group memory group = _groups[groupId];
        _requireTierZeroGroup(groupId, group);
        if (count == 0 || count > GroupRegistryLib.MAX_BATCH) revert BatchSize(count);
        // A signed size the group hasn't reached yet would let a removal
        // signed early wait for a member to land at an index it names.
        uint64 size = uint64(bytes8(record[8:16]));
        if (size > group.memberCount) revert SizeBeyondCount(size, group.memberCount);

        // Each index widened to a 32-byte word, EIP-712's encoding of the
        // uint64[], hashed below.
        uint256[] memory words = new uint256[](count);
        mapping(uint256 => uint256) storage removed = _removed[groupId];
        for (uint256 i; i < count; i++) {
            uint256 at = REMOVE_HEADER + 8 * i;
            uint64 index = uint64(bytes8(record[at:at + 8]));
            // Strictly increasing, so no index is named twice.
            if (i > 0 && index <= words[i - 1]) revert IndicesOutOfOrder(i);
            // Below size, so below the member count too.
            if (index >= size) revert IndexBeyondSize(index);
            if (removed[index >> 8] & (1 << (index & 0xff)) != 0) revert AlreadyRemoved(index);
            words[i] = index;
        }

        bytes32 structHash = GroupRegistryLib.removeMembersHash(
            groupId, group.tier, size, keccak256(abi.encodePacked(words))
        );
        _requireApprovals(record, indicesEnd, approvals, structHash);

        for (uint256 i; i < count; i++) {
            uint256 index = words[i];
            removed[index >> 8] |= 1 << (index & 0xff);
        }
        _log2(MembersRemoved.selector, bytes32(uint256(groupId)), abi.encode(record));
    }

    /// The group was created here, with tier 0, the only tier with an
    /// addition path in this version.
    function _requireTierZeroGroup(uint64 groupId, Group memory group) private pure {
        if (!group.exists) revert UnknownGroup(groupId);
        if (group.tier != 0) revert WrongTier(groupId, group.tier);
    }

    /// Rules 7 and 8 of Additions: at least `threshold` approvals, from
    /// strictly increasing seats, each a low-s signature by its seat's
    /// registrar on the digest of `structHash`. Every approval must verify,
    /// including any beyond the threshold, so no record carries a signature
    /// the registrars didn't make. `at` is the offset of the approvals byte.
    function _requireApprovals(
        bytes calldata record,
        uint256 at,
        uint256 approvals,
        bytes32 structHash
    ) private view {
        if (approvals < threshold) revert TooFewApprovals(approvals, threshold);
        bytes32 digest = GroupRegistryLib.digest(domainSeparator(), structHash);
        uint256 n = _registrars.length;
        uint8 previous;
        for (uint256 i; i < approvals; i++) {
            uint256 o = at + 1 + APPROVAL_LENGTH * i;
            uint8 seat = uint8(record[o]);
            // Each registrar counts once: one key signing twice is one seat.
            if (seat <= previous || seat > n) revert InvalidSeat(seat);
            previous = seat;
            bytes32 r = bytes32(record[o + 1:o + 33]);
            bytes32 s = bytes32(record[o + 33:o + 65]);
            uint8 v = uint8(record[o + 65]);
            // One encoding per signature (EIP-2, T-31), checked here as well
            // as in ECDSA.tryRecover, as defence in depth against a library change.
            if (
                (v != 27 && v != 28) || uint256(r) == 0 || uint256(r) >= GroupRegistryLib.N
                    || uint256(s) == 0 || uint256(s) > GroupRegistryLib.HALF_N
            ) revert InvalidSignature(seat);
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
            if (err != ECDSA.RecoverError.NoError || signer != _registrars[seat - 1]) {
                revert InvalidSignature(seat);
            }
        }
    }
}
