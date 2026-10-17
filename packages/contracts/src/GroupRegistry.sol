// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator, EventAccumulatorLib} from "./EventAccumulator.sol";
import {MembershipProofLib} from "./MembershipProof.sol";

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
    /// The wei a self-paid addition must send, exactly: `2 · 10¹⁴` (0.0002
    /// ETH). Nothing moves ether out of the registry, so every fee is locked
    /// there for good, paying no one, us included. It prices the floods gas
    /// alone doesn't, since every self-paid addition is a counted leaf every
    /// listing election boards and its clients read (T-52, T-53); a change
    /// is a new registry.
    uint256 internal constant SELF_PAID_FEE = 2e14;

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

/// @title A Tier 1 vouch's parameters, scopes and messages (docs/spec/vouching.md).
/// @notice The registry computes every scope and message a vouch's proofs are
/// checked under from the chain, its own address, the Tier 1 group, the
/// vouchee's commitment and the vouch's own fields, never from the
/// submitter (contracts.md, Group registry, Tier 1 additions, rule 7). Each
/// hash is SHA-256 over `DS(tag, m) = u8(len(tag)) ‖ tag ‖ m`
/// (docs/spec/domain-separation.md), and `F` is Semaphore's field mapping.
library VouchLib {
    /// `VOUCH_K`: the vouches an addition carries.
    uint256 internal constant K = 3;
    /// `VOUCH_SLOTS`: the slots of each Tier 2 secret, `0` to `L − 1`.
    uint256 internal constant SLOTS = 12;
    /// `VOUCH_ROOT_INTERVAL`: a vouch's `root_block` is a multiple of it.
    uint256 internal constant ROOT_INTERVAL = 1800;
    /// `VOUCH_ROOT_WINDOW` (`W`): an addition lands at most this many blocks
    /// after its vouches' `root_block`.
    uint256 internal constant ROOT_WINDOW = 302_400;
    /// `u64(group_id) ‖ field(C_V) ‖ u8(k)`.
    uint256 internal constant HEADER = 41;
    /// One vouch: `u64 ‖ u64 ‖ field ‖ u16 ‖ field ‖ field ‖ proof ‖ proof`.
    uint256 internal constant VOUCH_LENGTH = 626;
    /// The whole record at `k = 3`: 1,919 bytes.
    uint256 internal constant RECORD_LENGTH = HEADER + VOUCH_LENGTH * K;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/vouch` (0x10 = 16).
    bytes internal constant DS_VOUCH = "\x10abolish/v1/vouch";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/vouch-slot` (0x15 = 21).
    bytes internal constant DS_SLOT = "\x15abolish/v1/vouch-slot";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/vouch-message` (0x18 = 24).
    bytes internal constant DS_MESSAGE = "\x18abolish/v1/vouch-message";

    /// `binding ‖ encode(C_V)`, with the binding
    /// `u64(chain_id) ‖ bytes[20](registry) ‖ u64(group_id)`: the 68 bytes
    /// the vouchee scope hashes and both messages carry.
    function vouchee(uint64 chainId, address registry, uint64 groupId, uint256 commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(chainId, registry, groupId, commitment);
    }

    /// `S_V = H(DS("abolish/v1/vouch", binding ‖ encode(C_V)))`.
    function voucheeScopeBytes(bytes memory voucheeBytes) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(DS_VOUCH, voucheeBytes));
    }

    /// `S_j = H(DS("abolish/v1/vouch-slot", u64(chain_id) ‖ bytes[20](registry) ‖ u16(j)))`.
    function slotScopeBytes(uint64 chainId, address registry, uint16 slot)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(DS_SLOT, chainId, registry, slot));
    }

    /// `M = H(DS("abolish/v1/vouch-message", u8(role) ‖ binding ‖ encode(C_V) ‖
    /// u64(tier2_group_id) ‖ u64(root_block) ‖ encode(other_nullifier)))`,
    /// role 0 for the vouchee proof (naming `ν_S`) and 1 for the slot proof
    /// (naming `ν_V`).
    function messageBytes(
        uint8 role,
        bytes memory voucheeBytes,
        uint64 tier2GroupId,
        uint64 rootBlock,
        uint256 otherNullifier
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_MESSAGE, role, voucheeBytes, tier2GroupId, rootBlock, otherNullifier
            )
        );
    }
}

/// @title The group registry (docs/spec/contracts.md, Group registry).
/// @notice Holds the deployment's Semaphore groups: fixes each group's tier
/// when it creates the group, and logs every addition and removal with the
/// registrars' signatures, so a verifier rebuilds each tier tree from the
/// chain alone (verifier 2.4). It keeps no Merkle tree. Anyone may submit a
/// record: a Tier 0 record counts only through at least `threshold` distinct
/// registrars' signatures, never through who sent it (T-71, T-62, T-06), and
/// lands at the position it was signed for, at most once, so no relay can
/// replay, reorder or inflate a group (T-06, T-13). A self-paid Tier 0 group
/// takes one commitment per call from anyone who pays `SELF_PAID_FEE`, with
/// no signature, so joining Tier 0 never rests on the registrars or our
/// servers (T-25); it never takes a signed record, and no signed group takes
/// a self-paid one, so neither path can stall the other. A Tier 1 addition is
/// authorised by `VOUCH_K` anonymous vouches of Tier 2 members, which the
/// registry checks only as spam control: the verifier decides what counts
/// (docs/spec/vouching.md; T-52). It takes no election
/// identifier, definition or nullifier, so nothing here links a member to a
/// poll (T-12). There is no admin, proxy, pause or upgrade path, and the
/// registrars can't change after deployment.
contract GroupRegistry is EventAccumulator {
    /// A group's record: `exists` tells group 0's tier 0 from no group.
    /// `memberCount` counts Tier 0 additions only, signed or self-paid;
    /// `createdBlock` is the L2 block of the group's creation, which a
    /// vouch's Tier 2 group is checked against; `selfPaid` is the group's
    /// kind, fixed at creation (docs/spec/contracts.md, Group registry, Groups).
    struct Group {
        uint64 memberCount;
        uint8 tier;
        bool exists;
        uint64 createdBlock;
        bool selfPaid;
    }

    /// A vouch's fields before its proofs (docs/spec/vouching.md, The vouch).
    struct Vouch {
        uint64 tier2GroupId;
        uint64 rootBlock;
        uint256 root;
        uint16 slot;
        uint256 voucheeNullifier;
        uint256 slotNullifier;
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

    /// @notice A Tier 1 addition passed the registry's checks. `record` is
    /// the whole addition, vouches included; no topic names the group, which
    /// a verifier reads from the record, so the two can't disagree. Whether
    /// it counts is the verifier's (docs/spec/vouching.md, Counting across
    /// the deployment).
    event Tier1MemberAdded(bytes record);

    /// @notice Group `groupId` was created as a self-paid group of tier 0.
    event SelfPaidGroupCreated(uint64 indexed groupId);

    /// @notice A commitment was added to self-paid group `groupId` as member
    /// `index`, which the registry assigned: the record names no position.
    /// `record` is the whole self-paid record.
    event SelfPaidMemberAdded(uint64 indexed groupId, uint64 indexed index, bytes record);

    error InvalidRegistrars(RegistrarError reason);
    error UnsupportedTier(uint8 tier);
    error TooManyGroups();
    error MalformedRecord();
    error UnknownGroup(uint64 groupId);
    error WrongTier(uint64 groupId, uint8 tier);
    /// A signed record naming a self-paid group, or a self-paid one naming a
    /// signed group.
    error WrongKind(uint64 groupId);
    error WrongFee(uint256 value);
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
    error VouchSlot(uint256 vouch);
    error VouchRoot(uint256 vouch);
    error VouchNullifier(uint256 vouch);
    error RootGrid(uint256 vouch);
    error RootWindow(uint256 vouch);
    error Tier2Group(uint256 vouch);
    error DuplicateVoucher(uint256 vouch);
    error DuplicateSlot(uint256 vouch);
    /// `slotProof` false for the vouchee proof, true for the slot proof.
    error VouchProof(uint256 vouch, bool slotProof);

    /// `u64(group_id) ‖ u64(first_index) ‖ u16(count)`.
    uint256 private constant ADD_HEADER = 18;
    /// `u64(group_id) ‖ u64(size) ‖ u16(count)`.
    uint256 private constant REMOVE_HEADER = 18;
    /// `u8(seat) ‖ bytes[32](r) ‖ bytes[32](s) ‖ u8(v)`.
    uint256 private constant APPROVAL_LENGTH = 66;
    /// `u64(group_id) ‖ field<bn254>(commitment)`.
    uint256 private constant SELF_PAID_LENGTH = 40;

    /// The wei a self-paid addition must send (`GroupRegistryLib.SELF_PAID_FEE`).
    uint256 public constant SELF_PAID_FEE = GroupRegistryLib.SELF_PAID_FEE;

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
    /// were added to it by `addMembers` (removals don't lower the count).
    function groupOf(uint64 groupId)
        external
        view
        returns (uint8 tier, bool exists, uint64 memberCount)
    {
        Group memory g = _groups[groupId];
        return (g.tier, g.exists, g.memberCount);
    }

    /// @notice Whether a group is self-paid (false for a signed group or no group).
    function isSelfPaid(uint64 groupId) external view returns (bool) {
        return _groups[groupId].selfPaid;
    }

    /// @notice The L2 block that created a group (0 for no group).
    function groupCreatedBlock(uint64 groupId) external view returns (uint64) {
        return _groups[groupId].createdBlock;
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
    /// a group has no members until the registrars add some, or, for Tier 1,
    /// until vouched-for people are added. Tier 2 is refused until its
    /// addition path exists (P3-4).
    function createGroup(uint8 tier) external returns (uint64 groupId) {
        // The selector and one word: no bytes the call doesn't define (T-17).
        if (msg.data.length != 36) revert CanonicalCalldata.NonCanonicalCalldata();
        if (tier > 1) revert UnsupportedTier(tier);
        groupId = _nextGroup(tier, false);
        _log3(GroupCreated.selector, bytes32(uint256(groupId)), bytes32(uint256(tier)), "");
    }

    /// @notice Creates the next group, from the same counter, as a
    /// self-paid group of tier 0, fixed for good. Anyone may: it has no
    /// members until someone pays to add one.
    function createSelfPaidGroup() external returns (uint64 groupId) {
        // The selector alone (T-17).
        if (msg.data.length != 4) revert CanonicalCalldata.NonCanonicalCalldata();
        groupId = _nextGroup(0, true);
        _log2(SelfPaidGroupCreated.selector, bytes32(uint256(groupId)), "");
    }

    /// The next group of `tier` and kind, `group_id` the counter's value.
    function _nextGroup(uint8 tier, bool selfPaid) private returns (uint64 groupId) {
        uint256 next = groupCount;
        // group_id stays in the u64 range: after group 2⁶⁴ − 1, creation reverts.
        if (next > type(uint64).max) revert TooManyGroups();
        groupId = uint64(next);
        groupCount = next + 1;
        // The accumulator's step after it reverts on a block number past u64.
        _groups[groupId] = Group({
            memberCount: 0,
            tier: tier,
            exists: true,
            createdBlock: uint64(block.number),
            selfPaid: selfPaid
        });
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

    /// @notice Adds one commitment to a self-paid group, with exactly
    /// `SELF_PAID_FEE`. The record is `u64(group_id) ‖ field<bn254>(commitment)`,
    /// checked in the order of docs/spec/contracts.md (Group registry,
    /// Self-paid additions). It names no position: the registry assigns the
    /// next index, so no other addition, landed first, can make it revert
    /// (T-25). The sender is never read (T-71). There is no duplicate check:
    /// repeats are the verifier's first-occurrence rule's, under which a
    /// self-paid copy never displaces an earlier registration (T-16).
    function addSelfPaidMember(bytes calldata record) external payable {
        CanonicalCalldata.requireOneBytesArgument(record);
        if (record.length != SELF_PAID_LENGTH) revert MalformedRecord();
        if (msg.value != SELF_PAID_FEE) revert WrongFee(msg.value);
        uint64 groupId = uint64(bytes8(record[0:8]));
        Group storage g = _groups[groupId];
        Group memory group = g;
        if (!group.exists) revert UnknownGroup(groupId);
        if (!group.selfPaid) revert WrongKind(groupId);
        uint64 index = group.memberCount;
        if (index >= GroupRegistryLib.MAX_MEMBERS) revert GroupFull(index, 1);
        if (GroupRegistryLib.forbidden(uint256(bytes32(record[8:40])))) {
            revert ForbiddenCommitment(0);
        }
        // index < 2³², so this fits a u64.
        g.memberCount = index + 1;
        _log3(
            SelfPaidMemberAdded.selector,
            bytes32(uint256(groupId)),
            bytes32(uint256(index)),
            abi.encode(record)
        );
    }

    /// @notice Adds one vouched-for commitment to a Tier 1 group. The record
    /// is `u64(group_id) ‖ field(C_V) ‖ u8(k) ‖ vouch × k`
    /// (docs/spec/vouching.md, Tier 1 addition record), checked in the order
    /// of docs/spec/contracts.md (Group registry, Tier 1 additions). Its
    /// authorisation is the vouches alone; the sender is never read (T-71).
    /// Every check depends only on the record, this block and the group
    /// table, so no other addition, logged or pending, can make it revert,
    /// and the verifier's `root-mismatch`, `slot-spent` and `member` are left
    /// to the verifier (T-25, T-53). Nothing is stored for the addition.
    function addTier1Member(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        // Before any other field is read, so a padded or short record costs
        // nothing to refuse (T-52).
        if (record.length != VouchLib.RECORD_LENGTH || uint8(record[40]) != VouchLib.K) {
            revert MalformedRecord();
        }
        uint64 groupId = uint64(bytes8(record[0:8]));
        Group memory group = _groups[groupId];
        if (!group.exists) revert UnknownGroup(groupId);
        if (group.tier != 1) revert WrongTier(groupId, group.tier);
        uint256 commitment = uint256(bytes32(record[8:40]));
        if (GroupRegistryLib.forbidden(commitment)) revert ForbiddenCommitment(0);
        for (uint256 i; i < VouchLib.K; i++) {
            _checkVouchFields(record, i);
        }
        // Pairwise-distinct vouchers and slots; the position is the first
        // vouch that repeats an earlier one's nullifier.
        for (uint256 i = 1; i < VouchLib.K; i++) {
            for (uint256 j; j < i; j++) {
                if (_word(record, i, 50) == _word(record, j, 50)) revert DuplicateVoucher(i);
            }
        }
        for (uint256 i = 1; i < VouchLib.K; i++) {
            for (uint256 j; j < i; j++) {
                if (_word(record, i, 82) == _word(record, j, 82)) revert DuplicateSlot(i);
            }
        }
        // The binding's chain is the current one, never truncated.
        uint64 chainId = EventAccumulatorLib.chainId64(block.chainid);
        bytes memory voucheeBytes = VouchLib.vouchee(chainId, address(this), groupId, commitment);
        uint256 voucheeScope = MembershipProofLib.field(VouchLib.voucheeScopeBytes(voucheeBytes));
        for (uint256 i; i < VouchLib.K; i++) {
            _checkVouchProofs(record, i, chainId, voucheeBytes, voucheeScope);
        }
        _log1(Tier1MemberAdded.selector, abi.encode(record));
    }

    /// Rule 5 for vouch `i`: its slot, root and nullifiers in range, its
    /// root block on the grid with this block inside its window, and its
    /// Tier 2 group created here by the root block.
    function _checkVouchFields(bytes calldata record, uint256 i) private view {
        uint256 at = VouchLib.HEADER + VouchLib.VOUCH_LENGTH * i;
        if (uint16(bytes2(record[at + 48:at + 50])) >= VouchLib.SLOTS) revert VouchSlot(i);
        uint256 root = uint256(bytes32(record[at + 16:at + 48]));
        // Semaphore proves membership of root 0 for any secret.
        if (root == 0 || root >= GroupRegistryLib.R) revert VouchRoot(i);
        if (
            uint256(bytes32(record[at + 50:at + 82])) >= GroupRegistryLib.R
                || uint256(bytes32(record[at + 82:at + 114])) >= GroupRegistryLib.R
        ) revert VouchNullifier(i);
        uint64 rootBlock = uint64(bytes8(record[at + 8:at + 16]));
        if (rootBlock % VouchLib.ROOT_INTERVAL != 0) revert RootGrid(i);
        // A vouch held past its window can't be logged (T-22, T-52).
        if (block.number < rootBlock || block.number > uint256(rootBlock) + VouchLib.ROOT_WINDOW) {
            revert RootWindow(i);
        }
        Group memory tier2 = _groups[uint64(bytes8(record[at:at + 8]))];
        if (!tier2.exists || tier2.tier != 2 || tier2.createdBlock > rootBlock) {
            revert Tier2Group(i);
        }
    }

    /// Rule 7 for vouch `i`: its vouchee proof, then its slot proof, under
    /// signals whose scopes and messages are computed here (T-31, T-32).
    /// Internal rather than private only so a test harness can check
    /// vectors whose root blocks are off the grid.
    function _checkVouchProofs(
        bytes calldata record,
        uint256 i,
        uint64 chainId,
        bytes memory voucheeBytes,
        uint256 voucheeScope
    ) internal view {
        uint256 at = VouchLib.HEADER + VouchLib.VOUCH_LENGTH * i;
        Vouch memory v = _vouch(record, at);
        // `[ρ, ν_V, m̂_V, ŝ_V]`, the message naming the slot nullifier.
        MembershipProofLib.Signals memory s = MembershipProofLib.Signals({
            root: v.root,
            nullifier: v.voucheeNullifier,
            message: _message(v, 0, voucheeBytes, v.slotNullifier),
            scope: voucheeScope
        });
        if (!MembershipProofLib.verify(record[at + 114:at + 370], s)) revert VouchProof(i, false);
        // `[ρ, ν_S, m̂_S, ŝ_j]`, the message naming the vouchee nullifier.
        s.nullifier = v.slotNullifier;
        s.message = _message(v, 1, voucheeBytes, v.voucheeNullifier);
        s.scope = MembershipProofLib.field(VouchLib.slotScopeBytes(chainId, address(this), v.slot));
        if (!MembershipProofLib.verify(record[at + 370:at + 626], s)) revert VouchProof(i, true);
    }

    /// The fixed fields of the vouch at `at`, before its two proofs.
    function _vouch(bytes calldata record, uint256 at) private pure returns (Vouch memory) {
        return Vouch({
            tier2GroupId: uint64(bytes8(record[at:at + 8])),
            rootBlock: uint64(bytes8(record[at + 8:at + 16])),
            root: uint256(bytes32(record[at + 16:at + 48])),
            slot: uint16(bytes2(record[at + 48:at + 50])),
            voucheeNullifier: uint256(bytes32(record[at + 50:at + 82])),
            slotNullifier: uint256(bytes32(record[at + 82:at + 114]))
        });
    }

    /// `F(M)` for the proof of `role` in vouch `v`, naming `other`.
    function _message(Vouch memory v, uint8 role, bytes memory voucheeBytes, uint256 other)
        private
        pure
        returns (uint256)
    {
        return MembershipProofLib.field(
            VouchLib.messageBytes(role, voucheeBytes, v.tier2GroupId, v.rootBlock, other)
        );
    }

    /// The 32-byte word at `offset` within vouch `i`.
    function _word(bytes calldata record, uint256 i, uint256 offset)
        private
        pure
        returns (bytes32)
    {
        uint256 at = VouchLib.HEADER + VouchLib.VOUCH_LENGTH * i + offset;
        return bytes32(record[at:at + 32]);
    }

    /// The group was created here as a signed group, with tier 0, the only
    /// groups the registrars' records add to or remove from. A self-paid
    /// addition would move the member count every signed batch in flight
    /// binds, so the two kinds never share a group.
    function _requireTierZeroGroup(uint64 groupId, Group memory group) private pure {
        if (!group.exists) revert UnknownGroup(groupId);
        if (group.selfPaid) revert WrongKind(groupId);
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
