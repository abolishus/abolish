// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {MembershipProofLib} from "../src/MembershipProof.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's rolling call (docs/spec/contracts.md, Board, Rolling ballots;
/// P2-17 part 5d-1) against ballot-v5-records.json (version-5 records with
/// real membership proofs against the step roots an independent generator
/// rebuilt from the groups' events) and contract-event-v10.json (the
/// `RollingBallotSubmitted` records an independent generator wrote for them,
/// each with its supplied root). The registries are stubs set from the
/// files, each rolling cell with the recorded root 0, as the election
/// registry records it: the only root the call checks a proof against is
/// the one supplied, and the verifier, not the board, compares it with the
/// step's (T-04, T-08, T-25, T-38).
contract BoardRollingBallotTest is TestBase {
    string internal constant V5 = "../../docs/spec/vectors/ballot-v5-records.json";
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v10.json";

    bytes32 internal constant ROLLING_SUBMITTED =
        keccak256("RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)");
    bytes32 internal constant PANEL = keccak256("panel");
    address internal constant RELAY = address(0x4E1A);

    ElectionsStub internal elections;
    TrusteesStub internal trustees;
    Board internal board;

    function setUp() public {
        string memory json = vm.readFile(V5);
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), RELAY);
        _election(json, "rolling", 5);
        _election(json, "default-only", 5);
    }

    /// Every ballot of the file, submitted with the root contract-event-v10
    /// supplies for it (its step's root), is accepted and emitted exactly as
    /// the file's record, or refused with the board's code. The board runs
    /// every admission check but the validity proofs and `root-step-range`,
    /// which needs the root clock it can't read: a ballot whose step is
    /// outside the poll but whose proof holds against its step's root is
    /// accepted, and the verifier rejects it (T-53). Each runs on a fresh
    /// board, since some share their bytes and a repeat is a no-op; the file
    /// runs in two halves, each within a block's gas.
    function test_Version5BallotsWithTheirEvents() public {
        uint256 count =
            abi.decode(vm.parseJson(vm.readFile(V5), ".ballots[*].id"), (string[])).length;
        assertEq(count, 30, "ballot coverage");
        assertEq(_checkVectorBallots(0, 15), 10, "accepted ballots, first half");
    }

    function test_Version5BallotsWithTheirEventsSecondHalf() public {
        assertEq(_checkVectorBallots(15, 30), 3, "accepted ballots, second half");
    }

    /// Ballots `from` to `to` of the file, each on a fresh board; how many
    /// were accepted.
    function _checkVectorBallots(uint256 from, uint256 to) internal returns (uint256 accepted) {
        uint256 fresh = vm.snapshotState();
        for (uint256 i = from; i < to; i++) {
            vm.revertToState(fresh);
            // Each ballot in its own call frame, whose memory the files fill.
            if (this.checkVectorBallot(i)) accepted++;
        }
    }

    /// Ballot `i` of the file against the board; whether it was accepted.
    function checkVectorBallot(uint256 i) external returns (bool) {
        string memory json = vm.readFile(V5);
        string memory b = _at(".ballots", i, "");
        string memory id = _str(json, string.concat(b, ".id"));
        _registerKeySets(json, b);
        string memory ej = vm.readFile(EVENTS);
        string memory f = _eventFields(ej, string.concat("rolling-ballot-", id));
        (bytes32 root, bytes memory record) = _rolling(ej, f);
        assertEq(
            keccak256(record), keccak256(_bytes(json, string.concat(b, ".encoding"))), "its ballot"
        );
        bytes memory call = abi.encodeCall(Board.submitRollingBallot, (root, record));
        string memory code = _boardCode(id, _str(json, string.concat(b, ".admission.code")));
        if (_eq(code, "accepted")) {
            Vm.Log[] memory logs = _accept(call);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            _assertLog(ej, f, logs[0], id);
            assertEq(_accept(call).length, 0, "a repeat emits nothing");
            return true;
        }
        _refuse(
            call, abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, _code(code)), id
        );
        return false;
    }

    /// The scope the board computes for a rolling tier is the file's: the
    /// accepted ballots' signals, from the generator's own rolling scope,
    /// with no root in it (membership.md, Rolling scope; T-38).
    function test_RollingScopeIsTheFilesForEachTier() public view {
        string memory json = vm.readFile(V5);
        string[3] memory ids = ["ok-newest-step", "ok-tier-2", "ok-default-only"];
        for (uint256 i; i < ids.length; i++) {
            string memory b = _ballot(json, ids[i]);
            bytes memory record = _bytes(json, string.concat(b, ".encoding"));
            uint8 tier = uint8(vm.parseJsonUint(json, string.concat(b, ".admission.tier")));
            assertEq(
                MembershipProofLib.rollingScope(bytes32(_slice(record, 3, 32)), tier),
                vm.parseUint(_str(json, string.concat(b, ".signals.scope"))),
                ids[i]
            );
        }
    }

    /// A ballot naming one step whose proof is against another step's root
    /// is accepted with the root its proof holds against, emitted exactly as
    /// the file's `rolling-root-mismatch`: the board checks the proof, never
    /// which step the root belongs to, which the verifier judges
    /// (`root-step-mismatch`; T-53). With its own step's root, the root the
    /// verifier would take, the board refuses it (`membership-proof`).
    function test_ARootOfAnotherStepIsTheVerifiers() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "membership-other-step-root"));
        string memory ej = vm.readFile(EVENTS);
        string memory f = _eventFields(ej, "rolling-root-mismatch");
        (bytes32 root, bytes memory record) = _rolling(ej, f);
        (bytes32 stepRoot,) =
            _rolling(ej, _eventFields(ej, "rolling-ballot-membership-other-step-root"));
        assertTrue(root != stepRoot, "another step's root");
        _refuse(
            abi.encodeCall(Board.submitRollingBallot, (stepRoot, record)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "its step's root"
        );
        Vm.Log[] memory logs = _accept(abi.encodeCall(Board.submitRollingBallot, (root, record)));
        assertEq(logs.length, 1, "one event");
        _assertLog(ej, f, logs[0], "rolling-root-mismatch");
    }

    /// An honest ballot with any root but the one its proof holds against is
    /// refused (`membership-proof`), so a front-runner can't attach another
    /// root to it: the file's front-run, 1 and `r − 1`, and 0 and `r`,
    /// which no root may be. Once it is accepted with its own root, a copy
    /// with another root is the no-op, emitting nothing (T-25, T-38, T-04).
    function test_OnlyTheProofsRootIsAccepted() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        string memory ej = vm.readFile(EVENTS);
        (bytes32 own, bytes memory record) =
            _rolling(ej, _eventFields(ej, "rolling-ballot-ok-newest-step"));
        string[3] memory ids =
            ["rolling-root-front-run", "rolling-root-one", "rolling-root-r-minus-one"];
        bytes32[5] memory roots;
        for (uint256 i; i < ids.length; i++) {
            bytes memory copy;
            (roots[i], copy) = _rolling(ej, _eventFields(ej, ids[i]));
            assertEq(keccak256(copy), keccak256(record), ids[i]);
        }
        roots[3] = 0;
        roots[4] = bytes32(MembershipProofLib.R);
        bytes memory refused = abi.encodeWithSelector(
            BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
        );
        for (uint256 i; i < roots.length; i++) {
            _refuse(abi.encodeCall(Board.submitRollingBallot, (roots[i], record)), refused, "root");
        }
        assertEq(_accept(abi.encodeCall(Board.submitRollingBallot, (own, record))).length, 1, "own");
        for (uint256 i; i < roots.length; i++) {
            assertEq(
                _accept(abi.encodeCall(Board.submitRollingBallot, (roots[i], record))).length,
                0,
                "a repeat with another root"
            );
        }
    }

    /// Any root but the one the proof fixes is refused (T-38): with a valid
    /// proof, Groth16's equation admits at most one root.
    function testFuzz_AnyOtherRootIsRefused(uint256 root) public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        string memory ej = vm.readFile(EVENTS);
        (bytes32 own, bytes memory record) =
            _rolling(ej, _eventFields(ej, "rolling-ballot-ok-newest-step"));
        vm.assume(bytes32(root) != own);
        _refuse(
            abi.encodeCall(Board.submitRollingBallot, (bytes32(root), record)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "another root"
        );
    }

    /// The file's decode rejections are refused with their codes and offsets,
    /// the step's own among them (`truncated` at 364).
    function test_Version5DecodeRejections() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        uint256 i;
        uint256 run;
        for (; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            if (!vm.keyExistsJson(json, string.concat(d, ".offset"))) continue;
            _refuse(
                abi.encodeCall(
                    Board.submitRollingBallot,
                    (bytes32(uint256(1)), _bytes(json, string.concat(d, ".encoding")))
                ),
                abi.encodeWithSelector(
                    BallotCheckLib.BallotMalformed.selector,
                    _decodeError(_str(json, string.concat(d, ".error"))),
                    vm.parseJsonUint(json, string.concat(d, ".offset"))
                ),
                _str(json, string.concat(d, ".id"))
            );
            run++;
        }
        assertEq(i, 9, "decode coverage");
        assertEq(run, 8, "decode rejections with an offset");
    }

    /// Each path takes only its own polls' ballots: a version-5 ballot on
    /// the ordinary call, and a ballot of an election pinning version 4 on
    /// the rolling call, are `unknown-version` at 2, after the pin, so a
    /// fixed poll's registered root is never replaced by a supplied one
    /// (T-04, T-25).
    function test_EachPathTakesOnlyItsOwnVersion() public {
        string memory json = vm.readFile(V5);
        string memory b = _ballot(json, "ok-newest-step");
        _registerKeySets(json, b);
        bytes memory record = _bytes(json, string.concat(b, ".encoding"));
        bytes memory unknown = abi.encodeWithSelector(
            BallotCheckLib.BallotMalformed.selector,
            ElectionDefinitionLib.DecodeError.UnknownVersion,
            2
        );
        _refuse(abi.encodeCall(Board.submitBallot, (record)), unknown, "ordinary call");
        _election(json, "rolling", 4);
        record[2] = 0x04;
        _refuse(
            abi.encodeCall(Board.submitRollingBallot, (bytes32(uint256(1)), record)),
            unknown,
            "rolling call"
        );
    }

    /// The window is the ordinary path's, by the block's timestamp, and is
    /// tested after the ballot check (`ballot-window`; close.md, Window).
    function test_TheWindowIsTheBlocksTimestamp() public {
        string memory json = vm.readFile(V5);
        string memory b = _ballot(json, "ok-newest-step");
        _registerKeySets(json, b);
        string memory ej = vm.readFile(EVENTS);
        (bytes32 root, bytes memory record) =
            _rolling(ej, _eventFields(ej, "rolling-ballot-ok-newest-step"));
        bytes32 h = bytes32(_slice(record, 3, 32));
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _parameters(json, "rolling", 5);
        p.opensAt = 1000;
        p.closesAt = 2000;
        elections.set(h, p, tiers, roots);
        bytes memory call = abi.encodeCall(Board.submitRollingBallot, (root, record));
        vm.warp(999);
        _refuse(call, abi.encodeWithSelector(Board.BallotWindow.selector, 999, 1000, 2000), "early");
        vm.warp(2001);
        _refuse(call, abi.encodeWithSelector(Board.BallotWindow.selector, 2001, 1000, 2000), "late");
        // A ballot the check refuses is refused for that, whatever the time.
        _refuse(
            abi.encodeCall(Board.submitRollingBallot, (bytes32(0), record)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
            ),
            "the check first"
        );
        vm.warp(2000);
        assertEq(_accept(call).length, 1, "at the close");
    }

    /// The calldata is the canonical encoding of the root's word and the
    /// record, nothing else: another offset, trailing bytes or nonzero
    /// padding are refused before the record is read (Calls; T-17).
    function test_NonCanonicalCalldataIsRefused() public {
        string memory json = vm.readFile(V5);
        _registerKeySets(json, _ballot(json, "ok-newest-step"));
        string memory ej = vm.readFile(EVENTS);
        (bytes32 root, bytes memory record) =
            _rolling(ej, _eventFields(ej, "rolling-ballot-ok-newest-step"));
        bytes memory call = abi.encodeCall(Board.submitRollingBallot, (root, record));
        bytes memory refused =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _refuse(bytes.concat(call, bytes1(0)), refused, "a trailing byte");
        _refuse(bytes.concat(call, bytes32(0)), refused, "a trailing word");
        // The record one word further on, which Solidity's decoder reads.
        bytes memory offset = bytes.concat(
            Board.submitRollingBallot.selector, root, bytes32(uint256(0x60)), bytes32(0)
        );
        offset = bytes.concat(offset, _slice(call, 4 + 64, call.length - 4 - 64));
        _refuse(offset, refused, "another offset");
        // The record's length isn't a multiple of 32, so its last word is padded.
        assertTrue(record.length % 32 != 0, "padded");
        bytes memory padding = bytes.concat(call);
        padding[padding.length - 1] = 0x01;
        _refuse(padding, refused, "nonzero padding");
        assertEq(_accept(call).length, 1, "the canonical call");
    }

    // --- helpers -------------------------------------------------------------

    /// The board's verdict on a ballot whose verifier admission code is
    /// `code`: `accepted`, or the code it refuses with. The validity proofs
    /// are the verifier's, and so is `root-step-range`: of the file's ballots
    /// naming a step the poll doesn't accept, the two whose proofs are
    /// against their own steps' trees ("its tree holds the member") pass the
    /// board's proof check, and the others' proofs (relabelled, or another
    /// ballot's) fail it.
    function _boardCode(string memory id, string memory code)
        internal
        pure
        returns (string memory)
    {
        if (_eq(code, "ok") || _eq(code, "option-proof") || _eq(code, "sum-proof")) {
            return "accepted";
        }
        if (_eq(code, "root-step-range")) {
            return _eq(id, "root-step-range-before-registration")
                || _eq(id, "root-step-range-after-close")
                ? "accepted"
                : "membership-proof";
        }
        return code;
    }

    /// One election of the file in the stubs, pinning ballot version
    /// `version`.
    function _election(string memory json, string memory e, uint8 version) internal {
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _parameters(json, e, version);
        bytes32 h = bytes32(_bytes(json, string.concat(".elections.", e, ".definitionHash")));
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, h, PANEL);
    }

    /// The parameters the election registry records for election `e` of the
    /// file, with a window holding every time: its panels and questions,
    /// and one cell per rolling tier with the root 0 (contracts.md, Election
    /// registry, Parameters).
    function _parameters(string memory json, string memory e, uint8 version)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        string memory k = string.concat(".elections.", e);
        p.ballotVersion = version;
        p.threshold = uint8(vm.parseJsonUint(json, string.concat(k, ".threshold")));
        p.panelSize = uint8(vm.parseJsonUint(json, string.concat(k, ".panelSize")));
        p.authorThreshold = uint8(vm.parseJsonUint(json, string.concat(k, ".authorThreshold")));
        p.authorPanelSize = uint8(vm.parseJsonUint(json, string.concat(k, ".authorPanelSize")));
        p.closesAt = type(uint64).max;
        uint256 n;
        while (vm.keyExistsJson(json, _at(string.concat(k, ".questions"), n, ""))) n++;
        p.questions = new ElectionRegistry.Question[](n);
        for (uint256 q; q < n; q++) {
            p.questions[q].method = 1;
            string memory jq = _at(string.concat(k, ".questions"), q, "");
            p.questions[q].optionCount =
                uint16(vm.parseJsonUint(json, string.concat(jq, ".optionCount")));
            p.questions[q].minSelections =
                uint16(vm.parseJsonUint(json, string.concat(jq, ".minSelections")));
            p.questions[q].maxSelections =
                uint16(vm.parseJsonUint(json, string.concat(jq, ".maxSelections")));
            p.optionCount += p.questions[q].optionCount;
        }
        n = 0;
        while (vm.keyExistsJson(json, _at(string.concat(k, ".cells"), n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 c; c < n; c++) {
            tiers[c] = uint8(vm.parseJsonUint(json, _at(string.concat(k, ".cells"), c, ".tier")));
        }
    }

    /// The ballot's two key sets, as the file registers them.
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

    /// The key of ballot-v5-records.json's ballot `id`.
    function _ballot(string memory json, string memory id) internal pure returns (string memory) {
        string[] memory ids = abi.decode(vm.parseJson(json, ".ballots[*].id"), (string[]));
        for (uint256 i; i < ids.length; i++) {
            if (_eq(ids[i], id)) return _at(".ballots", i, "");
        }
        revert(string.concat("no ballot ", id));
    }

    /// The `.fields` key of contract-event-v10.json's record `id`.
    function _eventFields(string memory ej, string memory id)
        internal
        pure
        returns (string memory)
    {
        string[] memory ids = abi.decode(vm.parseJson(ej, ".records[*].id"), (string[]));
        for (uint256 i; i < ids.length; i++) {
            if (_eq(ids[i], id)) return _at(".records", i, ".fields");
        }
        revert(string.concat("no event record ", id));
    }

    /// The supplied root and the record a `RollingBallotSubmitted` carries.
    function _rolling(string memory ej, string memory f)
        internal
        pure
        returns (bytes32 root, bytes memory record)
    {
        (root, record) = abi.decode(_bytes(ej, string.concat(f, ".data")), (bytes32, bytes));
    }

    /// The log is the file's record: its topics and its data.
    function _assertLog(string memory ej, string memory f, Vm.Log memory log, string memory id)
        internal
        pure
    {
        assertEq(log.topics.length, 3, string.concat("three topics for ", id));
        assertEq(log.topics[0], ROLLING_SUBMITTED, string.concat("topic 0 of ", id));
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

    /// Calls the board, requires success, and checks every log it emitted
    /// against its accumulator.
    function _accept(bytes memory data) internal returns (Vm.Log[] memory logs) {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.recordLogs();
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
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        (bool ok, bytes memory ret) = address(board).call(data);
        assertTrue(!ok, string.concat(what, ": accepted"));
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(after_, acc, "no event");
        assertEq(countAfter, count, "no count");
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
        if (c == keccak256("non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", s));
    }

    function _slice(bytes memory b, uint256 at, uint256 n) internal pure returns (bytes memory s) {
        s = new bytes(n);
        for (uint256 i; i < n; i++) {
            s[i] = b[at + i];
        }
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
