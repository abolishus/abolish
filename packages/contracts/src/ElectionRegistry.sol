// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {EventAccumulator} from "./EventAccumulator.sol";
import {IL1Block} from "./IL1Block.sol";
import {ITrusteeRegistry} from "./ITrusteeRegistry.sol";

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
/// recorded with its ceremony transcript (T-17, T-37, T-08, T-13). With each
/// definition it records the parameters the board's checks read, so the board
/// never takes them from a caller (ADR 0028, 1C; T-25). There is no admin,
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
    /// outruns the contract-event window (T-50, T-35), or whose sequencer can
    /// lead L1 by more than the 30 minutes `ROOT_WINDOW` was sized for (T-35,
    /// T-71). No floor: a value below the chain's fails 2.6, the creator's own
    /// loss. Constants of the bytecode, like δ's bounds.
    uint64 public constant MAX_SEQUENCING_WINDOW = 3600;
    uint64 public constant MAX_SEQUENCER_DRIFT = 1800;

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
    function registerDefinition(bytes calldata definition) external {
        CanonicalCalldata.requireOneBytesArgument(definition);
        ElectionDefinitionLib.Definition memory def = ElectionDefinitionLib.decode(definition);
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
        bytes32 stub = ElectionDefinitionLib.stubHash(definition, def.transcriptOffset);
        // The panel's identifier, threshold and size are passed too, so the
        // trustee registry checks the approving quorum belongs to the panel
        // the definition names, at its threshold (T-14, T-37).
        bool recorded = ITrusteeRegistry(trusteeRegistry)
            .ceremonyRecorded(
                stub, def.ceremonyTranscriptHash, def.panelId, def.threshold, def.panelSize
            );
        if (!recorded) revert CeremonyNotRecorded(stub, def.ceremonyTranscriptHash);

        bytes32 h = ElectionDefinitionLib.hash(definition);
        definitionHashOf[id] = h;
        _ceremonies[h] = Ceremony(stub, def.panelId);
        _recordParameters(h, def);
        _log3(DefinitionRegistered.selector, id, h, _registrationData(definition));
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
