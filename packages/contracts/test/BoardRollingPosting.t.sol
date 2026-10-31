// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {DeliveryCheckLib} from "../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {BoardRollingFixture} from "./BoardRollingBallot.t.sol";
import {TrusteeFixture} from "./utils/TrusteeFixture.sol";
import {Vm} from "./utils/Vm.sol";

/// The board's rolling posting call and a rolling poll's other delivery
/// records (docs/spec/contracts.md, Board, Delivery records (ballot version
/// 5); P2-17 part 5d-3) against delivery-v5.json, whose generator shares no
/// code with the contracts or packages/crypto: rolling postings with real
/// membership proofs and ML-KEM ciphertexts, each case's supplied root and
/// the board's result or code, canonical and non-canonical calldata, and
/// version-2 receipts, complaints, batches and a root of a rolling poll. The
/// registries are stubs set from the files, each rolling cell with the
/// recorded root 0, as the election registry records it: the root a
/// posting's ballot is checked against is the one its sender supplies, and
/// the verifier, not the board, compares it with the step's (T-04, T-25,
/// T-38, T-54).
contract BoardRollingPostingTest is BoardRollingFixture {
    string internal constant DELIVERY = "../../docs/spec/vectors/delivery-v5.json";

    bytes32 internal constant SHARE_POSTED = keccak256("SharePosted(bytes32,bytes32,bytes)");

    /// The three elections of delivery-v5.json.
    bytes32 internal rolling;
    bytes32 internal defaultOnly;
    bytes32 internal fixedPoll;

    function setUp() public override {
        super.setUp();
        string memory dj = vm.readFile(DELIVERY);
        rolling = bytes32(_bytes(dj, ".elections.rolling.definitionHash"));
        defaultOnly = bytes32(_bytes(dj, ".elections.default-only.definitionHash"));
        fixedPoll = bytes32(_bytes(dj, ".elections.fixed.definitionHash"));
        // The rolling elections are ballot-v5-records.json's, with the
        // closing time delivery-v5.json gives them.
        string memory json = vm.readFile(V5);
        _closing(json, dj, "rolling");
        _closing(json, dj, "default-only");
        // The fixed poll, pinning ballot version 4: its shape is all a
        // posting's own steps read before the ballot check refuses the call.
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 4;
        p.optionCount = uint16(vm.parseJsonUint(dj, ".elections.fixed.optionTotal"));
        p.panelSize = uint8(vm.parseJsonUint(dj, ".elections.fixed.panelSize"));
        p.authorPanelSize = uint8(vm.parseJsonUint(dj, ".elections.fixed.authorPanelSize"));
        p.closesAt = type(uint64).max;
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(fixedPoll, p, tiers, roots);
        elections.setCeremony(fixedPoll, fixedPoll, PANEL);
        string[3] memory es = ["rolling", "default-only", "fixed"];
        for (uint256 e; e < 3; e++) {
            _registered(dj, string.concat(".elections.", es[e], ".registered"), es[e]);
            _keys(dj, es[e]);
        }
    }

    /// Every posting case of the file through its call, each on a fresh
    /// board: an accepted one emitted as `SharePosted` with the posting
    /// alone, its repeat the no-op; a refused one with the file's check,
    /// code and offset. The root is never emitted. The file runs in three
    /// parts, each within a block's gas.
    function test_PostingCases() public {
        string memory dj = vm.readFile(DELIVERY);
        uint256 count = abi.decode(vm.parseJson(dj, ".postings[*].id"), (string[])).length;
        assertEq(count, 36, "posting coverage");
        assertEq(_checkPostings(0, 12), 10, "accepted postings, first part");
    }

    function test_PostingCasesSecondPart() public {
        assertEq(_checkPostings(12, 24), 0, "accepted postings, second part");
    }

    function test_PostingCasesThirdPart() public {
        assertEq(_checkPostings(24, 36), 0, "accepted postings, third part");
    }

    function _checkPostings(uint256 from, uint256 to) internal returns (uint256 accepted) {
        uint256 fresh = vm.snapshotState();
        for (uint256 i = from; i < to; i++) {
            vm.revertToState(fresh);
            if (this.checkPosting(i)) accepted++;
        }
    }

    /// Posting case `i` of the file against the board; whether it was
    /// accepted.
    function checkPosting(uint256 i) external returns (bool) {
        string memory dj = vm.readFile(DELIVERY);
        string memory c = _at(".postings", i, "");
        string memory id = _str(dj, string.concat(c, ".id"));
        if (vm.keyExistsJson(dj, string.concat(c, ".registered"))) {
            string memory e = _str(dj, string.concat(_postingBallot(dj, c), ".election"));
            _registered(dj, string.concat(c, ".registered"), e);
        }
        if (vm.keyExistsJson(dj, string.concat(c, ".timestamp"))) {
            vm.warp(vm.parseJsonUint(dj, string.concat(c, ".timestamp")));
        }
        bytes memory posting = _bytes(dj, string.concat(c, ".posting"));
        bytes memory call = _postingCall(dj, c);
        if (vm.keyExistsJson(dj, string.concat(c, ".result"))) {
            assertTrue(_eq(_str(dj, string.concat(c, ".result")), "accepted"), id);
            Vm.Log[] memory logs = _accept(call);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            assertEq(logs[0].topics.length, 3, id);
            assertEq(logs[0].topics[0], SHARE_POSTED, id);
            assertEq(logs[0].topics[1], bytes32(_slice(posting, 3, 32)), "the posting's election");
            assertEq(logs[0].topics[2], bytes32(_slice(posting, 35, 32)), "the posting's ballot");
            assertEq(keccak256(logs[0].data), keccak256(abi.encode(posting)), "the posting alone");
            assertEq(_accept(call).length, 0, string.concat("a repeat of ", id));
            return true;
        }
        _refuse(call, _expected(dj, c), id);
        return false;
    }

    /// The file's canonical call is accepted and every other encoding of it
    /// refused, before anything is read: another offset
    /// for either argument, non-zero padding after either, a trailing word,
    /// a short call, and the rolling ballot call's selector over this
    /// call's arguments (Calls; T-17).
    function test_CalldataVectors() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory nonCanonical =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        assertEq(
            bytes4(vm.parseBytes(_str(dj, ".selectors.submitRollingPosting"))),
            Board.submitRollingPosting.selector,
            "selector"
        );
        uint256 fresh = vm.snapshotState();
        for (uint256 i; vm.keyExistsJson(dj, _at(".calldata", i, "")); i++) {
            vm.revertToState(fresh);
            string memory c = _at(".calldata", i, "");
            string memory id = _str(dj, string.concat(c, ".id"));
            bytes memory data = _bytes(dj, string.concat(c, ".calldata"));
            if (vm.parseJsonBool(dj, string.concat(c, ".canonical"))) {
                assertEq(_accept(data).length, 1, id);
            } else if (_eq(id, "first-offset")) {
                // The posting's length word is then read from the posting's
                // own first word, which runs it past the calldata: Solidity's
                // decoder refuses it before the board's check runs, with
                // empty revert data. Either way nothing is read or emitted.
                _refuse(data, "", id);
            } else {
                _refuse(data, nonCanonical, id);
            }
        }
    }

    /// Each offset word is checked on its own: with one argument's length
    /// word overlapping the other's, Solidity's decoder takes a layout whose
    /// total length is canonical but which frees a 32-byte gap, and only the
    /// offset checks refuse it, before anything is read. Both posting calls,
    /// so `submitPosting`'s zero-word case is covered too (Calls; T-17).
    function test_EachOffsetIsCheckedAlone() public {
        bytes memory nonCanonical =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        bytes32 gap = bytes32(uint256(0xabcd));
        bytes32 one = bytes32(uint256(32));
        bytes[2] memory heads = [
            abi.encodePacked(Board.submitRollingPosting.selector, bytes32(uint256(1))),
            abi.encodePacked(Board.submitPosting.selector)
        ];
        for (uint256 i; i < 2; i++) {
            uint256 h = heads[i].length - 4 + 64;
            // The first argument's offset one word late: its length word is
            // where its data would be, and its data is the second's length.
            _refuse(
                bytes.concat(heads[i], abi.encode(h + 32, h + 64, gap, one, one, gap)),
                nonCanonical,
                "the first offset alone"
            );
            // The second argument's offset one word early, onto the first's
            // data, leaving a trailing gap of canonical length.
            _refuse(
                bytes.concat(heads[i], abi.encode(h, h + 32, one, one, gap, gap)),
                nonCanonical,
                "the second offset alone"
            );
        }
    }

    /// The canonical call is the one `abi.encodeCall` writes for the file's
    /// first case, so the board takes exactly the call a client builds.
    function test_CanonicalCallIsTheStandardEncoding() public view {
        string memory dj = vm.readFile(DELIVERY);
        assertEq(
            keccak256(_postingCall(dj, _posting(dj, "ok-default-1"))),
            keccak256(_bytes(dj, _calldata(dj, "canonical"))),
            "the canonical call"
        );
    }

    /// A rolling poll's receipts, complaints, batches and root are version 2,
    /// as under ballot version 4, through their own calls, which take no
    /// root: each record of the file is accepted and emitted once, or
    /// refused with its check, code, position and offset (Delivery records
    /// (ballot version 5), Step 3; T-25, T-54).
    function test_RecordCases() public {
        string memory dj = vm.readFile(DELIVERY);
        uint256 fresh = vm.snapshotState();
        uint256 accepted;
        for (uint256 i; vm.keyExistsJson(dj, _at(".records", i, "")); i++) {
            vm.revertToState(fresh);
            string memory c = _at(".records", i, "");
            string memory id = _str(dj, string.concat(c, ".id"));
            bytes[] memory records = _bytesArray(dj, string.concat(c, ".records"));
            bytes memory call = _recordCall(_str(dj, string.concat(c, ".call")), records);
            if (vm.keyExistsJson(dj, string.concat(c, ".result"))) {
                Vm.Log[] memory logs = _accept(call);
                assertEq(logs.length, records.length, string.concat("one event per record, ", id));
                for (uint256 r; r < logs.length; r++) {
                    assertEq(
                        keccak256(logs[r].data), keccak256(abi.encode(records[r])), "the record"
                    );
                }
                assertEq(_accept(call).length, 0, string.concat("a repeat of ", id));
                accepted++;
            } else {
                _refuse(call, _expected(dj, c), id);
            }
        }
        assertEq(accepted, 8, "accepted record cases");
    }

    /// An accepted posting resent with another root, or with no root through
    /// `submitPosting`, is the no-op: a repeat is the posting's bytes alone,
    /// so no one can make it carry a root of their choosing. A front-runner's
    /// copy with another root, sent first, fails the proof and isn't
    /// remembered, so the honest call is accepted after it (T-25, T-38).
    function test_AFrontRunnersRootChangesNothing() public {
        string memory dj = vm.readFile(DELIVERY);
        string memory c = _posting(dj, "ok-default-1");
        (bytes32 root, bytes memory posting, bytes memory ballot) = _parts(dj, c);
        bytes32 other = bytes32(
            vm.parseUint(
                _str(dj, string.concat(_posting(dj, "membership-other-step-root"), ".root"))
            )
        );
        _refuse(
            abi.encodeCall(Board.submitRollingPosting, (other, posting, ballot)),
            _ballotRefused(BallotCheckLib.Code.MembershipProof),
            "the front-runner's root"
        );
        assertEq(
            _accept(abi.encodeCall(Board.submitRollingPosting, (root, posting, ballot))).length,
            1,
            "the honest call after it"
        );
        assertEq(
            _accept(abi.encodeCall(Board.submitRollingPosting, (other, posting, ballot))).length,
            0,
            "resent with another root"
        );
        assertEq(
            _accept(abi.encodeCall(Board.submitPosting, (posting, ballot))).length,
            0,
            "resent through submitPosting"
        );
    }

    /// Any root but the one the proof was made against is refused at the
    /// ballot's `membership-proof`, after every step of the posting itself,
    /// and archives nothing (T-04, T-38).
    function testFuzz_AnyOtherRootIsRefused(uint256 root) public {
        string memory dj = vm.readFile(DELIVERY);
        (bytes32 honest, bytes memory posting, bytes memory ballot) =
            _parts(dj, _posting(dj, "ok-author-2"));
        vm.assume(bytes32(root) != honest);
        _refuse(
            abi.encodeCall(Board.submitRollingPosting, (bytes32(root), posting, ballot)),
            _ballotRefused(BallotCheckLib.Code.MembershipProof),
            "another root"
        );
    }

    /// Changing any one byte of an accepted posting or of its ballot refuses
    /// the call or, for `m`, which nothing binds, is another posting that
    /// passes and is emitted as given: the only free bytes are `m`'s
    /// (Delivery records, What a sender controls; T-17).
    function testFuzz_OneByteChanged(uint256 at, uint8 flip, bool inBallot) public {
        string memory dj = vm.readFile(DELIVERY);
        (bytes32 root, bytes memory posting, bytes memory ballot) =
            _parts(dj, _posting(dj, "ok-default-2"));
        vm.assume(flip != 0);
        bytes memory changed = inBallot ? ballot : posting;
        at %= changed.length;
        changed[at] = changed[at] ^ bytes1(flip);
        bytes memory call = abi.encodeCall(Board.submitRollingPosting, (root, posting, ballot));
        (bool ok,) = address(board).call(call);
        // `m`, after the posting's version-2 seat, is the posting's only
        // field no step reads.
        bool free = !inBallot && at >= 69 && at < 101;
        assertTrue(ok == free, "only m is free");
    }

    /// Under a ballot version above 5 every record, a rolling posting
    /// included, is `unknown-version` at 2: the board reads no delivery
    /// version a ballot version it doesn't know fixes (Step 3).
    function test_ABallotVersionAboveFiveIsUnknown() public {
        string memory dj = vm.readFile(DELIVERY);
        string memory json = vm.readFile(V5);
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _parameters(json, "rolling", 6);
        elections.set(rolling, p, tiers, roots);
        bytes memory unknown = abi.encodeWithSelector(
            DeliveryCheckLib.DeliveryMalformed.selector,
            0,
            ElectionDefinitionLib.DecodeError.UnknownVersion,
            2
        );
        _refuse(_postingCall(dj, _posting(dj, "ok-default-1")), unknown, "a rolling posting");
        string[2] memory ids = ["receipt-default", "obligation-root"];
        for (uint256 i; i < 2; i++) {
            string memory c = _record(dj, ids[i]);
            _refuse(
                _recordCall(
                    _str(dj, string.concat(c, ".call")),
                    _bytesArray(dj, string.concat(c, ".records"))
                ),
                unknown,
                ids[i]
            );
        }
    }

    /// No personal data in the call, the event's data or its topics: the
    /// root is a field element, the posting's and ballot's bytes are the
    /// records' (contracts skill, No PII on-chain; T-17).
    function test_NoPersonalDataInCalldataOrEvents() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory call = _postingCall(dj, _posting(dj, "ok-author-1"));
        assertTrue(!_looksLikeText(call), "calldata");
        Vm.Log[] memory logs = _accept(call);
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        for (uint256 t; t < logs[0].topics.length; t++) {
            assertTrue(!_looksLikeText(abi.encode(logs[0].topics[t])), "event topic");
        }
    }

    /// Text in the root is refused: a root is a field element below `r`, and
    /// twelve printable bytes in its top bytes put it above (T-17).
    function test_TextAsTheRootIsRefused() public {
        string memory dj = vm.readFile(DELIVERY);
        (, bytes memory posting, bytes memory ballot) = _parts(dj, _posting(dj, "ok-default-1"));
        bytes32 textRoot = bytes32("alice@example.org, 1 Main St");
        assertTrue(_looksLikeText(abi.encode(textRoot)), "detector misses the root");
        _refuse(
            abi.encodeCall(Board.submitRollingPosting, (textRoot, posting, ballot)),
            _ballotRefused(BallotCheckLib.Code.MembershipProof),
            "text as the root"
        );
    }

    /// What a rolling posting costs against what the same posting would
    /// through `submitPosting` beside a registered root: the spec puts it at
    /// about a version-2 posting's (Delivery records (ballot version 5),
    /// Gas), and a block holds many.
    function test_Gas() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory call = _postingCall(dj, _posting(dj, "ok-default-1"));
        uint256 before = gasleft();
        _accept(call);
        uint256 used = before - gasleft();
        assertTrue(used < 600_000, "a rolling posting's gas");
    }

    // ---- helpers ----

    function _bytesArray(string memory dj, string memory key)
        internal
        pure
        returns (bytes[] memory out)
    {
        string[] memory hexes = vm.parseJsonStringArray(dj, key);
        out = new bytes[](hexes.length);
        for (uint256 i; i < hexes.length; i++) {
            out[i] = vm.parseBytes(hexes[i]);
        }
    }

    /// The call a posting case makes: its root, posting and ballot through
    /// `submitRollingPosting`, or the posting and ballot through
    /// `submitPosting`.
    function _postingCall(string memory dj, string memory c) internal view returns (bytes memory) {
        (bytes32 root, bytes memory posting, bytes memory ballot) = _parts(dj, c);
        if (_eq(_str(dj, string.concat(c, ".call")), "submitPosting")) {
            return abi.encodeCall(Board.submitPosting, (posting, ballot));
        }
        return abi.encodeCall(Board.submitRollingPosting, (root, posting, ballot));
    }

    function _parts(string memory dj, string memory c)
        internal
        view
        returns (bytes32 root, bytes memory posting, bytes memory ballot)
    {
        if (vm.keyExistsJson(dj, string.concat(c, ".root"))) {
            root = bytes32(vm.parseUint(_str(dj, string.concat(c, ".root"))));
        }
        posting = _bytes(dj, string.concat(c, ".posting"));
        ballot = _bytes(dj, string.concat(_postingBallot(dj, c), ".encoding"));
    }

    function _postingBallot(string memory dj, string memory c)
        internal
        pure
        returns (string memory)
    {
        return _find(dj, ".ballots", _str(dj, string.concat(c, ".ballot")));
    }

    function _posting(string memory dj, string memory id) internal pure returns (string memory) {
        return _find(dj, ".postings", id);
    }

    function _record(string memory dj, string memory id) internal pure returns (string memory) {
        return _find(dj, ".records", id);
    }

    function _calldata(string memory dj, string memory id) internal pure returns (string memory) {
        return string.concat(_find(dj, ".calldata", id), ".calldata");
    }

    function _find(string memory dj, string memory list, string memory id)
        internal
        pure
        returns (string memory)
    {
        string[] memory ids =
            abi.decode(vm.parseJson(dj, string.concat(list, "[*].id")), (string[]));
        for (uint256 i; i < ids.length; i++) {
            if (_eq(ids[i], id)) return _at(list, i, "");
        }
        revert(string.concat("no case ", id));
    }

    function _recordCall(string memory call, bytes[] memory records)
        internal
        pure
        returns (bytes memory)
    {
        if (_eq(call, "submitReceipts")) {
            bytes memory all;
            for (uint256 i; i < records.length; i++) {
                all = bytes.concat(all, records[i]);
            }
            return abi.encodeCall(Board.submitReceipts, (all));
        }
        require(records.length == 1, "one record");
        if (_eq(call, "submitComplaint")) {
            return abi.encodeCall(Board.submitComplaint, (records[0]));
        }
        if (_eq(call, "submitReceiptBatch")) {
            return abi.encodeCall(Board.submitReceiptBatch, (records[0]));
        }
        if (_eq(call, "submitComplaintBatch")) {
            return abi.encodeCall(Board.submitComplaintBatch, (records[0]));
        }
        if (_eq(call, "submitObligationRoot")) {
            return abi.encodeCall(Board.submitObligationRoot, (records[0]));
        }
        revert(string.concat("unknown call ", call));
    }

    /// The revert a refused case names: the delivery check's or the ballot
    /// check's, a decode error at its offset or a refusal's code.
    function _expected(string memory dj, string memory c) internal view returns (bytes memory) {
        string memory check = _str(dj, string.concat(c, ".check"));
        string memory code = _str(dj, string.concat(c, ".code"));
        bool decode = vm.keyExistsJson(dj, string.concat(c, ".offset"));
        uint256 position;
        if (vm.keyExistsJson(dj, string.concat(c, ".position"))) {
            position = vm.parseJsonUint(dj, string.concat(c, ".position"));
        }
        if (_eq(check, "ballot")) {
            if (decode) {
                return abi.encodeWithSelector(
                    BallotCheckLib.BallotMalformed.selector,
                    _decode(code),
                    vm.parseJsonUint(dj, string.concat(c, ".offset"))
                );
            }
            return _ballotRefused(_code(code));
        }
        assertTrue(_eq(check, "delivery"), "a check the file names");
        if (decode) {
            return abi.encodeWithSelector(
                DeliveryCheckLib.DeliveryMalformed.selector,
                position,
                _decode(code),
                vm.parseJsonUint(dj, string.concat(c, ".offset"))
            );
        }
        return abi.encodeWithSelector(
            DeliveryCheckLib.DeliveryRefused.selector, position, _deliveryCode(code)
        );
    }

    function _ballotRefused(BallotCheckLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, code);
    }

    function _decode(string memory s) internal pure returns (ElectionDefinitionLib.DecodeError) {
        if (_eq(s, "unknown-version")) return ElectionDefinitionLib.DecodeError.UnknownVersion;
        return _decodeError(s);
    }

    function _deliveryCode(string memory s) internal pure returns (DeliveryCheckLib.Code) {
        if (_eq(s, "delivery-stray")) return DeliveryCheckLib.Code.DeliveryStray;
        if (_eq(s, "delivery-seat")) return DeliveryCheckLib.Code.DeliverySeat;
        if (_eq(s, "delivery-signature")) return DeliveryCheckLib.Code.DeliverySignature;
        if (_eq(s, "posting-length")) return DeliveryCheckLib.Code.PostingLength;
        if (_eq(s, "posting-ballot")) return DeliveryCheckLib.Code.PostingBallot;
        if (_eq(s, "posting-hash")) return DeliveryCheckLib.Code.PostingHash;
        revert(string.concat("unknown delivery code ", s));
    }

    /// Election `e` of ballot-v5-records.json in the stubs, pinning ballot
    /// version 5, with delivery-v5.json's closing time.
    function _closing(string memory json, string memory dj, string memory e) internal {
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _parameters(json, e, 5);
        p.closesAt = uint64(vm.parseUint(_str(dj, string.concat(".elections.", e, ".closesAt"))));
        elections.set(
            bytes32(_bytes(dj, string.concat(".elections.", e, ".definitionHash"))), p, tiers, roots
        );
    }

    /// The default and author key sets at `key` (`default` and `author`
    /// seat lists) for the file's election `e`.
    function _registered(string memory dj, string memory key, string memory e) internal {
        bytes32 h = bytes32(_bytes(dj, string.concat(".elections.", e, ".definitionHash")));
        trustees.setKeySet(
            h, PANEL, _mask(vm.parseJsonUintArray(dj, string.concat(key, ".default")))
        );
        elections.setAuthorKeySet(
            h, _mask(vm.parseJsonUintArray(dj, string.concat(key, ".author")))
        );
    }

    /// Both panels' signing keys, as the file gives them, for election `e`.
    function _keys(string memory dj, string memory e) internal {
        bytes32 h = bytes32(_bytes(dj, string.concat(".elections.", e, ".definitionHash")));
        string[2] memory lists = [".seats.default", ".seats.author"];
        for (uint256 l; l < 2; l++) {
            for (uint256 i; vm.keyExistsJson(dj, _at(lists[l], i, "")); i++) {
                uint256 seat = vm.parseJsonUint(dj, _at(lists[l], i, ".seat"));
                (uint256 x, uint256 y, bool onCurve) =
                    TrusteeFixture.point(_bytes(dj, _at(lists[l], i, ".signingKey")));
                assertTrue(onCurve, "signing key");
                if (l == 0) trustees.setKey(h, PANEL, seat, x, y);
                else elections.setAuthorKey(h, seat, x, y);
            }
        }
    }
}
