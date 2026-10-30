// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotRelay} from "../src/BallotRelay.sol";
import {Board} from "../src/Board.sol";
import {BoardAnchor} from "../src/BoardAnchor.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {TrusteeRegistry} from "../src/TrusteeRegistry.sol";
import {ScriptVm} from "./ScriptVm.sol";

/// The staging deployment ([[P2-32]] part 1b; docs/spec/contracts.md,
/// Testnet deployments): `runL1()` deploys the board anchor and the L1 relay
/// on the L1, then `runL2()` deploys the trustee registry (pinning the launch
/// panel), the group registry, the election registry and the board on the
/// L2. Every pin comes from the `DEPLOY_CONFIG` JSON, never a literal, but
/// the epoch, which the L2 run reads from the deployed anchor; no key is read
/// here: forge broadcasts as the configured deployer, whose key the workflow
/// (or an Anvil account) supplies. Each contract's creation code is the
/// built artifact in `out/`: the script holds none of its own.
///
/// The two chains name each other: the relay pins the L2 board, and the
/// election registry pins the anchor and the relay. So every address is the
/// deployer's CREATE address at a configured nonce on each chain
/// ([[0028-board-contract-checks]], Deployment order). Each run refuses to
/// start unless the deployer's nonce is the configured one, and the L2 run,
/// which comes second, refuses to start unless the L1 anchor and relay are
/// where it will pin them, with the code the L1 record names, and the relay
/// pins the board's address.
///
/// While any of [[0044-testnet-deployments]]'s nine conditions is open, the
/// script deploys only the `staging` target, and only on Sepolia with Base
/// Sepolia, or on a local Anvil pair (L1 31337, L2 31338).
contract Deploy {
    ScriptVm private constant VM =
        ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BASE_SEPOLIA = 84532;
    uint256 private constant SEPOLIA = 11155111;
    uint256 private constant ANVIL_L1 = 31337;
    uint256 private constant ANVIL_L2 = 31338;

    error NotStaging();
    error BadCommit();
    error ChainRefused(uint256 l1ChainId, uint256 l2ChainId);
    error WrongChain(uint256 expected, uint256 actual);
    error WrongNonce(uint256 expected, uint256 actual);
    error OutOfRange(string key);
    error BadQuorum(uint256 expected, uint256 actual);
    error L1NotDeployed(string name, address at);
    error L1RelayBoard(address expected, address actual);
    error CreateFailed(string artifact);

    struct Config {
        string target;
        string commit;
        address deployer;
        uint256 l1ChainId;
        uint256 l2ChainId;
        uint256 l1Nonce;
        uint256 l2Nonce;
        // CREATE order: on L1 the anchor, then the relay; on L2 the trustee
        // registry, the group registry, the election registry, then the board.
        address l1Anchor;
        address l1Relay;
        address board;
    }

    function runL1() external {
        (string memory json, Config memory c) = _config();
        _checkChain(c, c.l1ChainId, c.l1Nonce);
        BoardAnchor.Clock memory clock = BoardAnchor.Clock({
            epoch: _u64(json, ".anchor.epoch"),
            period: _u64(json, ".anchor.period"),
            deadline: _u64(json, ".anchor.deadline")
        });
        address authority = VM.parseJsonAddress(json, ".anchor.authority");
        address portal = VM.parseJsonAddress(json, ".portal");

        VM.startBroadcast(c.deployer);
        address anchor = _create("BoardAnchor.sol:BoardAnchor", abi.encode(clock, authority));
        address relay = _create("BallotRelay.sol:BallotRelay", abi.encode(portal, c.board));
        VM.stopBroadcast();

        _write(
            c,
            c.l1ChainId,
            c.l1Nonce,
            string.concat(_entry("BoardAnchor", anchor), ",", _entry("BallotRelay", relay)),
            _l1Pins(c, clock, authority, portal)
        );
    }

    function _l1Pins(
        Config memory c,
        BoardAnchor.Clock memory clock,
        address authority,
        address portal
    ) private pure returns (string memory) {
        return string.concat(
            '"l2ChainId":',
            VM.toString(c.l2ChainId),
            ',"board":"',
            VM.toString(c.board),
            '","anchor":{"epoch":',
            VM.toString(uint256(clock.epoch)),
            ',"period":',
            VM.toString(uint256(clock.period)),
            ',"deadline":',
            VM.toString(uint256(clock.deadline)),
            ',"authority":"',
            VM.toString(authority),
            '"},"portal":"',
            VM.toString(portal),
            '"'
        );
    }

    function runL2() external {
        (string memory json, Config memory c) = _config();
        _checkChain(c, c.l2ChainId, c.l2Nonce);
        L2Pins memory p;
        p.epoch = _checkL1(c);
        p.panels = _panels(json);
        p.registrarThreshold = _u8(json, ".registrars.threshold");
        p.registrars = VM.parseJsonAddressArray(json, ".registrars.addresses");

        VM.startBroadcast(c.deployer);
        address trustees = _create("TrusteeRegistry.sol:TrusteeRegistry", abi.encode(p.panels));
        p.panelId = TrusteeRegistry(trustees).panelIds(0);
        address groups = _create(
            "GroupRegistry.sol:GroupRegistry",
            abi.encode(p.registrarThreshold, p.registrars, trustees, p.panelId)
        );
        address elections = _create(
            "ElectionRegistry.sol:ElectionRegistry",
            abi.encode(
                ElectionRegistry.Deployment({
                    board: c.board,
                    trusteeRegistry: trustees,
                    groupRegistry: groups,
                    l1ChainId: uint64(c.l1ChainId),
                    l1Anchor: c.l1Anchor,
                    l1Relay: c.l1Relay,
                    epoch: p.epoch
                })
            )
        );
        address board = _create("Board.sol:Board", abi.encode(elections, trustees, c.l1Relay));
        VM.stopBroadcast();

        _write(
            c,
            c.l2ChainId,
            c.l2Nonce,
            string.concat(
                _entry("TrusteeRegistry", trustees),
                ",",
                _entry("GroupRegistry", groups),
                ",",
                _entry("ElectionRegistry", elections),
                ",",
                _entry("Board", board),
                ",",
                _entry("BallotCheck", address(Board(board).ballotCheck()))
            ),
            _l2Pins(c, p)
        );
    }

    /// What the L2 contracts pin beyond the addresses fixed in `Config`.
    struct L2Pins {
        uint64 epoch;
        TrusteeRegistry.PanelInput[] panels;
        bytes32 panelId;
        uint8 registrarThreshold;
        address[] registrars;
    }

    function _l2Pins(Config memory c, L2Pins memory p) private pure returns (string memory) {
        return string.concat(
            '"l1ChainId":',
            VM.toString(c.l1ChainId),
            ',"l1Anchor":"',
            VM.toString(c.l1Anchor),
            '","l1Relay":"',
            VM.toString(c.l1Relay),
            '","epoch":',
            VM.toString(uint256(p.epoch)),
            ',"launchPanel":',
            _panelPins(p.panels[0], p.panelId),
            ',"registrars":{"threshold":',
            VM.toString(uint256(p.registrarThreshold)),
            ',"addresses":',
            _addresses(p.registrars),
            "}"
        );
    }

    function _config() private view returns (string memory json, Config memory c) {
        json = VM.envString("DEPLOY_CONFIG");
        c.target = VM.parseJsonString(json, ".target");
        if (keccak256(bytes(c.target)) != keccak256("staging")) revert NotStaging();
        c.commit = VM.parseJsonString(json, ".commit");
        _checkCommit(c.commit);
        c.deployer = VM.parseJsonAddress(json, ".deployer");
        c.l1ChainId = VM.parseJsonUint(json, ".l1ChainId");
        c.l2ChainId = VM.parseJsonUint(json, ".l2ChainId");
        // The testnet pair, or the local Anvil pair, and nothing else.
        bool testnet = c.l1ChainId == SEPOLIA && c.l2ChainId == BASE_SEPOLIA;
        bool local = c.l1ChainId == ANVIL_L1 && c.l2ChainId == ANVIL_L2;
        if (!testnet && !local) revert ChainRefused(c.l1ChainId, c.l2ChainId);
        c.l1Nonce = _u64(json, ".l1Nonce");
        c.l2Nonce = _u64(json, ".l2Nonce");
        c.l1Anchor = VM.computeCreateAddress(c.deployer, c.l1Nonce);
        c.l1Relay = VM.computeCreateAddress(c.deployer, c.l1Nonce + 1);
        c.board = VM.computeCreateAddress(c.deployer, c.l2Nonce + 3);
    }

    /// The commit is 40 lower-case hex digits, so it goes into the record
    /// as it is.
    function _checkCommit(string memory commit) private pure {
        bytes memory b = bytes(commit);
        if (b.length != 40) revert BadCommit();
        for (uint256 i; i < 40; i++) {
            bytes1 x = b[i];
            if (!((x >= "0" && x <= "9") || (x >= "a" && x <= "f"))) revert BadCommit();
        }
    }

    /// This run is on the chain it was meant for, from the configured
    /// deployer at the nonce every predicted address assumes.
    function _checkChain(Config memory c, uint256 chainId, uint256 nonce) private view {
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        uint256 actual = VM.getNonce(c.deployer);
        if (actual != nonce) revert WrongNonce(nonce, actual);
    }

    /// Before the L2 pins anything of the L1's: on the configured L1
    /// (`L1_RPC_URL`), the anchor and the relay are at their predicted
    /// addresses with the code the L1 record names, that record is this
    /// deployer's, and the relay pins this run's board. Returns the anchor's
    /// epoch, which the election registry pins.
    function _checkL1(Config memory c) private returns (uint64 epoch) {
        string memory record = VM.readFile(
            string.concat(VM.projectRoot(), "/deployments/", VM.toString(c.l1ChainId), ".json")
        );
        if (VM.parseJsonAddress(record, ".deployer") != c.deployer) {
            revert L1NotDeployed("deployer", c.deployer);
        }
        uint256 l2 = VM.activeFork();
        VM.selectFork(VM.createFork(VM.envString("L1_RPC_URL")));
        if (block.chainid != c.l1ChainId) revert WrongChain(c.l1ChainId, block.chainid);
        _deployedAs(record, "BoardAnchor", c.l1Anchor);
        _deployedAs(record, "BallotRelay", c.l1Relay);
        address relayBoard = BallotRelay(c.l1Relay).board();
        if (relayBoard != c.board) revert L1RelayBoard(c.board, relayBoard);
        epoch = BoardAnchor(c.l1Anchor).epoch();
        VM.selectFork(l2);
    }

    function _deployedAs(string memory record, string memory name, address at) private view {
        string memory key = string.concat(".contracts.", name);
        bytes32 codehash = VM.parseJsonBytes32(record, string.concat(key, ".codehash"));
        address recordedAt = VM.parseJsonAddress(record, string.concat(key, ".address"));
        if (recordedAt != at || at.code.length == 0 || at.codehash != codehash) {
            revert L1NotDeployed(name, at);
        }
    }

    /// The launch panel, the deployment's one pinned panel. `points` lists
    /// each seat's key as x then y, in seat order. Its quorum is
    /// `max(k, n − 1)` (docs/spec/contracts.md, Trustee registry, The quorum).
    function _panels(string memory json)
        private
        pure
        returns (TrusteeRegistry.PanelInput[] memory panels)
    {
        uint256[] memory flat = VM.parseJsonUintArray(json, ".panel.points");
        uint256[2][] memory points = new uint256[2][](flat.length / 2);
        for (uint256 i; i < points.length; i++) {
            points[i] = [flat[2 * i], flat[2 * i + 1]];
        }
        uint8 threshold = _u8(json, ".panel.threshold");
        uint8 quorum = _u8(json, ".panel.quorum");
        uint256 n = points.length;
        uint256 expected = n == 0 || threshold > n - 1 ? threshold : n - 1;
        if (quorum != expected) revert BadQuorum(expected, quorum);
        panels = new TrusteeRegistry.PanelInput[](1);
        panels[0] = TrusteeRegistry.PanelInput({
            threshold: threshold,
            quorum: quorum,
            kind: _u8(json, ".panel.kind"),
            keys: VM.parseJsonBytes(json, ".panel.keys"),
            points: points
        });
    }

    function _u8(string memory json, string memory key) private pure returns (uint8) {
        uint256 v = VM.parseJsonUint(json, key);
        if (v > type(uint8).max) revert OutOfRange(key);
        return uint8(v);
    }

    function _u64(string memory json, string memory key) private pure returns (uint64) {
        uint256 v = VM.parseJsonUint(json, key);
        if (v > type(uint64).max) revert OutOfRange(key);
        return uint64(v);
    }

    /// Deploys `artifact`'s creation code from the build's `out/` with the
    /// constructor arguments `args`. The script holds no contract's bytecode
    /// of its own, so what it deploys is exactly the built artifact.
    function _create(string memory artifact, bytes memory args) private returns (address at) {
        bytes memory code = bytes.concat(VM.getCode(artifact), args);
        assembly ("memory-safe") {
            at := create(0, add(code, 0x20), mload(code))
        }
        if (at == address(0)) revert CreateFailed(artifact);
    }

    function _entry(string memory name, address at) private view returns (string memory) {
        return string.concat(
            '"',
            name,
            '":{"address":"',
            VM.toString(at),
            '","codehash":"',
            VM.toString(at.codehash),
            '"}'
        );
    }

    function _panelPins(TrusteeRegistry.PanelInput memory p, bytes32 id)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"id":"',
            VM.toString(id),
            '","threshold":',
            VM.toString(uint256(p.threshold)),
            ',"size":',
            VM.toString(p.points.length),
            ',"quorum":',
            VM.toString(uint256(p.quorum)),
            ',"kind":',
            VM.toString(uint256(p.kind)),
            ',"keys":"',
            VM.toString(p.keys),
            '"}'
        );
    }

    function _addresses(address[] memory list) private pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < list.length; i++) {
            s = string.concat(s, i == 0 ? '"' : ',"', VM.toString(list[i]), '"');
        }
        s = string.concat(s, "]");
    }

    /// `deployments/<chain-id>.json`: the target, the chain, the deployer and
    /// its starting nonce, the commit deployed, each contract's address and
    /// runtime code hash, and `pins`, the configuration each contract took.
    /// Written only when broadcasting, never on a dry run, though still
    /// before forge sends: the workflow confirms it against the receipts.
    function _write(
        Config memory c,
        uint256 chainId,
        uint256 nonce,
        string memory contracts,
        string memory pins
    ) private {
        if (!VM.isContext(ScriptVm.ForgeContext.ScriptBroadcast)) return;
        VM.writeFile(
            string.concat(VM.projectRoot(), "/deployments/", VM.toString(chainId), ".json"),
            string.concat(
                '{"target":"',
                c.target,
                '","chainId":',
                VM.toString(chainId),
                ',"deployer":"',
                VM.toString(c.deployer),
                '","deployerNonce":',
                VM.toString(nonce),
                ',"commit":"',
                c.commit,
                '","contracts":{',
                contracts,
                '},"pins":{',
                pins,
                "}}\n"
            )
        );
    }
}
