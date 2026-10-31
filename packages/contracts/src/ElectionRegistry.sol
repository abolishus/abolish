// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {EventAccumulator} from "./EventAccumulator.sol";
import {IL1Block} from "./IL1Block.sol";
import {ITrusteeRegistry} from "./ITrusteeRegistry.sol";
import {TrusteeIdentityLib} from "./TrusteeRegistry.sol";

/// @title The election identifier (docs/spec/contracts.md, Election registry).
library ElectionIdLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/election-id` (0x16 = 22).
    bytes internal constant DS_ELECTION_ID = "\x16abolish/v1/election-id";

    /// `H(DS("abolish/v1/election-id", u64(chain_id) ‖ bytes[20](registry) ‖ u64(counter)))`.
    function electionId(uint64 chainId, address registry, uint64 counter)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(DS_ELECTION_ID, chainId, registry, counter));
    }
}

/// @title The election registry (docs/spec/contracts.md, Election registry).
/// @notice Assigns each election its identifier and records, write-once, the
/// hash of its one definition, so an election's rules can't change after
/// voting opens or differ between voters (T-34). It admits only a definition
/// that decodes strictly, is well formed, names this deployment's chains and
/// contracts, comes from the election's creator before it opens, has a δ
/// within the close rule's bounds (T-35, T-50) and sequencing bounds no
/// larger than its windows were sized for, has an electorate already public on
/// L2, and whose stub the trustee registry
/// recorded with its ceremony transcript (T-17, T-37, T-08, T-13), and whose
/// profile pins the versions this deployment's board and the verifier serve
/// for it (T-25, T-50, T-53). With each
/// definition it records the parameters the board's checks read, so the board
/// never takes them from a caller (ADR 0028, 1C; T-25), and with a definition
/// that has an author panel, the key set a quorum of its author seats
/// approved, in the same transaction, so no such election exists without one
/// (ADR 0035; T-25, T-54, T-37). There is no admin,
/// proxy, pause or upgrade path: every rule is fixed at deployment.
contract ElectionRegistry is EventAccumulator {
    /// The contracts and clocks of the deployment, fixed at construction. A
    /// definition must name exactly these.
    struct Deployment {
        address board;
        address trusteeRegistry;
        address groupRegistry;
        uint64 l1ChainId;
        address l1Anchor;
        address l1Relay;
        /// The anchoring clock's `epoch` of the anchor contract `l1Anchor`
        /// (P4-1): no election opens before it.
        uint64 epoch;
    }

    /// One question's method, option count and selection limits
    /// (docs/spec/contracts.md, Parameters).
    struct Question {
        /// 1, selection: the only method so far; a later one shapes the
        /// committed vote differently, so the board needs it.
        uint8 method;
        uint16 optionCount;
        uint16 minSelections;
        uint16 maxSelections;
    }

    /// What the board's checks read for a registered definition apart from
    /// its cells, a function of the definition alone (docs/spec/contracts.md,
    /// Parameters). All zero and empty for a definition hash never registered.
    struct Parameters {
        /// The version the definition's profile pins for the ballot (0x0002);
        /// never 0 once registered, since every pin is at least 1.
        uint8 ballotVersion;
        /// `k`, the default panel's threshold.
        uint8 threshold;
        /// `n`, the default panel's size.
        uint8 panelSize;
        /// `T`, every question's options together.
        uint16 optionCount;
        /// How many cells the definition's partition has.
        uint16 cellCount;
        /// `k_A`, the author panel's threshold; 0 with no author panel.
        uint8 authorThreshold;
        /// `n_A`, the author panel's size; 0 with no author panel.
        uint8 authorPanelSize;
        /// The poll's window and `δ` (`l1_inclusion_bound`), which the close
        /// rule's checks on the board read (docs/spec/close.md). With the
        /// fields above they fill one storage slot, so the board reads them
        /// with the rest for no extra slot.
        uint64 opensAt;
        uint64 closesAt;
        uint32 l1InclusionBound;
        /// In the order the ballot asks them.
        Question[] questions;
    }

    /// The ceremony a registered definition's default panel ran: the stub
    /// hash the trustee registry recorded its transcript under, and the
    /// panel. The board finds the election's registered key set by them
    /// (docs/spec/contracts.md, Parameters; ADR 0028, 2B).
    struct Ceremony {
        bytes32 stubHash;
        bytes32 panelId;
    }

    /// The author panel's key set recorded for a registered definition: its
    /// `key_set_hash`, which every approval signed, and its seats as a
    /// bitmask (bit `i` for seat `i`), as the trustee registry records the
    /// default panel's (docs/spec/contracts.md, Author panel registration).
    struct KeySet {
        bytes32 hash;
        uint256 seats;
    }

    /// A definition field that names something other than this deployment.
    enum DeploymentField {
        L2ChainId,
        L1ChainId,
        ElectionRegistry,
        Board,
        TrusteeRegistry,
        GroupRegistry,
        L1Anchor,
        L1Relay
    }

    /// The OP Stack's `L1Block` predeploy, at the same address on every OP
    /// Stack chain. A constant, never a deployment input, so no deployer can
    /// point the registry at a contract of its own; on a chain without it
    /// every creation and registration reverts.
    address public constant L1_BLOCK = 0x4200000000000000000000000000000000000015;

    /// The bounds on a definition's `l1_inclusion_bound` (δ), in seconds
    /// (docs/spec/parameters.md). The floor covers the batcher's normal
    /// latency, so a ballot cast at close is derivable from L1 by
    /// `closes_at + δ` unless the batcher is down (T-50, T-53); the ceiling
    /// keeps short the window in which the sequencer can rebuild unposted
    /// blocks before close without the close check seeing it (T-35, T-45).
    /// Constants of the bytecode, never deployment inputs, so verifier 1.2's
    /// binding fixes them and 2.6 compares δ with the release's pins.
    uint32 public constant MIN_INCLUSION_BOUND = 600;
    uint32 public constant MAX_INCLUSION_BOUND = 3600;

    /// The ceilings on the L2 sequencing bounds a definition assumes
    /// (docs/spec/parameters.md): `sequencing_window` in L1 blocks and
    /// `max_sequencer_drift` in seconds, Base's values (ADR 0004). Verifier 2.6
    /// requires the chain to have stayed within the definition's own values,
    /// so a larger one would let it accept a chain whose forced inclusion
    /// outruns the contract-event window (T-50, T-35), and absorb a governance
    /// raise of the drift past the 30 minutes ADR 0004 assumes instead of
    /// failing closed (T-35, T-71). No floor: a value below the chain's fails 2.6, the creator's own
    /// loss. Constants of the bytecode, like δ's bounds.
    uint64 public constant MAX_SEQUENCING_WINDOW = 3600;
    uint64 public constant MAX_SEQUENCER_DRIFT = 1800;

    /// The contract-event window `W_C` and its last term (docs/spec/parameters.md;
    /// docs/spec/tally.md, Tally window), in seconds: forced inclusion at
    /// `MAX_SEQUENCING_WINDOW` 12-second L1 blocks, an hour of missed slots, L1
    /// finality and `BOARDING_WINDOW`, the operator's time to board an event
    /// once derivable from finalized L1. Nothing here reads them: they fix the
    /// counted extent of every election this registry registers, so they are
    /// constants of the bytecode verifier 1.2 binds, beside the ceiling they
    /// are sized from (T-50, T-53, T-25).
    uint64 public constant CONTRACT_EVENT_WINDOW = 50_400;
    uint64 public constant BOARDING_WINDOW = 1800;

    /// @notice The key set a quorum of the author panel approved was recorded
    /// for the definition whose hash is `definitionHash`, right after its
    /// `DefinitionRegistered`. `registration` is the whole record, in the
    /// trustee registry's layout, so anyone checks its approvals against the
    /// definition's `author_keys` with the decoder of `CeremonyRegistered`.
    event AuthorPanelRegistered(
        bytes32 indexed definitionHash, bytes32 indexed authorPanelId, bytes registration
    );

    /// @notice An election was created: `counter` elections were created
    /// before it, in an L2 block whose L1 origin is the block numbered
    /// `l1OriginNumber`, with timestamp `l1OriginTimestamp` and hash
    /// `l1OriginHash`. The origin fixes the election's first segment `f`.
    event ElectionCreated(
        bytes32 indexed electionId,
        address indexed creator,
        uint64 counter,
        uint64 l1OriginNumber,
        uint64 l1OriginTimestamp,
        bytes32 l1OriginHash
    );

    /// @notice The election's one definition was registered, in an L2 block
    /// with the given L1 origin, which retired versions' cutoffs are compared
    /// with. `definition` is its full canonical encoding, so the board and any
    /// verifier rebuild it from the chain alone.
    event DefinitionRegistered(
        bytes32 indexed electionId,
        bytes32 indexed definitionHash,
        uint64 l1OriginNumber,
        uint64 l1OriginTimestamp,
        bytes32 l1OriginHash,
        bytes definition
    );

    error InvalidDeployment();
    error NonCanonicalCalldata();
    error DefinitionIllFormed(ElectionDefinitionLib.Rule rule);
    error ProfileNotServed(uint16 recordType, uint8 version);
    error WrongDeployment(DeploymentField field);
    error UnknownElection(bytes32 electionId);
    error NotCreator(bytes32 electionId, address caller);
    error AlreadyRegistered(bytes32 electionId);
    error OpensBeforeEpoch(uint64 opensAt, uint64 epoch);
    error AlreadyOpen(uint64 opensAt, uint256 timestamp);
    error InclusionBoundOutOfRange(uint32 bound);
    error SequencingWindowTooLarge(uint64 sequencingWindow);
    error SequencerDriftTooLarge(uint64 maxSequencerDrift);
    error RootNotInPast(uint8 tier, uint64 rootL2Block, uint256 blockNumber);
    error CeremonyNotRecorded(bytes32 stubHash, bytes32 transcriptHash);
    error CivicPanelNotIndependent(bytes32 panelId, uint8 kind);
    error AuthorRegistrationMissing();
    error AuthorPanelAbsent();
    /// 1 the panel, 2 the stub, 3 the transcript.
    error AuthorRegistrationMismatch(uint8 field);
    error MalformedRegistration();
    error BelowQuorum(uint256 count, uint8 quorum);
    /// Author panel registration's checks 6 to 9, raised by the trustee
    /// registry's `checkAuthorRegistration` and passed through unchanged;
    /// declared here so this contract's ABI decodes them.
    error KeySetTooSmall(uint256 seats, uint8 threshold);
    error KeySetSeatsOutOfOrder(uint8 index);
    error InvalidSigningKey(uint8 index);
    error DuplicateSigningKey(uint8 index);
    error SeatsOutOfOrder(uint8 index);
    error InvalidSignature(uint8 index);

    /// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(seats)`, the
    /// trustee registry's registration layout.
    uint256 private constant HEADER_LENGTH = 97;
    /// `u8(index) ‖ p256-sig`.
    uint256 private constant APPROVAL_LENGTH = 65;

    address public immutable board;
    address public immutable trusteeRegistry;
    address public immutable groupRegistry;
    uint64 public immutable l1ChainId;
    address public immutable l1Anchor;
    address public immutable l1Relay;
    uint64 public immutable epoch;

    /// How many elections this registry has created.
    uint64 public electionCount;
    mapping(bytes32 electionId => address) public creatorOf;
    mapping(bytes32 electionId => bytes32) public definitionHashOf;
    mapping(bytes32 definitionHash => Parameters) private _parameters;
    /// The partition's cells in order: each cell's tier, and the root its
    /// ballots prove membership against. Kept apart from `_parameters` so the
    /// board reads one cell, not every cell of a large partition.
    mapping(bytes32 definitionHash => uint8[]) private _cellTiers;
    mapping(bytes32 definitionHash => uint256[]) private _cellRoots;
    mapping(bytes32 definitionHash => Ceremony) private _ceremonies;
    mapping(bytes32 definitionHash => KeySet) private _authorKeySets;
    mapping(bytes32 definitionHash => mapping(uint256 index => uint256[2])) private
        _authorSigningKeys;

    constructor(Deployment memory dep) {
        // The same rule a definition's `chain` check applies, so a deployment
        // no well-formed definition could name is refused at once.
        // EventAccumulator's constructor already refuses a chain ID above u64.
        address[4] memory l2 = [address(this), dep.board, dep.trusteeRegistry, dep.groupRegistry];
        for (uint256 i; i < 4; i++) {
            if (l2[i] == address(0)) revert InvalidDeployment();
            for (uint256 j; j < i; j++) {
                if (l2[j] == l2[i]) revert InvalidDeployment();
            }
        }
        if (
            dep.l1ChainId == 0 || dep.l1ChainId == block.chainid || dep.l1Anchor == address(0)
                || dep.l1Relay == address(0) || dep.l1Anchor == dep.l1Relay
        ) revert InvalidDeployment();
        board = dep.board;
        trusteeRegistry = dep.trusteeRegistry;
        groupRegistry = dep.groupRegistry;
        l1ChainId = dep.l1ChainId;
        l1Anchor = dep.l1Anchor;
        l1Relay = dep.l1Relay;
        epoch = dep.epoch;
    }

    /// @notice The identifier of the election created as number `counter`
    /// (0-based) by this registry. The deployment refused any chain ID above u64.
    function electionIdAt(uint64 counter) public view returns (bytes32) {
        return ElectionIdLib.electionId(uint64(block.chainid), address(this), counter);
    }

    /// @notice The board's parameters for the registered definition whose hash
    /// is `definitionHash`, or all zero (`ballotVersion` 0) if none is.
    function parameters(bytes32 definitionHash) external view returns (Parameters memory) {
        return _parameters[definitionHash];
    }

    /// @notice Every cell's tier, in partition order: where a ballot that
    /// names its tier finds its cell. Empty if no definition has this hash.
    function cellTiers(bytes32 definitionHash) external view returns (uint8[] memory) {
        return _cellTiers[definitionHash];
    }

    /// @notice The stub hash and panel under which the trustee registry
    /// recorded the ceremony of the registered definition whose hash is
    /// `definitionHash`, or both zero if none is.
    function ceremony(bytes32 definitionHash)
        external
        view
        returns (bytes32 stubHash, bytes32 panelId)
    {
        Ceremony storage c = _ceremonies[definitionHash];
        return (c.stubHash, c.panelId);
    }

    /// @notice The author panel's key set recorded for the registered
    /// definition whose hash is `definitionHash`: its `key_set_hash` and its
    /// seats as a bitmask (bit `i` set for seat `i`). Both zero with no
    /// author panel or no definition with this hash. The board takes an
    /// author seat's place in the key set from here, never from a submitter.
    function authorKeySetOf(bytes32 definitionHash)
        external
        view
        returns (bytes32 keySetHash, uint256 seats)
    {
        KeySet storage k = _authorKeySets[definitionHash];
        return (k.hash, k.seats);
    }

    /// @notice Author seat `index`'s per-election signing key as `(x, y)`;
    /// zero for a seat outside the recorded key set.
    function authorSigningKeyOf(bytes32 definitionHash, uint256 index)
        external
        view
        returns (uint256 x, uint256 y)
    {
        uint256[2] storage q = _authorSigningKeys[definitionHash][index];
        return (q[0], q[1]);
    }

    /// @notice Cell `c`'s tier and root. Reverts unless `c` is below the
    /// definition's `cellCount`.
    function cell(bytes32 definitionHash, uint256 c)
        external
        view
        returns (uint8 tier, uint256 root)
    {
        return (_cellTiers[definitionHash][c], _cellRoots[definitionHash][c]);
    }

    /// @notice Creates an election and makes the caller its creator, the only
    /// account that can register its definition. Takes no arguments, so its
    /// event carries only the identifier, the caller, the counter and the
    /// block's L1 origin; what the surrounding transaction carries is T-17's
    /// residual (docs/spec/contracts.md, The shared event sequence).
    function createElection() external returns (bytes32 electionId) {
        if (msg.data.length != 4) revert NonCanonicalCalldata();
        uint64 counter = electionCount;
        (uint64 n, uint64 t, bytes32 hash) = _l1Origin();
        electionId = electionIdAt(counter);
        // Checked arithmetic: after 2^64 − 1 elections creation reverts
        // rather than reuse an identifier.
        electionCount = counter + 1;
        creatorOf[electionId] = msg.sender;
        _log3(
            ElectionCreated.selector,
            electionId,
            bytes32(uint256(uint160(msg.sender))),
            abi.encode(counter, n, t, hash)
        );
    }

    /// @notice Registers the definition of an election the caller created.
    /// Reverts unless every admission rule holds; see the contract's notice.
    /// A definition with an author panel goes through
    /// `registerDefinitionWithAuthorPanel`, so none is registered without
    /// its author key set (T-25, T-54).
    function registerDefinition(bytes calldata definition) external {
        CanonicalCalldata.requireOneBytesArgument(definition);
        (ElectionDefinitionLib.Definition memory def, bytes32 stub) = _admit(definition);
        if (def.authorThreshold != 0) revert AuthorRegistrationMissing();
        _register(definition, def, stub);
    }

    /// @notice Registers a definition with an author panel together with the
    /// key set a quorum of its author seats approved (docs/spec/contracts.md,
    /// Author panel registration). `authorRegistration` is the trustee
    /// registry's registration record: `panel_id ‖ stub_hash ‖
    /// ceremony_transcript_hash ‖ u8(seats) ‖ seats × (u8(index) ‖
    /// kem_key_hash ‖ x ‖ y) ‖ u8(count) ‖ count × (u8(index) ‖ p256-sig)`.
    /// Its header must be what the definition fixes (the author panel's
    /// identifier, `author_stub_hash`, `author_transcript_hash`), so it
    /// carries no bytes of its own choosing there (T-17); at least
    /// `max(k_A, n_A − 1)` distinct author seats must sign, each under its
    /// key in `author_keys`, over the key set's hash (T-14, T-37).
    function registerDefinitionWithAuthorPanel(
        bytes calldata definition,
        bytes calldata authorRegistration
    ) external {
        CanonicalCalldata.requireTwoBytesArguments(definition, authorRegistration);
        (ElectionDefinitionLib.Definition memory def, bytes32 stub) = _admit(definition);
        if (def.authorThreshold == 0) revert AuthorPanelAbsent();
        bytes32 authorPanel = _checkAuthorHeader(definition, def, authorRegistration);
        // Checks 6 to 9 run in the trustee registry, whose statement every
        // author seat signs and whose code already verifies P-256
        // signatures; this contract's own code would outgrow EIP-170 with
        // them. It returns the key set or reverts with the check's error.
        KeySet memory k;
        (k.hash, k.seats) = ITrusteeRegistry(trusteeRegistry)
            .checkAuthorRegistration(authorRegistration, _authorKeyPoints(def), def.authorThreshold);

        bytes32 h = _register(definition, def, stub);
        _authorKeySets[h] = k;
        uint256 seats = uint8(authorRegistration[96]);
        for (uint256 i; i < seats; i++) {
            uint256 at = HEADER_LENGTH + i * TrusteeIdentityLib.SEAT_LENGTH;
            _authorSigningKeys[h][uint8(authorRegistration[at])] = [
                uint256(bytes32(authorRegistration[at + 33:at + 65])),
                uint256(bytes32(authorRegistration[at + 65:at + 97]))
            ];
        }
        _log3(AuthorPanelRegistered.selector, h, authorPanel, abi.encode(authorRegistration));
    }

    /// Rules 2 to 9 of Registration on `definition`, reverting on the first
    /// that fails; returns the decoded definition and its stub hash.
    function _admit(bytes calldata definition)
        private
        view
        returns (ElectionDefinitionLib.Definition memory def, bytes32 stub)
    {
        def = ElectionDefinitionLib.decode(definition);
        ElectionDefinitionLib.Rule r = ElectionDefinitionLib.rule(def);
        if (r != ElectionDefinitionLib.Rule.None) revert DefinitionIllFormed(r);
        _requireThisDeployment(def);

        // One definition per election, from its creator only, write-once
        // (T-34, T-24). Only the creator, so no one who learns a pending
        // definition's fields (a trustee, a relay) can block it (T-25).
        bytes32 id = def.electionId;
        address creator = creatorOf[id];
        if (creator == address(0)) revert UnknownElection(id);
        if (msg.sender != creator) revert NotCreator(id, msg.sender);
        if (definitionHashOf[id] != bytes32(0)) revert AlreadyRegistered(id);

        // Registered before voting opens, and not before the anchoring clock
        // starts (verifier 2.1, 2.6).
        if (def.opensAt < epoch) revert OpensBeforeEpoch(def.opensAt, epoch);
        if (block.timestamp >= def.opensAt) revert AlreadyOpen(def.opensAt, block.timestamp);
        // δ within the close rule's bounds (docs/spec/close.md; T-35, T-50).
        if (
            def.l1InclusionBound < MIN_INCLUSION_BOUND || def.l1InclusionBound > MAX_INCLUSION_BOUND
        ) {
            revert InclusionBoundOutOfRange(def.l1InclusionBound);
        }
        // The sequencing bounds it assumes within what the windows were sized
        // for (docs/spec/parameters.md; T-50, T-35, T-71).
        if (def.sequencingWindow > MAX_SEQUENCING_WINDOW) {
            revert SequencingWindowTooLarge(def.sequencingWindow);
        }
        if (def.maxSequencerDrift > MAX_SEQUENCER_DRIFT) {
            revert SequencerDriftTooLarge(def.maxSequencerDrift);
        }
        _requireElectorateInPast(def);

        // The ceremony was run for exactly this definition: the check compares
        // hashes the panel signed, never who sent the transaction (T-37, T-71).
        stub = ElectionDefinitionLib.stubHash(definition, def.transcriptOffset);
        // The panel's identifier, threshold and size are passed too, so the
        // trustee registry checks the approving quorum belongs to the panel
        // the definition names, at its threshold (T-14, T-37).
        bool recorded = ITrusteeRegistry(trusteeRegistry)
            .ceremonyRecorded(
                stub, def.ceremonyTranscriptHash, def.panelId, def.threshold, def.panelSize
            );
        if (!recorded) revert CeremonyNotRecorded(stub, def.ceremonyTranscriptHash);
        // Only an independent panel holds a poll on the civic record, classes
        // 2 and 3; `pollClass` is 0 below definition version 6, which has
        // none (rule 8; T-14).
        if (def.pollClass >= 2) {
            uint8 kind = ITrusteeRegistry(trusteeRegistry).kindOf(def.panelId);
            if (kind != 1) revert CivicPanelNotIndependent(def.panelId, kind);
        }
        _requireServedProfile(def);
    }

    /// Stores `definition`'s hash for its election, its ceremony and its
    /// parameters, and emits `DefinitionRegistered`, once every check passed.
    function _register(
        bytes calldata definition,
        ElectionDefinitionLib.Definition memory def,
        bytes32 stub
    ) private returns (bytes32 h) {
        h = ElectionDefinitionLib.hash(definition);
        definitionHashOf[def.electionId] = h;
        _ceremonies[h] = Ceremony(stub, def.panelId);
        _recordParameters(h, def);
        _log3(DefinitionRegistered.selector, def.electionId, h, _registrationData(definition));
    }

    /// Author panel registration's checks 1 to 5: the record's length, its
    /// header against the definition, and the quorum. Returns the author
    /// panel's identifier.
    function _checkAuthorHeader(
        bytes calldata definition,
        ElectionDefinitionLib.Definition memory def,
        bytes calldata registration
    ) private pure returns (bytes32 authorPanel) {
        if (registration.length < HEADER_LENGTH) {
            revert MalformedRegistration();
        }
        uint256 approvalsAt =
            HEADER_LENGTH + uint8(registration[96]) * TrusteeIdentityLib.SEAT_LENGTH + 1;
        if (registration.length < approvalsAt) revert MalformedRegistration();
        uint256 count = uint8(registration[approvalsAt - 1]);
        if (registration.length != approvalsAt + count * APPROVAL_LENGTH) {
            revert MalformedRegistration();
        }
        // Nothing in the first 96 bytes the definition doesn't fix (T-17), and
        // no approval for another panel, stub or transcript counts (T-37).
        authorPanel = ElectionDefinitionLib.authorPanelId(def);
        if (bytes32(registration[0:32]) != authorPanel) revert AuthorRegistrationMismatch(1);
        if (
            bytes32(registration[32:64])
                != ElectionDefinitionLib.authorStubHash(
                    definition, def.transcriptOffset, def.authorTranscriptOffset
                )
        ) revert AuthorRegistrationMismatch(2);
        if (bytes32(registration[64:96]) != def.authorTranscriptHash) {
            revert AuthorRegistrationMismatch(3);
        }
        uint8 quorum = _authorQuorum(def);
        if (count < quorum) revert BelowQuorum(count, quorum);
    }

    /// `q_A = max(k_A, n_A − 1)`, the author panel's approval quorum
    /// (docs/spec/ceremony.md, Author panel, Approval): a formula of the
    /// bytecode, never an input. `author-panel` held, so `1 ≤ k_A ≤ n_A ≤ 16`.
    function _authorQuorum(ElectionDefinitionLib.Definition memory def)
        private
        pure
        returns (uint8)
    {
        uint8 n = uint8(def.authorKeys.length);
        return def.authorThreshold > n - 1 ? def.authorThreshold : n - 1;
    }

    /// Each of `author_keys` as the point `(x, y)` it encodes, in seat order.
    function _authorKeyPoints(ElectionDefinitionLib.Definition memory def)
        private
        view
        returns (uint256[2][] memory points)
    {
        points = new uint256[2][](def.authorKeys.length);
        for (uint256 i; i < points.length; i++) {
            (points[i][0], points[i][1]) = ElectionDefinitionLib.point(def.authorKeys[i]);
        }
    }

    /// `DefinitionRegistered`'s ABI data: the block's L1 origin, then the
    /// definition. A function of its own only to keep `registerDefinition`
    /// within the stack.
    function _registrationData(bytes calldata definition) private view returns (bytes memory) {
        (uint64 n, uint64 t, bytes32 hash) = _l1Origin();
        return abi.encode(n, t, hash, definition);
    }

    /// The electorate is in the past: every root names an L2 block before
    /// this one, so its additions are public before anyone votes (T-08, T-13).
    function _requireElectorateInPast(ElectionDefinitionLib.Definition memory def) private view {
        for (uint256 i; i < def.electorate.length; i++) {
            ElectionDefinitionLib.TierGroup memory g = def.electorate[i];
            if (g.rootL2Block >= block.number) {
                revert RootNotInPast(g.tier, g.rootL2Block, block.number);
            }
        }
        for (uint256 i; i < def.tiers.length; i++) {
            ElectionDefinitionLib.TierElectorate memory t = def.tiers[i];
            if (t.rootL2Block >= block.number) {
                revert RootNotInPast(t.tier, t.rootL2Block, block.number);
            }
        }
        // A rolling tier's opening state is its tree at `root_l2_block`
        // (docs/spec/membership.md, Opening state), as public before the
        // poll as a fixed tier's root (T-08, T-13).
        for (uint256 i; i < def.rolling.length; i++) {
            ElectionDefinitionLib.RollingTier memory t = def.rolling[i];
            if (t.rootL2Block >= block.number) {
                revert RootNotInPast(t.tier, t.rootL2Block, block.number);
            }
        }
    }

    /// Records what the board reads for definition `h`. The definition hash
    /// names one election and is set once, so these are written once too.
    function _recordParameters(bytes32 h, ElectionDefinitionLib.Definition memory def) private {
        Parameters storage p = _parameters[h];
        // `profile-types` fixed the pins as 0x0001 to 0x0009 in order, so the
        // ballot's is the second.
        p.ballotVersion = def.pinVersions[1];
        p.threshold = def.threshold;
        p.panelSize = def.panelSize;
        // Version 6 only; `author-panel` and the decoder's 16-key limit keep
        // the size within a uint8.
        p.authorThreshold = def.authorThreshold;
        p.authorPanelSize = uint8(def.authorKeys.length);
        p.opensAt = def.opensAt;
        p.closesAt = def.closesAt;
        p.l1InclusionBound = def.l1InclusionBound;
        if (def.version < 5) {
            // One question over all the options, by selection (plurality is
            // the limits (0, 1)).
            p.optionCount = def.optionCount;
            p.questions.push(Question(1, def.optionCount, def.minSelections, def.maxSelections));
        } else {
            // `option-count` held, so the total is at most MAX_OPTIONS.
            uint16 total;
            for (uint256 i; i < def.questions.length; i++) {
                ElectionDefinitionLib.Question memory q = def.questions[i];
                total += q.optionCount;
                p.questions
                    .push(Question(q.method, q.optionCount, q.minSelections, q.maxSelections));
            }
            p.optionCount = total;
        }
        // The partition (docs/spec/election-definition.md, Tally partition):
        // version 1's cells are its tiers, one per electorate entry in order;
        // later versions' are every tier's `cells`, tier by tier. `cells`
        // held, so there are at most 256.
        for (uint256 i; i < def.electorate.length; i++) {
            _cellTiers[h].push(def.electorate[i].tier);
            _cellRoots[h].push(def.electorate[i].root);
        }
        for (uint256 i; i < def.tiers.length; i++) {
            ElectionDefinitionLib.TierElectorate memory t = def.tiers[i];
            for (uint256 j; j < t.cells.length; j++) {
                _cellTiers[h].push(t.tier);
                _cellRoots[h].push(t.cells[j].root);
            }
        }
        // Under electorate mode 2, one cell per rolling tier with the root 0:
        // no rolling poll's root is registered, so the rolling calls take it
        // from the submitter, and every other ballot path refuses ballot
        // version 5 before reading a root (T-25, T-53).
        for (uint256 i; i < def.rolling.length; i++) {
            _cellTiers[h].push(def.rolling[i].tier);
            _cellRoots[h].push(0);
        }
        p.cellCount = uint16(_cellTiers[h].length);
    }

    /// The current block's L1 origin (number, timestamp, hash), as the events
    /// carry it, read from the predeploy alone in the emitting call. The verifier checks it names one
    /// finalized L1 block within `max_sequencer_drift` of the event's L2
    /// timestamp, so neither the sequencer nor a rewritten predeploy can name
    /// an origin outside that bound (T-71, T-69, T-34).
    function _l1Origin() private view returns (uint64 number, uint64 timestamp, bytes32 hash) {
        IL1Block l1 = IL1Block(L1_BLOCK);
        return (l1.number(), l1.timestamp(), l1.hash());
    }

    /// The profile pins exactly the versions this deployment serves for the
    /// definition's version (docs/spec/contracts.md, Election registry,
    /// Registration, rule 9), checked by record type in ascending order: the
    /// ballot version the board checks for it (1 for definition version 1, 2
    /// for 3 and 4, 3 for 5, 4 for 6 and for 7 under a fixed electorate, 5
    /// for 7 under a rolling one), the spoiled-ballot opening version that
    /// opens that ballot's cores, tally-opening version 3 for a definition
    /// with an author panel and any version but 2 and 3 for one without,
    /// board-entry version 5, the only one that allows the close statement
    /// without an author panel's approvals, for a sealed definition without an
    /// author panel, version 7, which adds them, for a sealed one with one,
    /// and none for a live poll (its running openings need version 6, which
    /// verifier 2.3 fails here: T-16, T-17), contract-event version 13, whose
    /// tables name every
    /// event of the board (the close rule's, the batches', the obligation
    /// root's, the availability records' and both rolling calls'), of the
    /// group registry (its Tier 1 additions and its self-paid groups and
    /// additions), the trustee registry's kind-carrying `PanelPinned` and
    /// this registry's version-7 `DefinitionRegistered`, which versions 1 to
    /// 12 don't, for every definition version, and the display-text version the
    /// definition's layout needs. So no registered election leaves a voter's
    /// direct submission, a seat's statement or a challenge without a path
    /// the verifier reads (T-25, T-50, T-42, T-53). `profile-types` fixed the
    /// pins as 0x0001 to 0x0009 in order.
    function _requireServedProfile(ElectionDefinitionLib.Definition memory def) private pure {
        uint8 v = def.version;
        uint8[] memory pins = def.pinVersions;
        // Version 7 pins ballot version 4 under electorate mode 1 and 5 under
        // mode 2, whose ballots name their step (T-53).
        uint8 ballot = v == 1
            ? 1
            : v == 3 || v == 4 ? 2 : v == 5 ? 3 : v == 6 || def.electorateMode == 1 ? 4 : 5;
        if (pins[1] != ballot) revert ProfileNotServed(0x0002, pins[1]);
        // Opening version 2 opens the cores of ballot versions 2 and 3, and
        // version 3 those of ballot versions 4 and 5.
        if (pins[2] != (ballot == 1 ? 1 : ballot >= 4 ? 3 : 2)) {
            revert ProfileNotServed(0x0003, pins[2]);
        }
        // Below definition version 6 `authorThreshold` is 0. Tally-opening
        // version 3 sums an author panel's half beside the default half, so
        // verifier 2.3 fails an author panel beside any other version and any
        // other definition beside it; version 2 fixes a live poll's running
        // opening, which this registry doesn't serve. A version no release
        // reads yet is left to 2.3 without an author panel, which reports it
        // unverifiable (T-16, T-17).
        bool author = def.authorThreshold != 0;
        if (author ? pins[5] != 3 : pins[5] == 2 || pins[5] == 3) {
            revert ProfileNotServed(0x0006, pins[5]);
        }
        // Below definition version 6 `resultsMode` is 0, and at version 6 a
        // live poll's is above `SEALED`.
        if (pins[6] != (author ? 7 : 5) || def.resultsMode > ElectionDefinitionLib.SEALED) {
            revert ProfileNotServed(0x0007, pins[6]);
        }
        // Version 13 for every definition: a version-7 registration in this
        // registry's shared sequence fails versions 1 to 12 at 4.4, for
        // every election it creates (T-53).
        if (pins[7] != 13) revert ProfileNotServed(0x0008, pins[7]);
        // Display-text version 2 carries the questions of definition versions
        // 5 to 7.
        if (pins[8] != (v >= 5 ? 2 : 1)) revert ProfileNotServed(0x0009, pins[8]);
    }

    function _requireThisDeployment(ElectionDefinitionLib.Definition memory def) private view {
        if (def.l2ChainId != block.chainid) revert WrongDeployment(DeploymentField.L2ChainId);
        if (def.l1ChainId != l1ChainId) revert WrongDeployment(DeploymentField.L1ChainId);
        if (def.electionRegistry != address(this)) {
            revert WrongDeployment(DeploymentField.ElectionRegistry);
        }
        if (def.board != board) revert WrongDeployment(DeploymentField.Board);
        if (def.trusteeRegistry != trusteeRegistry) {
            revert WrongDeployment(DeploymentField.TrusteeRegistry);
        }
        if (def.groupRegistry != groupRegistry) {
            revert WrongDeployment(DeploymentField.GroupRegistry);
        }
        if (def.l1Anchor != l1Anchor) revert WrongDeployment(DeploymentField.L1Anchor);
        if (def.l1Relay != l1Relay) revert WrongDeployment(DeploymentField.L1Relay);
    }
}
