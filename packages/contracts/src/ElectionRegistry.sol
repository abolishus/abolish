// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {EventAccumulator} from "./EventAccumulator.sol";
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
/// contracts, comes from the election's creator before it opens, has an
/// electorate already public on L2, and whose stub the trustee registry
/// recorded with its ceremony transcript (T-17, T-37, T-08, T-13). There is no
/// admin, proxy, pause or upgrade path: every rule is fixed at deployment.
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

    /// @notice An election was created: `counter` elections were created before it.
    event ElectionCreated(bytes32 indexed electionId, address indexed creator, uint64 counter);

    /// @notice The election's one definition was registered. `definition` is
    /// its full canonical encoding, so the board and any verifier rebuild it
    /// from the chain alone.
    event DefinitionRegistered(
        bytes32 indexed electionId, bytes32 indexed definitionHash, bytes definition
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

    /// @notice Creates an election and makes the caller its creator, the only
    /// account that can register its definition. Takes no arguments, so its
    /// event carries only the identifier, the caller and the counter; what
    /// the surrounding transaction carries is T-17's residual
    /// (docs/spec/contracts.md, The shared event sequence).
    function createElection() external returns (bytes32 electionId) {
        if (msg.data.length != 4) revert NonCanonicalCalldata();
        uint64 counter = electionCount;
        electionId = electionIdAt(counter);
        // Checked arithmetic: after 2^64 − 1 elections creation reverts
        // rather than reuse an identifier.
        electionCount = counter + 1;
        creatorOf[electionId] = msg.sender;
        _log3(
            ElectionCreated.selector,
            electionId,
            bytes32(uint256(uint160(msg.sender))),
            abi.encode(counter)
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
        // The electorate is in the past: every root names an L2 block before
        // this one, so its additions are public before anyone votes (T-08, T-13).
        for (uint256 i; i < def.electorate.length; i++) {
            ElectionDefinitionLib.TierGroup memory g = def.electorate[i];
            if (g.rootL2Block >= block.number) {
                revert RootNotInPast(g.tier, g.rootL2Block, block.number);
            }
        }

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
        _log3(DefinitionRegistered.selector, id, h, abi.encode(definition));
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
