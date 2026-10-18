// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheck, BallotCheckLib} from "../../src/BallotCheck.sol";
import {Board} from "../../src/Board.sol";
import {CanonicalCalldata} from "../../src/CanonicalCalldata.sol";
import {DeliveryCheckLib, IBoardElections, IBoardTrustees} from "../../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../../src/EventAccumulator.sol";
import {ElectionsStub, TrusteesStub} from "../utils/BoardFixture.sol";
import {DefinitionHarness} from "../utils/DefinitionHarness.sol";
import {TrusteeFixture} from "../utils/TrusteeFixture.sol";
import {TestBase, Vm} from "../utils/Vm.sol";

/// The board's checks as stateless calls, to re-run each emitted record
/// against the same registries.
contract BoardChecks {
    BallotCheck internal immutable checker = new BallotCheck();

    function receipt(bytes calldata r, IBoardElections e, IBoardTrustees t)
        external
        view
        returns (bytes32, bytes32)
    {
        return DeliveryCheckLib.checkReceipt(r, 0, e, t);
    }

    function complaint(bytes calldata r, IBoardElections e, IBoardTrustees t)
        external
        view
        returns (bytes32, bytes32)
    {
        return DeliveryCheckLib.checkComplaint(r, 0, e, t);
    }

    function posting(
        bytes calldata r,
        bytes calldata b,
        IBoardElections e,
        IBoardTrustees t,
        uint256 qualified
    ) external view returns (bytes32, bytes32) {
        return DeliveryCheckLib.checkPosting(r, b, e, t, checker, [qualified, 0]);
    }

    function receiptBatch(bytes calldata r, IBoardElections e, IBoardTrustees t)
        external
        view
        returns (bytes32, uint8)
    {
        return DeliveryCheckLib.checkReceiptBatch(r, e, t);
    }

    function complaintBatch(bytes calldata r, IBoardElections e, IBoardTrustees t)
        external
        view
        returns (bytes32, uint8)
    {
        return DeliveryCheckLib.checkComplaintBatch(r, e, t);
    }

    function root(bytes calldata r, IBoardElections e, IBoardTrustees t)
        external
        view
        returns (bytes32, uint8, uint8)
    {
        return DeliveryCheckLib.checkObligationRoot(r, e, t);
    }

    function ballot(bytes calldata r, IBoardElections e, uint256 qualified)
        external
        view
        returns (bytes32, bytes32)
    {
        (BallotCheckLib.Admitted memory a,) = BallotCheckLib.check(r, e, qualified, 0);
        return (a.definitionHash, a.ballotHash);
    }
}

/// The honest records the handler submits: delivery.json's three receipts
/// of all-receipted, its posting (with Alice's ballot record) and its
/// complaint, ballot.json's first, admitted, ballot, and delivery-batch.json's
/// receipt batches of one and three pairs and complaint batches of one and
/// two entries, with its complaint batch whose `D` frames but isn't a point,
/// which the board accepts (it frames, never decodes, T-53), and
/// delivery-root.json's roots: seat 1's two receipt roots, seat 2's
/// complaint root and its receipt root of 16,384 leaves.
struct Honest {
    bytes[3] receipts;
    bytes posting;
    bytes alice;
    bytes complaint;
    bytes ballot;
    bytes[2] receiptBatches;
    bytes[3] complaintBatches;
    bytes[4] roots;
}

/// Submits delivery.json's honest records and ballot.json's honest ballot,
/// alone, repeated and in receipt batches with repeats inside; postings with
/// any of four `m`s, carried by Alice's ballot record with any of four L1
/// references; one-byte changes of each record (outside a posting's `m`);
/// and receipt batches with one changed receipt among honest ones; both kinds
/// of batch record, alone, repeated and with one byte changed; and obligation
/// roots, alone, repeated, competing for one seat's slot and with one byte
/// changed. Postings
/// run with the pairing precompile mocked, as in Board.t.sol (no vector
/// pairs a real membership proof with ciphertexts); ballots run unmocked,
/// so their membership proof is real. Keeps a shadow of the accumulator
/// over exactly the logs emitted, the set of records accepted, and the
/// first outcome that broke a rule.
contract BoardHandler is TestBase {
    uint256 internal constant MAX_REFUSED = 16;

    Board public immutable board;
    IBoardElections internal immutable elections;
    IBoardTrustees internal immutable trustees;
    BoardChecks internal immutable checks;
    Honest internal honest;

    /// The root that filled each seat's slot for each kind, by keccak-256.
    mapping(uint8 seat => mapping(uint8 kind => bytes32)) public rootSlots;

    /// Records accepted, by keccak-256 of their bytes, and how many.
    mapping(bytes32 => bool) public accepted;
    uint256 public acceptedCount;
    /// How many logs carried each record.
    mapping(bytes32 => uint256) public emitted;
    /// The accumulator replayed over every log the board emitted.
    bytes32 public shadowAccumulator;
    uint64 public shadowCount;
    /// Refused calls, to submit again, and whether each needs the mock.
    bytes[] internal refusedCalls;
    bool[] internal refusedMocked;
    /// The first broken rule, if any.
    string public failure;

    uint256 public acceptedCalls;
    uint256 public refusedCallCount;
    uint256 public repeats;

    constructor(
        Board board_,
        IBoardElections elections_,
        IBoardTrustees trustees_,
        Honest memory honest_
    ) {
        board = board_;
        elections = elections_;
        trustees = trustees_;
        checks = new BoardChecks();
        honest = honest_;
        shadowAccumulator = EventAccumulatorLib.genesis(uint64(block.chainid), address(board_));
    }

    // --- actions ---------------------------------------------------------------

    /// One to four of the honest receipts, any of them repeated.
    function submitReceipts(uint256 seed) external {
        uint256 n = seed % 4 + 1;
        bytes memory batch;
        for (uint256 i; i < n; i++) {
            batch = bytes.concat(batch, honest.receipts[(seed >> (8 * (i + 1))) % 3]);
        }
        _expectAccepted(abi.encodeCall(Board.submitReceipts, (batch)), batch, 164, "", false);
    }

    function submitComplaint() external {
        _expectAccepted(
            abi.encodeCall(Board.submitComplaint, (honest.complaint)),
            honest.complaint,
            honest.complaint.length,
            "",
            false
        );
    }

    function submitBallot() external {
        _expectAccepted(
            abi.encodeCall(Board.submitBallot, (honest.ballot)),
            honest.ballot,
            honest.ballot.length,
            "",
            false
        );
    }

    /// The honest posting, or one with another of four `m`s, which is
    /// another posting the board accepts beside it; carried by Alice's
    /// ballot record with any of four L1 references, which its ballot hash
    /// doesn't bind, so a posting's repeat is its bytes alone.
    function submitPosting(uint8 mSeed, uint8 refSeed) external {
        bytes memory p = _posting(mSeed);
        bytes memory b = _alice(refSeed);
        _expectAccepted(abi.encodeCall(Board.submitPosting, (p, b)), p, p.length, b, true);
    }

    /// One byte of an honest record changed (a posting outside its `m`, the
    /// only field the board can't check): refused with the board's errors.
    function submitChanged(uint8 kind, uint256 position, uint8 delta) external {
        if (delta == 0) delta = 1;
        kind %= 4;
        bytes memory data;
        if (kind == 0) {
            bytes memory r = _changed(honest.receipts[position % 3], position >> 8, delta);
            data = abi.encodeCall(Board.submitReceipts, (r));
        } else if (kind == 1) {
            data = abi.encodeCall(
                Board.submitComplaint, (_changed(honest.complaint, position, delta))
            );
        } else if (kind == 2) {
            uint256 at = position % (honest.posting.length - 32);
            if (at >= DeliveryCheckLib.M_AT) at += 32;
            data = abi.encodeCall(
                Board.submitPosting, (_changed(honest.posting, at, delta), honest.alice)
            );
        } else {
            data = abi.encodeCall(Board.submitBallot, (_changed(honest.ballot, position, delta)));
        }
        _expectRefused(data, kind == 2, type(uint256).max);
    }

    /// A receipt batch (`kind` even) or complaint batch (odd), whole: one
    /// signature, one storage key and one event per batch.
    function submitBatch(uint8 kind, uint8 which) external {
        (bytes memory data, bytes memory record) = _batchCall(kind, which);
        _expectAccepted(data, record, record.length, "", false);
    }

    /// One byte of an honest batch changed: its seat, a pair or entry under
    /// the signature, the framing or the signature itself. Refused.
    function submitChangedBatch(uint8 kind, uint8 which, uint256 position, uint8 delta) external {
        if (delta == 0) delta = 1;
        (, bytes memory record) = _batchCall(kind, which);
        bytes memory changed = _changed(record, position, delta);
        bytes memory data = kind % 2 == 0
            ? abi.encodeCall(Board.submitReceiptBatch, (changed))
            : abi.encodeCall(Board.submitComplaintBatch, (changed));
        _expectRefused(data, false, type(uint256).max);
    }

    /// An honest root: accepted if its seat's slot for its kind is empty or
    /// holds it (a repeat, emitting nothing), and refused as `root-repeat`
    /// if another root filled it, leaving the accumulator as it was.
    function submitRoot(uint8 which) external {
        bytes memory record = honest.roots[which % 4];
        bytes memory data = abi.encodeCall(Board.submitObligationRoot, (record));
        uint8 seat = uint8(record[35]);
        uint8 kind = uint8(record[36]);
        bytes32 filled = rootSlots[seat][kind];
        if (filled == 0 || filled == keccak256(record)) {
            _expectAccepted(data, record, record.length, "", false);
            if (bytes(failure).length == 0) rootSlots[seat][kind] = keccak256(record);
            return;
        }
        bytes memory ret = _expectRefused(data, false, type(uint256).max);
        if (
            keccak256(ret)
                != keccak256(
                    abi.encodeWithSelector(
                        DeliveryCheckLib.DeliveryRefused.selector,
                        uint256(0),
                        DeliveryCheckLib.Code.RootRepeat
                    )
                )
        ) _fail("a second root of a filled slot isn't root-repeat");
    }

    /// One byte of an honest root changed: a field under the signature, the
    /// framing or the signature itself. Refused, whatever its slot holds.
    function submitChangedRoot(uint8 which, uint256 position, uint8 delta) external {
        if (delta == 0) delta = 1;
        bytes memory changed = _changed(honest.roots[which % 4], position, delta);
        _expectRefused(
            abi.encodeCall(Board.submitObligationRoot, (changed)), false, type(uint256).max
        );
    }

    /// Honest receipts with one changed receipt at position `at`: the whole
    /// batch is refused, naming `at`.
    function submitMixedBatch(uint256 seed, uint256 position, uint8 delta) external {
        if (delta == 0) delta = 1;
        uint256 n = seed % 4 + 1;
        uint256 at = (seed >> 8) % n;
        bytes memory batch;
        bool reframed;
        for (uint256 i; i < n; i++) {
            bytes memory r = honest.receipts[(seed >> (8 * (i + 2))) % 3];
            if (i == at) {
                r = _changed(r, position, delta);
                // A version byte changed to 2 frames that receipt as 165
                // bytes, so the call refuses the framing, naming none.
                reframed = r[2] == 0x02;
            }
            batch = bytes.concat(batch, r);
        }
        _expectRefused(
            abi.encodeCall(Board.submitReceipts, (batch)), false, reframed ? type(uint256).max : at
        );
    }

    /// Invariants 3 and 4 by probing: an honest record not yet accepted is
    /// still accepted (on a snapshot, which is then dropped), and a refused
    /// call is refused again, never a silent no-op.
    function probe(uint8 which, uint256 refusedSeed) external {
        (bytes memory data, bytes memory record, bool mocked) = _honestCall(which);
        if (!accepted[keccak256(record)]) {
            uint256 snapshot = vm.snapshotState();
            (bool ok,, Vm.Log[] memory logs) = _call(data, mocked);
            vm.revertToState(snapshot);
            if (!ok || logs.length != 1) _fail("an honest record became refusable");
        }
        if (refusedCalls.length != 0) {
            uint256 i = refusedSeed % refusedCalls.length;
            (bytes32 acc, uint64 count) = board.eventAccumulator();
            (bool ok,,) = _call(refusedCalls[i], refusedMocked[i]);
            (bytes32 accAfter, uint64 countAfter) = board.eventAccumulator();
            if (ok) _fail("a refused record was remembered");
            if (acc != accAfter || count != countAfter) _fail("a refusal moved the accumulator");
        }
    }

    // --- outcomes --------------------------------------------------------------

    /// `data` must be accepted, emitting one log for each record of `records`
    /// (`length` bytes each) not accepted before, in order, and nothing for a
    /// repeat. Each log is folded into the shadow and its record re-checked.
    function _expectAccepted(
        bytes memory data,
        bytes memory records,
        uint256 length,
        bytes memory ballot,
        bool mocked
    ) internal {
        uint256 expected;
        bytes32[] memory fresh = new bytes32[](records.length / length);
        for (uint256 i; i < fresh.length; i++) {
            bytes32 key = keccak256(_slice(records, i * length, length));
            bool seen = accepted[key];
            for (uint256 j; j < expected; j++) {
                if (fresh[j] == key) seen = true;
            }
            if (!seen) fresh[expected++] = key;
            else repeats++;
        }
        (bool ok, bytes memory ret, Vm.Log[] memory logs) = _call(data, mocked);
        if (!ok) {
            _fail(string.concat("an honest call was refused: ", vm.toString(ret)));
            return;
        }
        acceptedCalls++;
        if (logs.length != expected) _fail("not one log per new record");
        for (uint256 i; i < logs.length; i++) {
            bytes memory record = abi.decode(logs[i].data, (bytes));
            bytes32 key = keccak256(record);
            if (i < expected && key != fresh[i]) _fail("a log out of order");
            if (emitted[key]++ != 0) _fail("a record emitted twice");
            if (!accepted[key]) {
                accepted[key] = true;
                acceptedCount++;
            }
            if (logs[i].emitter != address(board)) _fail("another emitter");
            _recheck(logs[i].topics[0], record, ballot, mocked);
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

    /// `data` must be refused with one of the board's errors, naming record
    /// `at` of a batch unless `at` is the maximum, and leave the accumulator.
    function _expectRefused(bytes memory data, bool mocked, uint256 at)
        internal
        returns (bytes memory ret)
    {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        bool ok;
        (ok, ret,) = _call(data, mocked);
        (bytes32 accAfter, uint64 countAfter) = board.eventAccumulator();
        if (ok) {
            _fail("a changed record was accepted");
            return ret;
        }
        refusedCallCount++;
        if (acc != accAfter || count != countAfter) _fail("a refusal moved the accumulator");
        bytes4 s = bytes4(ret);
        bool delivery = s == DeliveryCheckLib.DeliveryMalformed.selector
            || s == DeliveryCheckLib.DeliveryRefused.selector;
        if (
            !delivery && s != Board.ReceiptBatchLength.selector
                && s != BallotCheckLib.BallotMalformed.selector
                && s != BallotCheckLib.BallotRefused.selector
                && s != CanonicalCalldata.NonCanonicalCalldata.selector
        ) _fail(string.concat("an unexpected revert: ", vm.toString(ret)));
        if (at != type(uint256).max && (!delivery || uint256(_word(ret, 4)) != at)) {
            _fail("a batch refusal names another receipt");
        }
        if (refusedCalls.length < MAX_REFUSED) {
            refusedCalls.push(data);
            refusedMocked.push(mocked);
        }
    }

    /// An emitted record passes its stateless check against the registries
    /// the board pins (invariant 2).
    function _recheck(bytes32 topic, bytes memory record, bytes memory ballot, bool mocked)
        internal
    {
        if (mocked) vm.mockCall(address(8), "", abi.encode(uint256(1)));
        bool ok;
        if (topic == Board.ObligationRootSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.root, (record, elections, trustees)));
        } else if (topic == Board.ShareReceiptBatchSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.receiptBatch, (record, elections, trustees)));
        } else if (topic == Board.ShareComplaintBatchSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.complaintBatch, (record, elections, trustees)));
        } else if (topic == Board.ShareReceiptSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.receipt, (record, elections, trustees)));
        } else if (topic == Board.ShareComplaintSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.complaint, (record, elections, trustees)));
        } else if (topic == Board.SharePosted.selector) {
            (ok,) = address(checks)
                .call(
                    abi.encodeCall(
                        BoardChecks.posting,
                        (record, ballot, elections, trustees, _qualified(ballot))
                    )
                );
        } else if (topic == Board.BallotSubmitted.selector) {
            (ok,) = address(checks)
                .call(abi.encodeCall(BoardChecks.ballot, (record, elections, _qualified(record))));
        }
        if (mocked) vm.clearMockedCalls();
        if (!ok) _fail("an emitted record fails its check");
    }

    function _call(bytes memory data, bool mocked)
        internal
        returns (bool ok, bytes memory ret, Vm.Log[] memory logs)
    {
        if (mocked) vm.mockCall(address(8), "", abi.encode(uint256(1)));
        vm.recordLogs();
        (ok, ret) = address(board).call(data);
        logs = vm.getRecordedLogs();
        if (mocked) vm.clearMockedCalls();
    }

    /// The key set of the ceremony of the election a ballot names.
    function _qualified(bytes memory ballot) internal view returns (uint256 seats) {
        (bytes32 stub, bytes32 panel) = elections.ceremony(bytes32(_word(ballot, 3)));
        (, seats) = trustees.keySetOf(stub, panel);
    }

    /// Honest record `which`: a receipt, the complaint, the ballot, or the
    /// posting with one of its four `m`s.
    function _honestCall(uint8 which)
        internal
        view
        returns (bytes memory data, bytes memory record, bool mocked)
    {
        which %= 14;
        if (which >= 9) {
            (data, record) = _batchCall(which - 9, (which - 9) / 2);
            return (data, record, false);
        }
        if (which < 3) {
            record = honest.receipts[which];
            data = abi.encodeCall(Board.submitReceipts, (record));
        } else if (which == 3) {
            record = honest.complaint;
            data = abi.encodeCall(Board.submitComplaint, (record));
        } else if (which == 4) {
            record = honest.ballot;
            data = abi.encodeCall(Board.submitBallot, (record));
        } else {
            record = _posting(which - 5);
            data = abi.encodeCall(Board.submitPosting, (record, honest.alice));
            mocked = true;
        }
    }

    /// Honest batch `which` of the receipt (`kind` even) or complaint kind.
    function _batchCall(uint8 kind, uint8 which)
        internal
        view
        returns (bytes memory data, bytes memory record)
    {
        if (kind % 2 == 0) {
            record = honest.receiptBatches[which % 2];
            data = abi.encodeCall(Board.submitReceiptBatch, (record));
        } else {
            record = honest.complaintBatches[which % 3];
            data = abi.encodeCall(Board.submitComplaintBatch, (record));
        }
    }

    /// The honest posting (`seed % 4 == 0`) or one with another `m`.
    function _posting(uint256 seed) internal view returns (bytes memory p) {
        p = bytes.concat(honest.posting);
        if (seed % 4 == 0) return p;
        bytes32 m = keccak256(abi.encode("m", seed % 4));
        for (uint256 i; i < 32; i++) {
            p[DeliveryCheckLib.M_AT + i] = m[i];
        }
    }

    /// Alice's ballot record with one of four L1 references.
    function _alice(uint256 seed) internal view returns (bytes memory b) {
        b = bytes.concat(honest.alice);
        b[BallotCheckLib.L1_NUMBER_AT + 7] = bytes1(uint8(seed % 4));
    }

    function _changed(bytes memory r, uint256 position, uint8 delta)
        internal
        pure
        returns (bytes memory c)
    {
        c = bytes.concat(r);
        position %= c.length;
        c[position] = bytes1(uint8(c[position]) ^ delta);
    }

    function _fail(string memory why) internal {
        if (bytes(failure).length == 0) failure = why;
    }

    function _word(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 32; i++) {
            v = (v << 8) | (o + i < r.length ? uint8(r[o + i]) : 0);
        }
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
/// Board, Calls and Events; T-25, T-17, T-54):
/// 1. The accumulator's count equals the number of distinct records the
///    board accepted, and its value equals the shadow's replay of the step
///    over exactly the logs the board emitted: a byte-identical repeat, by
///    any call and inside a batch or across batches, emits nothing and
///    leaves the accumulator as it was.
/// 2. Every emitted record passes its stateless check against the
///    registries the board pins, and no record is emitted twice.
/// All four hold for the two batch calls too: a receipt or complaint batch
/// is one record, remembered by its bytes and emitted once as its own event
/// (`ShareReceiptBatchSubmitted`, `ShareComplaintBatchSubmitted`); and the
/// first three for obligation roots (`ObligationRootSubmitted`).
/// 3. A record is remembered only if it was emitted: a refused call leaves
///    the accumulator unchanged, and submitting it again is refused again,
///    never a silent no-op.
/// 4. Accepting a record never makes another passing record fail: an
///    honest record not yet submitted is still accepted after any sequence.
///    The one exception is the obligation root, which fills its seat's slot
///    for its kind: after it, exactly the other roots of that seat and kind
///    are refused, as `root-repeat` (delivery.md, Obligation root), and
///    every other root is still accepted.
/// Each is checked by the handler as it goes (its `failure`), and 1 again
/// here against the board's storage.
contract BoardInvariantTest is TestBase {
    string internal constant DELIVERY = "../../docs/spec/vectors/delivery.json";
    string internal constant V1 = "../../docs/spec/vectors/ballot.json";
    string internal constant BATCHES = "../../docs/spec/vectors/delivery-batch.json";
    string internal constant ROOTS = "../../docs/spec/vectors/delivery-root.json";
    bytes32 internal constant STUB = keccak256("delivery stub");
    bytes32 internal constant STUB_V1 = keccak256("ballot stub");
    bytes32 internal constant PANEL = keccak256("panel");

    Board internal board;
    BoardHandler internal handler;

    function setUp() public {
        ElectionsStub elections = new ElectionsStub();
        TrusteesStub trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), address(0x4E1A));
        Honest memory honest;
        string memory bj = vm.readFile(V1);
        honest.ballot = vm.parseBytes(vm.parseJsonString(bj, ".ballots[0].encoding"));
        _setBallotElection(bj, elections, trustees);
        _setDeliveryElection(vm.readFile(DELIVERY), elections, trustees, honest);
        _setBatches(vm.readFile(BATCHES), honest);
        _setRoots(vm.readFile(ROOTS), honest);
        handler = new BoardHandler(board, elections, trustees, honest);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_NoRuleBroken() public view {
        assertTrue(bytes(handler.failure()).length == 0, handler.failure());
    }

    function invariant_CountIsTheDistinctRecordsAccepted() public view {
        (, uint64 count) = board.eventAccumulator();
        assertEq(count, handler.acceptedCount(), "count");
        assertEq(count, handler.shadowCount(), "shadow count");
    }

    function invariant_AccumulatorIsTheShadowReplay() public view {
        (bytes32 acc,) = board.eventAccumulator();
        assertEq(acc, handler.shadowAccumulator(), "accumulator");
    }

    // --- setup -----------------------------------------------------------------

    /// ballot.json's plurality election, its first ballot's key set.
    function _setBallotElection(string memory bj, ElectionsStub elections, TrusteesStub trustees)
        internal
    {
        ElectionDefinitionLib.Definition memory d = new DefinitionHarness()
            .decode(vm.parseBytes(vm.parseJsonString(bj, ".elections.plurality.definition")));
        ElectionRegistry.Parameters memory p;
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.optionCount = d.optionCount;
        (p.opensAt, p.closesAt) = (d.opensAt, d.closesAt);
        // Inside the window, so the honest ballot is accepted.
        vm.warp(d.opensAt);
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] =
            ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        for (uint256 i; i < d.pinTypes.length; i++) {
            if (d.pinTypes[i] == 2) p.ballotVersion = d.pinVersions[i];
        }
        uint256 n;
        while (vm.keyExistsJson(bj, _at(".elections.plurality.tiers", n, ""))) n++;
        uint8[] memory tiers = new uint8[](n);
        uint256[] memory roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            tiers[i] = uint8(vm.parseJsonUint(bj, _at(".elections.plurality.tiers", i, ".tier")));
            roots[i] =
                vm.parseUint(vm.parseJsonString(bj, _at(".elections.plurality.tiers", i, ".root")));
        }
        bytes32 h =
            bytes32(vm.parseBytes(vm.parseJsonString(bj, ".elections.plurality.definitionHash")));
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, STUB_V1, PANEL);
        trustees.setKeySet(
            STUB_V1, PANEL, _mask(vm.parseJsonUintArray(bj, ".ballots[0].registered"))
        );
    }

    /// delivery.json's election, as Board.t.sol sets it: the parameters
    /// Alice's committed vote has its shape under, one cell of tier 0, the
    /// key set of all-receipted with the panel's signing keys, and the
    /// honest records, Alice's ballot record carrying ballot.json's proof.
    function _setDeliveryElection(
        string memory dj,
        ElectionsStub elections,
        TrusteesStub trustees,
        Honest memory honest
    ) internal {
        bytes32 h = bytes32(vm.parseBytes(vm.parseJsonString(dj, ".definitionHash")));
        string memory e = ".elections[0]";
        assertTrue(_is(dj, string.concat(e, ".id"), "all-receipted"), "all-receipted");
        assertTrue(_is(dj, ".records[1].id", "posting"), "the posting");
        assertTrue(_is(dj, ".records[2].id", "complaint"), "the complaint");
        string memory a = string.concat(e, ".ballots[0]");
        bytes memory vote =
            vm.parseBytes(vm.parseJsonString(dj, string.concat(a, ".committedVote")));
        _setDeliveryRegistries(dj, h, vote, elections, trustees);
        for (uint256 i; i < 3; i++) {
            honest.receipts[i] = vm.parseBytes(
                vm.parseJsonString(dj, _at(string.concat(e, ".entries"), i, ".payload"))
            );
        }
        honest.posting = vm.parseBytes(vm.parseJsonString(dj, ".records[1].encoding"));
        honest.complaint = vm.parseBytes(vm.parseJsonString(dj, ".records[2].encoding"));
        honest.alice = abi.encodePacked(
            uint16(0x0002),
            uint8(1),
            h,
            uint8(vm.parseJsonUint(dj, string.concat(a, ".tier"))),
            vm.parseUint(vm.parseJsonString(dj, string.concat(a, ".nullifier"))),
            uint64(7_000_000),
            keccak256("l1 block"),
            _slice(
                honest.ballot,
                BallotCheckLib.PROOF_AT,
                BallotCheckLib.VOTE_AT - BallotCheckLib.PROOF_AT
            ),
            vote
        );
    }

    /// delivery-batch.json's batches, made from delivery.json's panel and
    /// definition, so the stubs set from delivery.json check them.
    function _setBatches(string memory bj, Honest memory honest) internal {
        assertTrue(_is(bj, ".records[0].id", "one-pair"), "one-pair");
        assertTrue(_is(bj, ".records[1].id", "three-pairs"), "three-pairs");
        for (uint256 i; i < 2; i++) {
            honest.receiptBatches[i] =
                vm.parseBytes(vm.parseJsonString(bj, _at(".records", i, ".encoding")));
            honest.complaintBatches[i] =
                vm.parseBytes(vm.parseJsonString(bj, _at(".complaintRecords", i, ".encoding")));
        }
        for (uint256 i; vm.keyExistsJson(bj, _at(".complaintDecode", i, "")); i++) {
            if (_is(bj, _at(".complaintDecode", i, ".id"), "d-not-a-point")) {
                honest.complaintBatches[2] =
                    vm.parseBytes(vm.parseJsonString(bj, _at(".complaintDecode", i, ".encoding")));
            }
        }
        assertTrue(honest.complaintBatches[2].length != 0, "d-not-a-point");
    }

    /// delivery-root.json's first four roots, made from delivery.json's panel
    /// and definition: two of seat 1's receipt kind, one of seat 2's
    /// complaint kind and one of its receipt kind.
    function _setRoots(string memory rj, Honest memory honest) internal {
        string[4] memory ids = ["receipt-root", "one-leaf", "complaint-root", "one-block"];
        for (uint256 i; i < 4; i++) {
            assertTrue(_is(rj, _at(".records", i, ".id"), ids[i]), ids[i]);
            honest.roots[i] = vm.parseBytes(vm.parseJsonString(rj, _at(".records", i, ".encoding")));
        }
    }

    /// delivery.json's election in the stubs: the parameters Alice's
    /// committed vote has its shape under, one cell of tier 0 with root 1,
    /// and all-receipted's key set with the panel's signing keys.
    function _setDeliveryRegistries(
        string memory dj,
        bytes32 h,
        bytes memory vote,
        ElectionsStub elections,
        TrusteesStub trustees
    ) internal {
        string memory e = ".elections[0]";
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(h, _shape(vote), tiers, roots);
        elections.setCeremony(h, STUB, PANEL);
        trustees.setKeySet(
            STUB, PANEL, _mask(vm.parseJsonUintArray(dj, string.concat(e, ".registered")))
        );
        _setSigningKeys(dj, trustees);
    }

    /// The delivery panel's signing keys, by seat.
    function _setSigningKeys(string memory dj, TrusteesStub trustees) internal {
        for (uint256 i; vm.keyExistsJson(dj, _at(".panel", i, "")); i++) {
            (uint256 x, uint256 y,) = TrusteeFixture.point(
                vm.parseBytes(vm.parseJsonString(dj, _at(".panel", i, ".signingKey")))
            );
            trustees.setKey(STUB, PANEL, vm.parseJsonUint(dj, _at(".panel", i, ".seat")), x, y);
        }
    }

    /// As Board.t.sol's `_shape`: ballot version 1, `k`, `n`, `T` and one
    /// question whose range is the sum proof's branch count.
    function _shape(bytes memory vote)
        internal
        pure
        returns (ElectionRegistry.Parameters memory p)
    {
        uint256 options = _u32(vote, 0);
        uint256 o = 4;
        uint256 k = _u32(vote, o);
        for (uint256 j; j < options; j++) {
            o += 4 + 32 * _u32(vote, o);
        }
        uint256 n = _u32(vote, o);
        o += 4 + 32 * n;
        o += 4 + 128 * _u32(vote, o);
        p.ballotVersion = 1;
        p.threshold = uint8(k);
        p.panelSize = uint8(n);
        p.optionCount = uint16(options);
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] = ElectionRegistry.Question(1, uint16(options), 0, uint16(_u32(vote, o) - 1));
    }

    function _is(string memory json, string memory key, string memory value)
        internal
        pure
        returns (bool)
    {
        return keccak256(bytes(vm.parseJsonString(json, key))) == keccak256(bytes(value));
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    function _u32(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 4; i++) {
            v = (v << 8) | uint8(r[o + i]);
        }
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

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }
}
