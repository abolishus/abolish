// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../../src/BallotCheck.sol";
import {Board} from "../../src/Board.sol";
import {CloseStatementLib} from "../../src/CloseStatement.sol";
import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../../src/EventAccumulator.sol";
import {ElectionsStub, TrusteesStub} from "../utils/BoardFixture.sol";
import {DefinitionHarness} from "../utils/DefinitionHarness.sol";
import {TrusteeFixture} from "../utils/TrusteeFixture.sol";
import {TestBase, Vm} from "../utils/Vm.sol";

/// What the handler submits against: the board, the relay's alias, the
/// election and its window, its two ballots, a statement to re-sign, and the
/// signing secrets of seats 1, 2, 3 and 5.
struct CloseRuleSetup {
    Board board;
    address relayAlias;
    bytes32 definitionHash;
    uint64 opensAt;
    uint64 closesAt;
    bytes[2] ballots;
    bytes statement;
    uint256[4] secrets;
}

/// Submits ballot.json's two ballots the board admits on the ordinary and
/// relayed paths, at block times and stamps around the window's edges, from
/// the relay's alias and from others, and close statements of
/// close-statement.json's four seats with any of three claims against any
/// of two L1 blocks, each signed by its seat. Keeps a shadow of what the
/// board should do (the records it remembers, each seat's claims) and of the
/// accumulator, and the first outcome that broke a rule.
contract CloseRuleHandler is TestBase {
    uint256 internal constant SIGNATURE_AT = 116;

    Board public immutable board;
    address internal immutable relayAlias;
    bytes32 internal immutable definitionHash;
    uint64 internal immutable opensAt;
    uint64 internal immutable closesAt;
    bytes[2] internal ballots;
    bytes internal statement;
    uint8[4] internal seats = [1, 2, 3, 5];
    mapping(uint8 seat => uint256) internal secrets;

    /// Records the board should remember, by keccak-256 of their bytes.
    mapping(bytes32 => bool) public remembered;
    /// Each seat's accepted claims, in order.
    mapping(uint8 seat => bytes32[]) internal claims;
    bytes32 public shadowAccumulator;
    uint64 public shadowCount;
    uint256 public relayedAccepted;
    uint256 public statementsAccepted;
    string public failure;

    constructor(CloseRuleSetup memory c) {
        board = c.board;
        relayAlias = c.relayAlias;
        definitionHash = c.definitionHash;
        (opensAt, closesAt) = (c.opensAt, c.closesAt);
        ballots = c.ballots;
        statement = c.statement;
        for (uint256 i; i < 4; i++) {
            secrets[seats[i]] = c.secrets[i];
        }
        shadowAccumulator = EventAccumulatorLib.genesis(uint64(block.chainid), address(c.board));
    }

    function seatClaims(uint8 seat) external view returns (bytes32[] memory) {
        return claims[seat];
    }

    // --- actions ---------------------------------------------------------------

    /// An ordinary ballot at a block time around the window: accepted with
    /// an event inside it unless remembered, a no-op if remembered, refused
    /// outside it otherwise.
    function submitBallot(uint8 which, uint8 timeSeed) external {
        bytes memory r = ballots[which % 2];
        vm.warp(_time(timeSeed));
        bool inside = block.timestamp >= opensAt && block.timestamp <= closesAt;
        bytes32 key = keccak256(r);
        (bool ok, Vm.Log[] memory logs) =
            _call(address(this), abi.encodeCall(Board.submitBallot, (r)));
        if (remembered[key]) {
            if (!ok || logs.length != 0) _fail("a remembered ballot wasn't a no-op");
        } else if (inside) {
            if (!ok || logs.length != 1) _fail("a ballot inside the window was refused");
            remembered[key] = true;
        } else if (ok) {
            _fail("a ballot outside the window was accepted");
        }
        _fold(logs);
    }

    /// A relayed ballot with a stamp around the window, from the relay's
    /// alias or another sender, at any block time: accepted with an event
    /// exactly when the sender is the alias and the stamp is inside, a
    /// remembered record included.
    function submitRelayed(uint8 which, uint8 stampSeed, uint8 timeSeed, bool forged) external {
        bytes memory r = ballots[which % 2];
        uint64 stamp = _time(stampSeed);
        vm.warp(_time(timeSeed));
        address from = forged ? address(uint160(relayAlias) ^ 1) : relayAlias;
        bytes memory data =
            abi.encodeCall(Board.submitRelayedBallot, (uint64(which), 1, stamp, 1, r));
        (bool ok, Vm.Log[] memory logs) = _call(from, data);
        bool expected = !forged && stamp >= opensAt && stamp <= closesAt;
        if (ok != expected || logs.length != (expected ? 1 : 0)) {
            _fail("a relayed deposit's outcome isn't its sender's and stamp's");
        }
        if (ok) {
            remembered[keccak256(r)] = true;
            relayedAccepted++;
        }
        _fold(logs);
    }

    /// A statement of one of the four seats with one of three claims against
    /// one of two L1 blocks, signed by the seat: a no-op if remembered,
    /// accepted unless the seat already has two claims or this one, refused
    /// otherwise.
    function submitStatement(uint8 seatSeed, uint8 claimSeed, bool otherL1) external {
        uint8 seat = seats[seatSeed % 4];
        bytes memory s = bytes.concat(statement);
        s[35] = bytes1(seat);
        s[44] = otherL1 ? bytes1(0x01) : bytes1(0x00);
        bytes32 claimHash = bytes32(uint256(claimSeed % 3));
        for (uint256 i; i < 32; i++) {
            s[84 + i] = claimHash[i];
        }
        s = _signed(s, seat);
        bytes32 key = keccak256(s);
        bytes32 claim = keccak256(_slice(s, 76, 40));
        (bool ok, Vm.Log[] memory logs) =
            _call(address(this), abi.encodeCall(Board.submitCloseStatement, (s)));
        bytes32[] storage held = claims[seat];
        bool limit = held.length == 2 || (held.length == 1 && held[0] == claim);
        if (remembered[key]) {
            if (!ok || logs.length != 0) _fail("a remembered statement wasn't a no-op");
        } else if (limit) {
            if (ok) _fail("a statement past the limit was accepted");
        } else {
            if (!ok || logs.length != 1) _fail("a statement within the limit was refused");
            remembered[key] = true;
            held.push(claim);
            statementsAccepted++;
        }
        _fold(logs);
    }

    // --- shadow ------------------------------------------------------------------

    function _fold(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(board)) _fail("another emitter");
            if (logs[i].topics[1] != definitionHash) _fail("another election");
            shadowAccumulator = EventAccumulatorLib.step(
                shadowAccumulator,
                shadowCount++,
                block.number,
                block.timestamp,
                logs[i].topics,
                logs[i].data
            );
        }
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        if (acc != shadowAccumulator || count != shadowCount) {
            _fail("the accumulator isn't the shadow's replay");
        }
    }

    function _call(address from, bytes memory data)
        internal
        returns (bool ok, Vm.Log[] memory logs)
    {
        vm.recordLogs();
        vm.prank(from);
        (ok,) = address(board).call(data);
        logs = vm.getRecordedLogs();
    }

    /// A time at or around the window's edges.
    function _time(uint8 seed) internal view returns (uint64) {
        uint64[6] memory t =
            [opensAt - 1, opensAt, opensAt + 1, closesAt - 1, closesAt, closesAt + 1];
        return t[seed % 6];
    }

    function _signed(bytes memory s, uint8 seat) internal view returns (bytes memory) {
        bytes32 digest =
            sha256(bytes.concat("\x1eabolish/v1/sig/close-statement", _slice(s, 0, SIGNATURE_AT)));
        (uint256 r, uint256 sig) = TrusteeFixture.sign(secrets[seat], digest);
        bytes memory out = bytes.concat(_slice(s, 0, SIGNATURE_AT), bytes32(r), bytes32(sig));
        return out;
    }

    function _fail(string memory why) internal {
        if (bytes(failure).length == 0) failure = why;
    }

    function _slice(bytes memory b, uint256 from, uint256 len)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[from + i];
        }
    }
}

/// Invariants, over any sequence of handler calls (docs/spec/contracts.md,
/// Board, Relayed ballots and Close statements; docs/spec/close.md, Window;
/// T-35, T-50, T-71, T-17, T-25):
/// 1. An ordinary ballot is accepted exactly inside `[opens_at, closes_at]`
///    by its block's time, unless the board already holds its bytes, when
///    it is a no-op whatever the time.
/// 2. A relayed deposit is accepted, with its event, exactly when it comes
///    from the relay's alias with a stamp inside the window, whatever the
///    block's time and whether the board already holds the record.
/// 3. Each seat has at most two accepted statements per election, with
///    different claims, and a statement within that limit is never refused.
/// 4. The accumulator is the shadow's replay over exactly the logs emitted.
/// Each is checked by the handler as it goes (its `failure`), and 3 and 4
/// again here against the board.
contract BoardCloseRuleInvariantTest is TestBase {
    string internal constant V1 = "../../docs/spec/vectors/ballot.json";
    string internal constant CLOSE = "../../docs/spec/vectors/close-statement.json";
    string internal constant RELAY_VECTORS = "../../docs/spec/vectors/relay.json";
    bytes32 internal constant STUB = keccak256("close-rule stub");
    bytes32 internal constant PANEL = keccak256("panel");

    Board internal board;
    CloseRuleHandler internal handler;

    function setUp() public {
        ElectionsStub elections = new ElectionsStub();
        TrusteesStub trustees = new TrusteesStub();
        string memory rj = vm.readFile(RELAY_VECTORS);
        board = new Board(
            address(elections),
            address(trustees),
            address(bytes20(vm.parseBytes(vm.parseJsonString(rj, ".aliases[0].l1"))))
        );
        string memory bj = vm.readFile(V1);
        ElectionDefinitionLib.Definition memory d = new DefinitionHarness()
            .decode(vm.parseBytes(vm.parseJsonString(bj, ".elections.plurality.definition")));
        bytes32 h =
            bytes32(vm.parseBytes(vm.parseJsonString(bj, ".elections.plurality.definitionHash")));
        _setElection(elections, trustees, bj, d, h);
        string memory cj = vm.readFile(CLOSE);
        uint256[4] memory secrets = _setStatementSeats(trustees, cj);
        // One election for ballots and statements: the statements are
        // re-signed for its definition hash.
        bytes memory statement = vm.parseBytes(vm.parseJsonString(cj, ".statements[0].encoding"));
        for (uint256 i; i < 32; i++) {
            statement[3 + i] = h[i];
        }
        bytes[2] memory ballots = [
            vm.parseBytes(vm.parseJsonString(bj, ".ballots[0].encoding")),
            vm.parseBytes(vm.parseJsonString(bj, _ballotAt(bj, "option-proof")))
        ];
        handler = new CloseRuleHandler(
            CloseRuleSetup({
                board: board,
                relayAlias: address(
                    bytes20(vm.parseBytes(vm.parseJsonString(rj, ".aliases[0].l2")))
                ),
                definitionHash: h,
                opensAt: d.opensAt,
                closesAt: d.closesAt,
                ballots: ballots,
                statement: statement,
                secrets: secrets
            })
        );
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_NoRuleBroken() public view {
        assertTrue(bytes(handler.failure()).length == 0, handler.failure());
    }

    function invariant_AtMostTwoDistinctClaimsPerSeat() public view {
        uint8[4] memory seats = [1, 2, 3, 5];
        for (uint256 i; i < 4; i++) {
            bytes32[] memory c = handler.seatClaims(seats[i]);
            assertTrue(c.length <= 2, "at most two");
            if (c.length == 2) assertTrue(c[0] != c[1], "different claims");
        }
    }

    function invariant_AccumulatorIsTheShadowReplay() public view {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        assertEq(acc, handler.shadowAccumulator(), "accumulator");
        assertEq(count, handler.shadowCount(), "count");
    }

    /// ballot.json's plurality election with its definition's window, and
    /// its first ballot's key set under STUB, which the statements' seats
    /// join.
    function _setElection(
        ElectionsStub elections,
        TrusteesStub trustees,
        string memory bj,
        ElectionDefinitionLib.Definition memory d,
        bytes32 h
    ) internal {
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 1;
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.optionCount = d.optionCount;
        (p.opensAt, p.closesAt) = (d.opensAt, d.closesAt);
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] =
            ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        uint8[] memory tiers = new uint8[](2);
        uint256[] memory roots = new uint256[](2);
        for (uint256 i; i < 2; i++) {
            string memory t = string.concat(".elections.plurality.tiers[", vm.toString(i), "]");
            tiers[i] = uint8(vm.parseJsonUint(bj, string.concat(t, ".tier")));
            roots[i] = vm.parseUint(vm.parseJsonString(bj, string.concat(t, ".root")));
        }
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, STUB, PANEL);
        uint256[] memory registered = vm.parseJsonUintArray(bj, ".ballots[0].registered");
        uint256 mask;
        for (uint256 i; i < registered.length; i++) {
            mask |= 1 << registered[i];
        }
        // With the statements' seats 1, 2, 3 and 5: more seats only relax
        // `share-hash-unqualified`, so the ballots still pass.
        trustees.setKeySet(STUB, PANEL, mask | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5));
    }

    function _setStatementSeats(TrusteesStub trustees, string memory cj)
        internal
        returns (uint256[4] memory secrets)
    {
        for (uint256 i; i < 4; i++) {
            string memory s = string.concat(".statements[", vm.toString(i), "]");
            uint256 seat = vm.parseJsonUint(cj, string.concat(s, ".signer"));
            (uint256 x, uint256 y, bool onCurve) = TrusteeFixture.point(
                vm.parseBytes(vm.parseJsonString(cj, string.concat(s, ".signingKey")))
            );
            assertTrue(onCurve, "signing key");
            trustees.setKey(STUB, PANEL, seat, x, y);
            // The handler's seats in order: 1, 2, 3, 5.
            uint256 slot = seat == 5 ? 3 : seat - 1;
            secrets[slot] = vm.parseUint(
                string.concat("0x", vm.parseJsonString(cj, string.concat(s, ".signingSecret")))
            );
        }
    }

    function _ballotAt(string memory bj, string memory id) internal view returns (string memory) {
        for (uint256 i;; i++) {
            string memory b = string.concat(".ballots[", vm.toString(i), "]");
            if (
                keccak256(bytes(vm.parseJsonString(bj, string.concat(b, ".id"))))
                    == keccak256(bytes(id))
            ) {
                return string.concat(b, ".encoding");
            }
        }
    }
}
