// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheck, BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's direct submit of ballot version 4 (docs/spec/contracts.md,
/// Board, Ballots (version 4), Deployment) against ballot-v4-records.json
/// (records with real membership proofs and both panels' key sets) and
/// contract-event-v9.json (the events the board emits for them, from an
/// independent generator). The registries are stubs set from the files; the
/// author key set comes from the election registry's `authorKeySetOf`,
/// never from the submitter (ADR 0035; T-17, T-25, T-37).
contract BoardBallotV4Test is TestBase {
    string internal constant V4 = "../../docs/spec/vectors/ballot-v4-records.json";
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v9.json";

    bytes32 internal constant BALLOT_SUBMITTED =
        keccak256("BallotSubmitted(bytes32,bytes32,bytes)");
    bytes32 internal constant RELAYED_SUBMITTED =
        keccak256("RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)");

    /// The ceremony the stubs record each election's default key set under:
    /// any value, since the board only passes it from one registry to the
    /// other.
    bytes32 internal constant PANEL = keccak256("panel");
    address internal constant RELAY = address(0x4E1A);
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    ElectionsStub internal elections;
    TrusteesStub internal trustees;
    Board internal board;
    DefinitionHarness internal defs;

    function setUp() public {
        string memory json = vm.readFile(V4);
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        defs = new DefinitionHarness();
        board = new Board(address(elections), address(trustees), RELAY);
        _election(json, ".elections.panels");
        _election(json, ".elections.default-only");
    }

    /// The ballot check is the contract the board created first, at the
    /// address its nonce 1 gives, with the release build's runtime code: no
    /// one can deploy a board that runs another check (Deployment; T-64).
    function test_BallotCheckIsTheBoardsFirstCreation() public view {
        address check = address(board.ballotCheck());
        assertTrue(check == vm.computeCreateAddress(address(board), 1), "the board's creation");
        assertEq(keccak256(check.code), keccak256(type(BallotCheck).runtimeCode), "its code");
    }

    /// Every ballot of the file whose admission the board runs (all but the
    /// validity proofs) is accepted and emitted whole, its event exactly
    /// contract-event-v9.json's record of it; every other is refused with
    /// the file's code, emitting nothing (T-25, T-17). Each runs on a fresh
    /// board, since some share their bytes and a repeat is a no-op.
    function test_Version4BallotsWithTheirEvents() public {
        uint256 count =
            abi.decode(vm.parseJson(vm.readFile(V4), ".ballots[*].id"), (string[])).length;
        uint256 fresh = vm.snapshotState();
        uint256 accepted;
        for (uint256 i; i < count; i++) {
            vm.revertToState(fresh);
            // Each ballot in its own call frame, whose memory the files fill.
            if (this.checkVectorBallot(i)) accepted++;
        }
        assertEq(count, 23, "ballot coverage");
        assertEq(accepted, 8, "accepted ballots");
    }

    /// Ballot `i` of the file against the board; whether it was accepted.
    function checkVectorBallot(uint256 i) external returns (bool accepted) {
        string memory json = vm.readFile(V4);
        string memory b = _at(".ballots", i, "");
        string memory id = _str(json, string.concat(b, ".id"));
        _registerKeySets(json, b);
        bytes memory call =
            abi.encodeCall(Board.submitBallot, (_bytes(json, string.concat(b, ".encoding"))));
        string memory code = _str(json, string.concat(b, ".admission.code"));
        if (_eq(code, "ok") || _eq(code, "option-proof") || _eq(code, "sum-proof")) {
            Vm.Log[] memory logs = _accept(call);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            string memory ej = vm.readFile(EVENTS);
            string memory f = _eventFields(ej, string.concat("ballot-submitted-v4-", id));
            _assertLog(ej, f, logs[0], BALLOT_SUBMITTED, id);
            assertEq(_accept(call).length, 0, "a repeat emits nothing");
            return true;
        }
        _refuse(
            call, abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, _code(code)), id
        );
    }

    /// The file's decode rejections are refused with their codes and offsets.
    function test_Version4DecodeRejections() public {
        string memory json = vm.readFile(V4);
        _registerKeySets(json, ".ballots[3]");
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            if (!vm.keyExistsJson(json, string.concat(d, ".offset"))) continue;
            _refuse(
                abi.encodeCall(Board.submitBallot, (_bytes(json, string.concat(d, ".encoding")))),
                abi.encodeWithSelector(
                    BallotCheckLib.BallotMalformed.selector,
                    _decodeError(_str(json, string.concat(d, ".error"))),
                    vm.parseJsonUint(json, string.concat(d, ".offset"))
                ),
                _str(json, string.concat(d, ".id"))
            );
        }
        assertEq(i, 13, "decode coverage");
    }

    /// The author key set is the one the election registry recorded with the
    /// definition: the every-seat ballot passes while it holds all three
    /// author seats and is refused once it holds two, with the default key
    /// set unchanged, so the board reads the author set and judges by it.
    function test_AuthorKeySetFromTheElectionRegistry() public {
        string memory json = vm.readFile(V4);
        _registerKeySets(json, ".ballots[3]");
        bytes memory record = _bytes(json, ".ballots[3].encoding");
        bytes32 h = bytes32(_bytes(json, ".elections.panels.definitionHash"));
        uint256 snapshot = vm.snapshotState();
        assertEq(_accept(abi.encodeCall(Board.submitBallot, (record))).length, 1, "accepted");
        vm.revertToState(snapshot);
        elections.setAuthorKeySet(h, (1 << 1) | (1 << 3));
        _refuse(
            abi.encodeCall(Board.submitBallot, (record)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.ShareHashUnqualified
            ),
            "author seat 2 unregistered"
        );
        elections.setAuthorKeySet(h, 0);
        _refuse(
            abi.encodeCall(Board.submitBallot, (record)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.ShareHashUnqualified
            ),
            "no author key set"
        );
    }

    /// Both relayed ballots of contract-event-v9.json, with and without an
    /// author half, are accepted from the relay's alias with the deposit's
    /// fields, their events exactly the file's.
    function test_RelayedVersion4Ballots() public {
        string memory json = vm.readFile(V4);
        string memory ej = vm.readFile(EVENTS);
        string[2] memory ids = ["relayed-ballot-v4", "relayed-ballot-v4-default-only"];
        uint256[2] memory ballots = [uint256(0), 7];
        for (uint256 i; i < 2; i++) {
            string memory b = _at(".ballots", ballots[i], "");
            _registerKeySets(json, b);
            string memory f = _eventFields(ej, ids[i]);
            (uint64 index, uint64 l1Block, uint64 stamp, uint64 gasLimit, bytes memory record) = abi.decode(
                _bytes(ej, string.concat(f, ".data")), (uint64, uint64, uint64, uint64, bytes)
            );
            assertEq(
                keccak256(record),
                keccak256(_bytes(json, string.concat(b, ".encoding"))),
                "the file's ballot"
            );
            Vm.Log[] memory logs = _acceptFrom(
                address(uint160(RELAY) + ALIAS_OFFSET),
                abi.encodeCall(Board.submitRelayedBallot, (index, l1Block, stamp, gasLimit, record))
            );
            assertEq(logs.length, 1, ids[i]);
            _assertLog(ej, f, logs[0], RELAYED_SUBMITTED, ids[i]);
        }
    }

    // --- helpers -------------------------------------------------------------

    /// One election of the file in the stubs: its parameters from its
    /// definition, its cells from the file, a window holding every L2 time,
    /// and its ceremony.
    function _election(string memory json, string memory e) internal {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(json, string.concat(e, ".definition")));
        ElectionRegistry.Parameters memory p;
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.authorThreshold = d.authorThreshold;
        p.authorPanelSize = uint8(d.authorKeys.length);
        p.closesAt = type(uint64).max;
        p.questions = new ElectionRegistry.Question[](d.questions.length);
        for (uint256 q; q < d.questions.length; q++) {
            ElectionDefinitionLib.Question memory dq = d.questions[q];
            p.questions[q] = ElectionRegistry.Question(
                dq.method, dq.optionCount, dq.minSelections, dq.maxSelections
            );
            p.optionCount += dq.optionCount;
        }
        for (uint256 i; i < d.pinTypes.length; i++) {
            if (d.pinTypes[i] == 2) p.ballotVersion = d.pinVersions[i];
        }
        assertEq(p.ballotVersion, 4, "the definition's ballot pin");
        uint256 n;
        while (vm.keyExistsJson(json, _at(string.concat(e, ".cells"), n, ""))) n++;
        uint8[] memory tiers = new uint8[](n);
        uint256[] memory roots = new uint256[](n);
        for (uint256 c; c < n; c++) {
            string memory cell = _at(string.concat(e, ".cells"), c, "");
            tiers[c] = uint8(vm.parseJsonUint(json, string.concat(cell, ".tier")));
            roots[c] = vm.parseUint(_str(json, string.concat(cell, ".root")));
        }
        bytes32 h = bytes32(_bytes(json, string.concat(e, ".definitionHash")));
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, h, PANEL);
    }

    /// The ballot's two key sets, as the file registers them, in the
    /// trustee registry (default) and the election registry (author).
    function _registerKeySets(string memory json, string memory b) internal {
        bytes32 h = bytes32(
            _bytes(
                json,
                string.concat(
                    ".elections.", _str(json, string.concat(b, ".election")), ".definitionHash"
                )
            )
        );
        trustees.setKeySet(
            h, PANEL, _mask(vm.parseJsonUintArray(json, string.concat(b, ".registered")))
        );
        elections.setAuthorKeySet(
            h, _mask(vm.parseJsonUintArray(json, string.concat(b, ".authorRegistered")))
        );
    }

    /// The `.fields` key of contract-event-v9.json's record `id`.
    function _eventFields(string memory ej, string memory id)
        internal
        view
        returns (string memory)
    {
        string[] memory ids = abi.decode(vm.parseJson(ej, ".records[*].id"), (string[]));
        for (uint256 i; i < ids.length; i++) {
            if (_eq(ids[i], id)) return _at(".records", i, ".fields");
        }
        revert(string.concat("no event record ", id));
    }

    /// The log is the file's record: its topics and its data.
    function _assertLog(
        string memory ej,
        string memory f,
        Vm.Log memory log,
        bytes32 topic0,
        string memory id
    ) internal pure {
        assertEq(log.topics.length, 3, string.concat("three topics for ", id));
        assertEq(log.topics[0], topic0, string.concat("topic 0 of ", id));
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

    function _accept(bytes memory data) internal returns (Vm.Log[] memory) {
        return _acceptFrom(address(this), data);
    }

    /// Calls the board from `sender`, requires success, and checks every log
    /// it emitted against its accumulator.
    function _acceptFrom(address sender, bytes memory data)
        internal
        returns (Vm.Log[] memory logs)
    {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.recordLogs();
        vm.prank(sender);
        (bool ok, bytes memory ret) = address(board).call(data);
        if (!ok) revert(string.concat("refused: ", vm.toString(ret)));
        logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter == address(board), "emitter");
            acc = EventAccumulatorLib.step(
                acc, uint64(count + i), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(after_, acc, "accumulator");
        assertEq(countAfter, count + logs.length, "count");
    }

    function _refuse(bytes memory data, bytes memory expected, string memory what) internal {
        (bool ok, bytes memory ret) = address(board).call(data);
        assertTrue(!ok, string.concat(what, ": accepted"));
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    function _code(string memory s) internal pure returns (BallotCheckLib.Code) {
        bytes32 c = keccak256(bytes(s));
        if (c == keccak256("ballot-stray")) return BallotCheckLib.Code.BallotStray;
        if (c == keccak256("ballot-cell")) return BallotCheckLib.Code.BallotCell;
        if (c == keccak256("validity-shape")) return BallotCheckLib.Code.ValidityShape;
        if (c == keccak256("share-hash-unqualified")) {
            return BallotCheckLib.Code.ShareHashUnqualified;
        }
        if (c == keccak256("membership-proof")) return BallotCheckLib.Code.MembershipProof;
        revert(string.concat("unknown result ", s));
    }

    function _decodeError(string memory s)
        internal
        pure
        returns (ElectionDefinitionLib.DecodeError)
    {
        bytes32 c = keccak256(bytes(s));
        if (c == keccak256("truncated")) return ElectionDefinitionLib.DecodeError.Truncated;
        if (c == keccak256("trailing-bytes")) {
            return ElectionDefinitionLib.DecodeError.TrailingBytes;
        }
        if (c == keccak256("length-over-max")) {
            return ElectionDefinitionLib.DecodeError.LengthOverMax;
        }
        if (c == keccak256("non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", s));
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory j, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(j, key);
    }

    function _bytes(string memory j, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(_str(j, key));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
