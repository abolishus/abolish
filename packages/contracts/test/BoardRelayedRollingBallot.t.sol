// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {MembershipProofLib} from "../src/MembershipProof.sol";
import {BoardRollingFixture} from "./BoardRollingBallot.t.sol";
import {Vm} from "./utils/Vm.sol";

/// The board's relayed rolling call (docs/spec/contracts.md, Board, Relayed
/// rolling ballots; P2-17 part 5d-2b) against ballot-v5-records.json,
/// contract-event-v11.json (the `RelayedRollingBallotSubmitted` records an
/// independent generator wrote for every ballot of that file, each with its
/// call fields and supplied root) and relay-rolling.json (the deposits the
/// relay's rolling call makes, whose data the relay's own tests check).
/// Every expected value comes from the files or the spec. Threats: T-50 (a
/// forced ballot kept off the board), T-71 (a deposit from anyone but the
/// relay), T-25 and T-38 (another root attached to an honest ballot), T-04
/// (a fixed poll's registered root replaced), T-17 (chosen bytes).
contract BoardRelayedRollingBallotTest is BoardRollingFixture {
    string internal constant EVENTS_11 = "../../docs/spec/vectors/contract-event-v11.json";
    string internal constant RELAY_CALLS = "../../docs/spec/vectors/relay-rolling.json";

    bytes32 internal constant RELAYED_ROLLING_SUBMITTED = keccak256(
        "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)"
    );
    /// The relay's alias on L2 (contracts.md, L1 relay, Relaying).
    address internal constant ALIAS =
        address(uint160(RELAY) + uint160(0x1111000000000000000000000000000000001111));

    /// A deposit's call fields and root, as an event of the file carries them.
    struct Call {
        uint64 index;
        uint64 l1Block;
        uint64 stamp;
        uint64 gasLimit;
        bytes32 root;
        bytes record;
    }

    /// Every ballot of ballot-v5-records.json, deposited with the call fields
    /// and root of contract-event-v11's `relayed-rolling-<id>`, is accepted
    /// and emitted exactly as that record, or refused with the board's code,
    /// the verdict `submitRollingBallot` gives it (BoardRollingBallot.t.sol):
    /// the relayed call checks a ballot exactly as the ordinary one, only
    /// the sender and the window's clock differ. An accepted deposit's
    /// repeat emits again (No repeats on this path; T-50). Each runs on a
    /// fresh board; the file runs in two halves, each within a block's gas.
    function test_Version5BallotsWithTheirEvents() public {
        uint256 count =
            abi.decode(vm.parseJson(vm.readFile(V5), ".ballots[*].id"), (string[])).length;
        assertEq(count, 30, "ballot coverage");
        assertEq(_checkRelayedBallots(0, 15), 10, "accepted ballots, first half");
    }

    function test_Version5BallotsWithTheirEventsSecondHalf() public {
        assertEq(_checkRelayedBallots(15, 30), 3, "accepted ballots, second half");
    }

    function _checkRelayedBallots(uint256 from, uint256 to) internal returns (uint256 accepted) {
        uint256 fresh = vm.snapshotState();
        for (uint256 i = from; i < to; i++) {
            vm.revertToState(fresh);
            if (this.checkRelayedBallot(i)) accepted++;
        }
    }

    /// Ballot `i` of the file, deposited by the relay; whether it was accepted.
    function checkRelayedBallot(uint256 i) external returns (bool) {
        string memory json = vm.readFile(V5);
        string memory b = _at(".ballots", i, "");
        string memory id = _str(json, string.concat(b, ".id"));
        _registerKeySets(json, b);
        string memory ej = vm.readFile(EVENTS_11);
        string memory f = _eventFields(ej, string.concat("relayed-rolling-", id));
        Call memory c = _relayed(ej, f);
        assertEq(
            keccak256(c.record),
            keccak256(_bytes(json, string.concat(b, ".encoding"))),
            "its ballot"
        );
        bytes memory call = _deposit(c);
        string memory code = _boardCode(id, _str(json, string.concat(b, ".admission.code")));
        if (_eq(code, "accepted")) {
            Vm.Log[] memory logs = _acceptFromRelay(call);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            _assertRelayedLog(ej, f, logs[0], id);
            logs = _acceptFromRelay(call);
            assertEq(logs.length, 1, "a repeat emits again");
            _assertRelayedLog(ej, f, logs[0], id);
            return true;
        }
        _refuseFromRelay(
            call, abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, _code(code)), id
        );
        return false;
    }

    /// The relay's rolling deposits of relay-rolling.json, byte for byte:
    /// the v5-ballot call's is accepted and emitted as contract-event-v11's
    /// `relayed-rolling-call`, and the next call's, the same record and root
    /// one slot later, as `relayed-rolling-call-repeat`, so the relay's
    /// deposit and the board's call agree on every byte (T-50). The call with
    /// step N0 − 1's root is refused (`membership-proof`), and the deposits of
    /// the shortest record, alone or with roots of 0, r and 2²⁵⁶ − 1, as
    /// `ballot-stray`, so each leaves its relay call with no event, which the
    /// verifier reports and never fails.
    function test_TheRelaysDepositsAreTheFiles() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        string memory rj = vm.readFile(RELAY_CALLS);
        string memory ej = vm.readFile(EVENTS_11);
        string[2] memory accepted = ["v5-ballot", "v5-ballot-next-call"];
        string[2] memory records = ["relayed-rolling-call", "relayed-rolling-call-repeat"];
        for (uint256 i; i < accepted.length; i++) {
            Vm.Log[] memory logs = _acceptFromRelay(_relayDeposit(rj, accepted[i]));
            assertEq(logs.length, 1, accepted[i]);
            _assertRelayedLog(ej, _eventFields(ej, records[i]), logs[0], records[i]);
        }
        bytes memory refused = abi.encodeWithSelector(
            BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
        );
        _refuseFromRelay(_relayDeposit(rj, "v5-ballot-other-root"), refused, "other root");
        // Their 35-byte record names no election the board knows.
        bytes memory stray = abi.encodeWithSelector(
            BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.BallotStray
        );
        string[4] memory others = ["root-zero", "root-r", "root-max", "shortest"];
        for (uint256 i; i < others.length; i++) {
            _refuseFromRelay(_relayDeposit(rj, others[i]), stray, others[i]);
        }
    }

    /// `relay-sender`: any caller but the relay's alias is refused before the
    /// record is read, the relay's own L1 address and a record that would
    /// pass included (T-71).
    function testFuzz_OnlyTheRelaysAliasMayCall(address caller) public {
        vm.assume(caller != ALIAS);
        Call memory c = _honest();
        bytes memory call = _deposit(c);
        address[3] memory callers = [caller, RELAY, address(this)];
        for (uint256 i; i < callers.length; i++) {
            if (callers[i] == ALIAS) continue;
            vm.prank(callers[i]);
            (bool ok, bytes memory ret) = address(board).call(call);
            assertTrue(!ok, "accepted");
            assertEq(
                keccak256(ret),
                keccak256(abi.encodeWithSelector(Board.RelaySender.selector, callers[i])),
                "relay-sender"
            );
        }
        // Before the record: junk from another caller is refused as the sender.
        vm.prank(caller);
        (bool ok2, bytes memory ret2) = address(board)
            .call(abi.encodeCall(Board.submitRelayedRollingBallot, (0, 0, 0, 0, 0, hex"00")));
        assertTrue(!ok2, "junk accepted");
        assertEq(
            keccak256(ret2),
            keccak256(abi.encodeWithSelector(Board.RelaySender.selector, caller)),
            "the sender first"
        );
    }

    /// A ballot naming one step whose proof is against another step's root
    /// is accepted with the root its proof holds against, emitted exactly as
    /// the file's `relayed-rolling-root-mismatch`; the verifier rejects it
    /// (`root-step-mismatch`; T-53). With its own step's root the board
    /// refuses it.
    function test_ARootOfAnotherStepIsTheVerifiers() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "membership-other-step-root"));
        string memory ej = vm.readFile(EVENTS_11);
        string memory f = _eventFields(ej, "relayed-rolling-root-mismatch");
        Call memory c = _relayed(ej, f);
        Call memory own =
            _relayed(ej, _eventFields(ej, "relayed-rolling-membership-other-step-root"));
        assertTrue(c.root != own.root, "another step's root");
        assertEq(keccak256(c.record), keccak256(own.record), "the same record");
        c.root = own.root;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "its step's root"
        );
        Vm.Log[] memory logs = _acceptFromRelay(_deposit(_relayed(ej, f)));
        assertEq(logs.length, 1, "one event");
        _assertRelayedLog(ej, f, logs[0], "relayed-rolling-root-mismatch");
    }

    /// An honest ballot deposited with any root but its proof's is refused
    /// (`membership-proof`): the file's 1 and `r − 1`, the front-run root,
    /// and 0 and `r`. The relayed path never consults the repeats, so this
    /// holds after the honest deposit too: the ordinary path's no-op for a
    /// copy with another root doesn't exist here, and no deposit with
    /// another root is ever emitted (T-25, T-38).
    function test_OnlyTheProofsRootIsAccepted() public {
        string memory ej = vm.readFile(EVENTS_11);
        Call memory c = _honest();
        bytes32 own = c.root;
        bytes32[5] memory roots;
        (roots[0],) = _rolling(
            vm.readFile(EVENTS), _eventFields(vm.readFile(EVENTS), "rolling-root-front-run")
        );
        roots[1] = _relayed(ej, _eventFields(ej, "relayed-rolling-root-one")).root;
        roots[2] = _relayed(ej, _eventFields(ej, "relayed-rolling-root-r-minus-one")).root;
        roots[3] = 0;
        roots[4] = bytes32(MembershipProofLib.R);
        assertEq(uint256(roots[1]), 1, "the file's root 1");
        assertEq(uint256(roots[2]), MembershipProofLib.R - 1, "the file's root r - 1");
        bytes memory refused = abi.encodeWithSelector(
            BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
        );
        for (uint256 pass; pass < 2; pass++) {
            for (uint256 i; i < roots.length; i++) {
                assertTrue(roots[i] != own, "another root");
                c.root = roots[i];
                _refuseFromRelay(_deposit(c), refused, "another root");
            }
            c.root = own;
            assertEq(_acceptFromRelay(_deposit(c)).length, 1, "its own root");
        }
    }

    /// Any root but the one the proof fixes is refused (T-38).
    function testFuzz_AnyOtherRootIsRefused(bytes32 root) public {
        Call memory c = _honest();
        vm.assume(root != c.root);
        c.root = root;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "another root"
        );
    }

    /// The call fields are carried, never judged: any index, block, stamp
    /// (the fixture's window holds every one) and gas limit is emitted as
    /// given, after the
    /// record's own topics (T-50; the verifier matches them, 4.5).
    function testFuzz_TheCallFieldsAreCarried(
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit
    ) public {
        Call memory c = _honest();
        c.index = index;
        c.l1Block = l1Block;
        c.stamp = stamp;
        c.gasLimit = gasLimit;
        Vm.Log[] memory logs = _acceptFromRelay(_deposit(c));
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics[0], RELAYED_ROLLING_SUBMITTED, "topic 0");
        assertEq(logs[0].topics[1], bytes32(_slice(c.record, 3, 32)), "definition hash");
        assertEq(
            keccak256(logs[0].data),
            keccak256(abi.encode(index, l1Block, stamp, gasLimit, c.root, c.record)),
            "the data"
        );
    }

    /// `relay-window`: the stamp, never the block's timestamp, is tested
    /// against `[opens_at, closes_at]`, after the ballot check (close.md,
    /// Window; T-35, T-50).
    function test_TheWindowIsTheStamp() public {
        string memory json = vm.readFile(V5);
        Call memory c = _honest();
        bytes32 h = bytes32(_slice(c.record, 3, 32));
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _parameters(json, "rolling", 5);
        p.opensAt = 1000;
        p.closesAt = 2000;
        elections.set(h, p, tiers, roots);
        c.stamp = 999;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(Board.RelayWindow.selector, 999, 1000, 2000),
            "early"
        );
        c.stamp = 2001;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(Board.RelayWindow.selector, 2001, 1000, 2000),
            "late"
        );
        bytes32 own = c.root;
        c.root = 0;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "the check first"
        );
        c.root = own;
        // Long after the close by the block's clock, a stamp at the close passes.
        vm.warp(1_000_000);
        c.stamp = 2000;
        assertEq(_acceptFromRelay(_deposit(c)).length, 1, "at the close");
        c.stamp = 1000;
        assertEq(_acceptFromRelay(_deposit(c)).length, 1, "at the opening");
    }

    /// The call takes only rolling polls' ballots: a ballot of an election
    /// pinning version 4 is `unknown-version` at 2, so a supplied root never
    /// replaces a fixed poll's registered one (T-04); the fixed relayed call
    /// refuses a version-5 ballot the same way (BoardRollingBallot.t.sol).
    function test_OnlyRollingPollsBallots() public {
        string memory json = vm.readFile(V5);
        Call memory c = _honest();
        _election(json, "rolling", 4);
        c.record[2] = 0x04;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(
                BallotCheckLib.BallotMalformed.selector,
                ElectionDefinitionLib.DecodeError.UnknownVersion,
                2
            ),
            "a fixed poll's ballot"
        );
    }

    /// The calldata is the canonical encoding of the four call fields, the
    /// root and the record: another offset, trailing bytes, nonzero padding
    /// or a call field at or above 2⁶⁴ are refused before the record is read
    /// (Calls; T-17).
    function test_NonCanonicalCalldataIsRefused() public {
        Call memory c = _honest();
        bytes memory call = _deposit(c);
        bytes memory refused =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _refuseFromRelay(bytes.concat(call, bytes1(0)), refused, "a trailing byte");
        _refuseFromRelay(bytes.concat(call, bytes32(0)), refused, "a trailing word");
        // The offset word one word further on, with an extra word before the
        // record, which Solidity's decoder reads.
        bytes memory offset = bytes.concat(_slice(call, 0, 4 + 160), bytes32(uint256(0xe0)));
        offset = bytes.concat(offset, bytes32(0), _slice(call, 4 + 192, call.length - 4 - 192));
        _refuseFromRelay(offset, refused, "another offset");
        assertTrue(c.record.length % 32 != 0, "padded");
        bytes memory padding = bytes.concat(call);
        padding[padding.length - 1] = 0x01;
        _refuseFromRelay(padding, refused, "nonzero padding");
        // Bit 64 of each call field: Solidity's decoder refuses it.
        for (uint256 w; w < 4; w++) {
            bytes memory wide = bytes.concat(call);
            wide[4 + 32 * w + 23] = 0x01;
            vm.prank(ALIAS);
            (bool ok, bytes memory ret) = address(board).call(wide);
            assertTrue(!ok && ret.length == 0, "a call field at or above 2^64");
        }
        assertEq(_acceptFromRelay(call).length, 1, "the canonical call");
    }

    /// A relayed record is remembered, so a later ordinary copy of the same
    /// bytes is the no-op; and a deposit of bytes the ordinary path already
    /// accepted still emits, since the relayed path never consults the
    /// repeats (No repeats on this path; T-50, T-25).
    function test_RepeatsAcrossPaths() public {
        Call memory c = _honest();
        bytes memory ordinary = abi.encodeCall(Board.submitRollingBallot, (c.root, c.record));
        uint256 fresh = vm.snapshotState();
        assertEq(_acceptFromRelay(_deposit(c)).length, 1, "relayed");
        assertEq(_accept(ordinary).length, 0, "then the ordinary copy is the no-op");
        vm.revertToState(fresh);
        assertEq(_accept(ordinary).length, 1, "ordinary");
        Vm.Log[] memory logs = _acceptFromRelay(_deposit(c));
        assertEq(logs.length, 1, "then the relayed deposit emits");
        assertEq(logs[0].topics[0], RELAYED_ROLLING_SUBMITTED, "the relayed event");
    }

    /// Whatever one byte of an honest rolling record is changed to, and
    /// whichever root carries it, the relayed call refuses it with no event
    /// or accepts it as `RelayedRollingBallotSubmitted` only, outside the
    /// step's bytes, re-passing the rolling check with its root (T-38, T-31).
    function testFuzz_OneByteChanged(uint256 at, uint8 xor, bool ownRoot, bytes32 other) public {
        vm.assume(xor != 0);
        Call memory c = _honest();
        at %= c.record.length;
        c.record[at] = bytes1(uint8(c.record[at]) ^ xor);
        if (!ownRoot) c.root = other;
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.recordLogs();
        vm.prank(ALIAS);
        (bool ok,) = address(board).call(_deposit(c));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
            assertTrue(after_ == acc && countAfter == count, "no event");
            return;
        }
        assertTrue(at < 364 || at > 367, "a changed step");
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics[0], RELAYED_ROLLING_SUBMITTED, "the relayed rolling event");
        board.ballotCheck()
            .checkRolling(c.record, elections, uint256(c.root), 1 << 1 | 1 << 2, 1 << 1 | 1 << 2);
    }

    /// The honest deposit carries no personal data: its calldata, its event's
    /// data and each topic are fixed-size typed fields and a framed record,
    /// with no run of text; text as the root is caught by the detector and
    /// refused, since the proof fixes the root (contracts skill, No PII
    /// on-chain; T-17). The relay records whatever root its caller gives
    /// (contracts.md, L1 relay, Known-weak); the board never emits one the
    /// proof doesn't fix.
    function test_NoPersonalDataInCalldataOrEvents() public {
        Call memory c = _honest();
        bytes memory call = _deposit(c);
        assertTrue(!_looksLikeText(call), "calldata");
        Vm.Log[] memory logs = _acceptFromRelay(call);
        assertEq(logs.length, 1, "one event");
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        for (uint256 t; t < logs[0].topics.length; t++) {
            assertTrue(!_looksLikeText(abi.encode(logs[0].topics[t])), "event topic");
        }
        bytes32 text = bytes32("jane.doe@example.com, X1234567");
        assertTrue(_looksLikeText(abi.encode(text)), "detector misses the root");
        c.root = text;
        _refuseFromRelay(
            _deposit(c),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "text as the root"
        );
    }

    // --- helpers -------------------------------------------------------------

    /// ok-newest-step's deposit as contract-event-v11 carries it, with its
    /// seats registered.
    function _honest() internal returns (Call memory) {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        string memory ej = vm.readFile(EVENTS_11);
        return _relayed(ej, _eventFields(ej, "relayed-rolling-ok-newest-step"));
    }

    /// The call fields, root and record a `RelayedRollingBallotSubmitted`
    /// carries.
    function _relayed(string memory ej, string memory f) internal pure returns (Call memory c) {
        (c.index, c.l1Block, c.stamp, c.gasLimit, c.root, c.record) = abi.decode(
            _bytes(ej, string.concat(f, ".data")), (uint64, uint64, uint64, uint64, bytes32, bytes)
        );
    }

    function _deposit(Call memory c) internal pure returns (bytes memory) {
        return abi.encodeCall(
            Board.submitRelayedRollingBallot,
            (c.index, c.l1Block, c.stamp, c.gasLimit, c.root, c.record)
        );
    }

    /// relay-rolling.json's call `id`'s deposit data, checked against the
    /// file's length and digest.
    function _relayDeposit(string memory rj, string memory id)
        internal
        pure
        returns (bytes memory data)
    {
        string[] memory ids = abi.decode(vm.parseJson(rj, ".calls[*].id"), (string[]));
        for (uint256 i; i < ids.length; i++) {
            if (!_eq(ids[i], id)) continue;
            string memory c = _at(".calls", i, "");
            data = _bytes(rj, string.concat(c, ".depositData"));
            assertEq(
                data.length, vm.parseJsonUint(rj, string.concat(c, ".depositDataLength")), "length"
            );
            assertEq(sha256(data), bytes32(_bytes(rj, string.concat(c, ".depositDataSha256"))), id);
            return data;
        }
        revert(string.concat("no relay call ", id));
    }

    /// The log is the file's `RelayedRollingBallotSubmitted` record: its
    /// topics and its data.
    function _assertRelayedLog(
        string memory ej,
        string memory f,
        Vm.Log memory log,
        string memory id
    ) internal pure {
        assertEq(log.topics.length, 3, string.concat("three topics for ", id));
        assertEq(log.topics[0], RELAYED_ROLLING_SUBMITTED, string.concat("topic 0 of ", id));
        for (uint256 t; t < 3; t++) {
            assertEq(
                bytes32(vm.parseBytes(_str(ej, _at(string.concat(f, ".topics"), t, "")))),
                log.topics[t],
                string.concat("the file's topic of ", id)
            );
        }
        assertEq(
            keccak256(_bytes(ej, string.concat(f, ".data"))),
            keccak256(log.data),
            string.concat("the file's data of ", id)
        );
    }

    function _acceptFromRelay(bytes memory data) internal returns (Vm.Log[] memory) {
        sender = ALIAS;
        Vm.Log[] memory logs = _accept(data);
        sender = address(0);
        return logs;
    }

    function _refuseFromRelay(bytes memory data, bytes memory expected, string memory what)
        internal
    {
        sender = ALIAS;
        _refuse(data, expected, what);
        sender = address(0);
    }
}
