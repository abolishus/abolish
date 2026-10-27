// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {AvailabilityCheckLib} from "../src/AvailabilityCheck.sol";
import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {DeliveryCheckLib} from "../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {BallotHarness} from "./utils/BallotHarness.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {TrusteeFixture} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's version-2 share receipts, postings and complaints, which
/// ballot version 4 fixes (docs/spec/contracts.md, Board, Delivery records
/// (version 2); docs/spec/delivery.md, Version 2), against delivery-v2.json
/// (both panels' records and decode rejections), contract-event-v9.json (the
/// events the board emits for them) and intake-v4.json (version-4 ballots
/// with real membership proofs and each seat's ciphertext), all from
/// independent generators, and delivery-batch-v2.json (both panels' batches
/// and roots). A record names its panel, and is judged only
/// against that panel's key set, signing keys and share hashes: the default
/// panel's from the trustee registry, the author panel's from the election
/// registry, never from a submitter (T-25, T-37, T-54, T-31).
contract BoardDeliveryV2Test is TestBase {
    string internal constant DELIVERY = "../../docs/spec/vectors/delivery-v2.json";
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v9.json";
    string internal constant INTAKE = "../../docs/spec/vectors/intake-v4.json";
    string internal constant BALLOTS = "../../docs/spec/vectors/ballot-v4-records.json";
    string internal constant BATCHES = "../../docs/spec/vectors/delivery-batch-v2.json";
    string internal constant OBLIGATION = "../../docs/spec/vectors/delivery-obligation.json";
    string internal constant ROOTS = "../../docs/spec/vectors/delivery-root.json";

    bytes32 internal constant RECEIPT_SUBMITTED =
        keccak256("ShareReceiptSubmitted(bytes32,bytes32,bytes)");
    bytes32 internal constant SHARE_POSTED = keccak256("SharePosted(bytes32,bytes32,bytes)");
    bytes32 internal constant COMPLAINT_SUBMITTED =
        keccak256("ShareComplaintSubmitted(bytes32,bytes32,bytes)");
    bytes32 internal constant BATCH_SUBMITTED =
        keccak256("ShareReceiptBatchSubmitted(bytes32,uint8,bytes)");
    bytes32 internal constant COMPLAINT_BATCH_SUBMITTED =
        keccak256("ShareComplaintBatchSubmitted(bytes32,uint8,bytes)");
    bytes32 internal constant ROOT_SUBMITTED =
        keccak256("ObligationRootSubmitted(bytes32,uint8,bytes)");
    bytes32 internal constant ATTESTATION_SUBMITTED =
        keccak256("AvailabilityAttestationSubmitted(bytes32,uint8,bytes)");

    /// The ceremony the stubs record each election's default key set under.
    bytes32 internal constant PANEL = keccak256("panel");
    address internal constant RELAY = address(0x4E1A);

    /// Version 2's offsets (Delivery records (version 2), Step 4).
    uint256 internal constant PANEL_AT = 67;
    uint256 internal constant SEAT_AT = 68;
    uint256 internal constant RECEIPT_SIG_AT = 101;
    uint256 internal constant COMPLAINT_SIG_AT = 165;
    /// A version-2 batch's or root's `panel` and `seat`.
    uint256 internal constant BATCH_PANEL_AT = 35;
    uint256 internal constant BATCH_SEAT_AT = 36;
    /// Gas the forced path's figures keep back over a version-2 call
    /// measured against the stubs, for what real registries cost more
    /// (test_ForcedPathCallGas): about 2,000 for version 1's batch and root
    /// calls, measured as here without Solidity's copy of the calldata, so
    /// this leaves a real registry's layout ten times that and more.
    uint256 internal constant HEADROOM = 30_000;

    ElectionsStub internal elections;
    TrusteesStub internal trustees;
    Board internal board;
    BallotHarness internal ballots;
    DefinitionHarness internal defs;

    /// delivery-v2.json's election, and Alice's version-4 ballot record in it.
    bytes32 internal h;
    bytes internal alice;
    /// Each seat's signing secret and key, by panel (1 default, 2 author).
    mapping(uint256 panel => mapping(uint256 seat => uint256)) internal secrets;
    mapping(uint256 panel => mapping(uint256 seat => uint256[2])) internal keys;
    bytes internal receiptDs;
    bytes internal complaintDs;

    function setUp() public {
        string memory dj = vm.readFile(DELIVERY);
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), RELAY);
        ballots = new BallotHarness();
        defs = new DefinitionHarness();

        h = _b32(dj, ".elections[0].definitionHash");
        assertTrue(_eq(_str(dj, ".elections[0].id"), "all-receipted"), "the election");
        alice = _alice(dj);
        (ElectionRegistry.Parameters memory p) = _shape(alice);
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, h, PANEL);
        trustees.setKeySet(h, PANEL, _mask(vm.parseJsonUintArray(dj, ".elections[0].registered")));
        elections.setAuthorKeySet(
            h, _mask(vm.parseJsonUintArray(dj, ".elections[0].authorRegistered"))
        );
        _seats(dj, ".seats.default", 1);
        _seats(dj, ".seats.author", 2);
        receiptDs = _ds(_str(dj, ".tags.receipt"));
        complaintDs = _ds(_str(dj, ".tags.complaint"));
    }

    function test_VectorFileFormats() public view {
        assertTrue(
            _eq(_str(vm.readFile(DELIVERY), ".format"), "abolish-delivery-vectors/2"), "delivery"
        );
        assertTrue(_eq(_str(vm.readFile(INTAKE), ".format"), "abolish-intake-vectors/2"), "intake");
    }

    /// Every record of delivery-v2.json, of both panels, is accepted through
    /// its call and emitted exactly as contract-event-v9.json records it;
    /// a repeat emits nothing (Calls, Repeats). Postings carry Alice's
    /// record with the pairing precompile mocked, since the file's ballots
    /// carry no membership proof; test_IntakePostings runs real ones.
    function test_RecordsWithTheirEvents() public {
        string memory dj = vm.readFile(DELIVERY);
        string memory ej = vm.readFile(EVENTS);
        _mockPairing();
        uint256 i;
        for (; vm.keyExistsJson(dj, _at(".records", i, "")); i++) {
            string memory r = _at(".records", i, "");
            string memory id = _str(dj, string.concat(r, ".id"));
            string memory t = _str(dj, string.concat(r, ".type"));
            bytes memory record = _bytes(dj, string.concat(r, ".encoding"));
            assertEq(uint8(record[PANEL_AT]), vm.parseJsonUint(dj, string.concat(r, ".panel")), id);
            bytes memory call_ = _call(t, record);
            Vm.Log[] memory logs = _accept(call_);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            _assertLog(
                ej, _eventFields(ej, string.concat("delivery-v2-", id)), logs[0], _topic(t), id
            );
            assertEq(_accept(call_).length, 0, string.concat("a repeat of ", id));
        }
        assertEq(i, 6, "record coverage");
    }

    /// Both panels' receipts in one call, each framed as 165 bytes by its
    /// version byte and emitted in order; a version-1 receipt's 164 bytes
    /// after them are framed by theirs and refused as the record they are,
    /// naming their position; a length no framing ends at is refused whole.
    function test_ReceiptsFramedByVersion() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory d = _record(dj, "receipt-default");
        bytes memory a = _record(dj, "receipt-author");
        Vm.Log[] memory logs = _accept(_receiptsCall(bytes.concat(d, a)));
        assertEq(logs.length, 2, "both receipts");
        assertEq(keccak256(abi.decode(logs[0].data, (bytes))), keccak256(d), "the default first");
        assertEq(keccak256(abi.decode(logs[1].data, (bytes))), keccak256(a), "then the author's");

        bytes memory v1 = _decode(dj, "receipt-v1-bytes");
        assertEq(v1.length, 164, "a version-1 receipt");
        _refuse(
            _receiptsCall(bytes.concat(d, a, v1)),
            abi.encodeWithSelector(
                DeliveryCheckLib.DeliveryMalformed.selector,
                2,
                ElectionDefinitionLib.DecodeError.ProfileMismatch,
                2
            ),
            "a version-1 receipt under ballot version 4"
        );
        bytes memory short_ = _slice(a, 0, 164);
        _refuse(
            _receiptsCall(bytes.concat(d, short_)),
            abi.encodeWithSelector(Board.ReceiptBatchLength.selector, 329),
            "a version-2 receipt one byte short"
        );
        _refuse(
            _receiptsCall(bytes.concat(d, hex"000c")),
            abi.encodeWithSelector(Board.ReceiptBatchLength.selector, 167),
            "a remainder with no version byte"
        );
    }

    /// delivery-v2.json's decode rejections, each refused with its code at
    /// the offset Delivery records (version 2) gives. A receipt whose length
    /// isn't its version's is refused by the call's framing first; framed at
    /// its version's length, its header still says what it is.
    function test_DecodeVectors() public {
        string memory dj = vm.readFile(DELIVERY);
        uint256 i;
        for (; vm.keyExistsJson(dj, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            string memory id = _str(dj, string.concat(d, ".id"));
            string memory t = _str(dj, string.concat(d, ".type"));
            bytes memory enc = _bytes(dj, string.concat(d, ".encoding"));
            ElectionDefinitionLib.DecodeError code =
                _decodeError(_str(dj, string.concat(d, ".error")));
            if (_eq(t, "share-receipt")) {
                uint256 framed = enc.length > 2 && enc[2] == 0x02 ? 165 : 164;
                if (enc.length != framed) {
                    _refuse(
                        _receiptsCall(enc),
                        abi.encodeWithSelector(Board.ReceiptBatchLength.selector, enc.length),
                        id
                    );
                    // Only a version byte that frames another length says
                    // more in a framed record: its version, refused before
                    // any field.
                    if (code != ElectionDefinitionLib.DecodeError.ProfileMismatch) continue;
                    enc = _slice(enc, 0, framed);
                }
            }
            _refuse(
                _call(t, enc),
                abi.encodeWithSelector(
                    DeliveryCheckLib.DeliveryMalformed.selector, 0, code, _offset(id, enc)
                ),
                id
            );
        }
        assertEq(i, 21, "decode coverage");
    }

    /// The panel byte decides the key set: an author seat's record is
    /// refused once the election registry's author key set lacks its seat,
    /// or holds none, whatever the default key set says; a default seat's
    /// record once the trustee registry's lacks its seat, whatever the
    /// author set says. Seat 0 fails in either panel (T-37).
    function test_EachPanelsKeySet() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory a = _record(dj, "receipt-author");
        bytes memory d = _record(dj, "receipt-default");
        bytes memory c = _record(dj, "complaint-author");
        bytes memory seat = _refused(DeliveryCheckLib.Code.DeliverySeat);
        uint256 snapshot = vm.snapshotState();

        elections.setAuthorKeySet(h, (1 << 2) | (1 << 3));
        _refuse(_receiptsCall(a), seat, "author seat 1 unregistered");
        assertEq(_accept(_receiptsCall(d)).length, 1, "default seat 1 still registered");
        elections.setAuthorKeySet(h, 0);
        _refuse(_receiptsCall(a), seat, "no author panel");
        _refuse(_complaintCall(c), seat, "no author panel's complaint");

        vm.revertToState(snapshot);
        trustees.setKeySet(h, PANEL, (1 << 2) | (1 << 3));
        _refuse(_receiptsCall(d), seat, "default seat 1 unregistered");
        assertEq(_accept(_receiptsCall(a)).length, 1, "author seat 1 still registered");

        vm.revertToState(snapshot);
        elections.setAuthorKeySet(h, type(uint256).max);
        trustees.setKeySet(h, PANEL, type(uint256).max);
        _refuse(
            _receiptsCall(_signedReceipt(2, 0, bytes32(uint256(7)), secrets[2][1])),
            seat,
            "author seat 0"
        );
        _refuse(
            _receiptsCall(_signedReceipt(1, 0, bytes32(uint256(7)), secrets[1][1])),
            seat,
            "default seat 0"
        );
    }

    /// The panel byte decides the signing key: an author seat's receipt is
    /// checked under the election registry's author signing key, never the
    /// trustee registry's key of the same index, and a record signed by one
    /// panel's seat and relabelled as the other's is refused (T-37). The
    /// tag is version 2's: a version-1-tagged signature over the same
    /// statement is refused (T-31).
    function test_EachPanelsSigningKey() public {
        string memory dj = vm.readFile(DELIVERY);
        bytes memory a = _record(dj, "receipt-author");
        bytes memory sig = _refused(DeliveryCheckLib.Code.DeliverySignature);

        // Author seat 1's key in the trustee registry's default seat 1 isn't read.
        trustees.setKey(h, PANEL, 1, keys[2][1][0], keys[2][1][1]);
        _refuse(_receiptsCall(_record(dj, "receipt-default")), sig, "default under the author key");
        assertEq(_accept(_receiptsCall(a)).length, 1, "author under its own key");
        trustees.setKey(h, PANEL, 1, keys[1][1][0], keys[1][1][1]);

        elections.setAuthorKey(h, 1, keys[1][1][0], keys[1][1][1]);
        _refuse(
            _receiptsCall(_signedReceipt(2, 1, bytes32(uint256(8)), secrets[2][1])),
            sig,
            "author seat 1 under default seat 1's key"
        );
        elections.setAuthorKey(h, 1, keys[2][1][0], keys[2][1][1]);
        _refuse(
            _receiptsCall(_signedReceipt(2, 1, bytes32(uint256(8)), secrets[1][1])),
            sig,
            "default seat 1's signature labelled the author panel"
        );
        assertEq(
            _accept(_receiptsCall(_signedReceipt(2, 1, bytes32(uint256(8)), secrets[2][1]))).length,
            1,
            "a fresh author receipt"
        );

        // Version 1's tag over version 2's statement.
        bytes memory body = _slice(a, 3, RECEIPT_SIG_AT - 3);
        (uint256 r, uint256 s) = TrusteeFixture.sign(
            secrets[2][1], sha256(bytes.concat(_ds("abolish/v1/sig/share-receipt"), body))
        );
        _refuse(
            _receiptsCall(abi.encodePacked(uint16(0x000c), uint8(2), body, r, s)),
            sig,
            "version 1's tag"
        );
        // And the complaint: version 2's tag, the author key.
        bytes memory c = _record(dj, "complaint-author");
        elections.setAuthorKey(h, 2, keys[1][2][0], keys[1][2][1]);
        _refuse(_complaintCall(c), sig, "an author complaint under default seat 2's key");
        elections.setAuthorKey(h, 2, keys[2][2][0], keys[2][2][1]);
        assertEq(_accept(_complaintCall(c)).length, 1, "under its own key");
    }

    /// A posting's ciphertext is compared with its own panel's share hash:
    /// author seat 3's posting relabelled as default seat 3's, or the
    /// reverse, is `posting-hash`, as is one naming a seat the other list
    /// holds a different hash for (T-37, T-29).
    function test_PostingAgainstItsPanelsList() public {
        string memory dj = vm.readFile(DELIVERY);
        _mockPairing();
        bytes memory hash = _refused(DeliveryCheckLib.Code.PostingHash);
        bytes memory author = _record(dj, "posting-author");
        bytes memory default_ = _record(dj, "posting-default");
        _refuse(_postingCall(_withByte(author, PANEL_AT, 1), alice), hash, "author as default");
        _refuse(_postingCall(_withByte(default_, PANEL_AT, 2), alice), hash, "default as author");
        _refuse(_postingCall(_withByte(author, SEAT_AT, 2), alice), hash, "another author seat");
        elections.setAuthorKeySet(h, 0);
        _refuse(
            _postingCall(author, alice),
            _refused(DeliveryCheckLib.Code.DeliverySeat),
            "no author panel"
        );
        elections.setAuthorKeySet(h, (1 << 1) | (1 << 2) | (1 << 3));
        assertEq(_accept(_postingCall(author, alice)).length, 1, "the author posting");
        assertEq(_accept(_postingCall(default_, alice)).length, 1, "the default posting");
    }

    /// intake-v4.json's ballots carry real membership proofs and each seat's
    /// ciphertext, so their postings run unmocked: every seat's of both
    /// panels is accepted with the ballot it delivers; a ciphertext of one
    /// panel posted as the other's is `posting-hash`; a ballot the ballot
    /// check refuses carries no posting, with that check's code, before its
    /// ciphertext is compared (Delivery records, Step 7).
    function test_IntakePostings() public {
        string memory ij = vm.readFile(INTAKE);
        string memory bj = vm.readFile(BALLOTS);
        _election(bj, ".elections.panels");
        _election(bj, ".elections.default-only");
        uint256 accepted;
        uint256 refused;
        for (uint256 i; vm.keyExistsJson(ij, _at(".cases", i, "")); i++) {
            string memory c = _at(".cases", i, "");
            string memory id = _str(ij, string.concat(c, ".id"));
            string memory result = _str(ij, string.concat(c, ".result"));
            bytes memory expected;
            if (_eq(result, "ok")) {
                // An accepted posting below.
            } else if (_eq(result, "share-hash")) {
                // The board runs the whole ballot check before comparing the
                // ciphertext, the reverse of intake's order, so a ballot
                // whose proof fails is refused for that.
                expected = vm.parseJsonBool(ij, string.concat(c, ".snarkjs"))
                    ? _refused(DeliveryCheckLib.Code.PostingHash)
                    : abi.encodeWithSelector(
                        BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.MembershipProof
                    );
            } else if (_eq(result, "share-hash-unqualified") || _eq(result, "validity-shape")) {
                expected = abi.encodeWithSelector(
                    BallotCheckLib.BallotRefused.selector,
                    _eq(result, "validity-shape")
                        ? BallotCheckLib.Code.ValidityShape
                        : BallotCheckLib.Code.ShareHashUnqualified
                );
            } else {
                // What only a seat can check (decryption, the share proofs)
                // or what precedes a ballot record (the envelope).
                continue;
            }
            bytes memory call_ = _intakePosting(ij, bj, c);
            if (expected.length == 0) {
                Vm.Log[] memory logs = _accept(call_);
                assertEq(logs.length, 1, id);
                assertEq(logs[0].topics[0], SHARE_POSTED, id);
                assertEq(
                    logs[0].topics[2],
                    ballots.ballotHash(_bytes(ij, string.concat(c, ".record"))),
                    "its ballot"
                );
                accepted++;
            } else {
                _refuse(call_, expected, id);
                refused++;
            }
        }
        assertEq(accepted, 10, "accepted coverage");
        assertEq(refused, 6, "refused coverage");
    }

    /// Any one-byte change to a version-2 receipt or complaint of either
    /// panel is refused: every byte is framed or signed.
    function testFuzz_OneByteChangesRefused(uint256 which, uint256 position, uint8 delta) public {
        if (delta == 0) delta = 1;
        string memory dj = vm.readFile(DELIVERY);
        string[4] memory ids =
            ["receipt-default", "receipt-author", "complaint-default", "complaint-author"];
        uint256 k = which % 4;
        bytes memory r = _record(dj, ids[k]);
        position %= r.length;
        r[position] = bytes1(uint8(r[position]) ^ delta);
        (bool ok,) = address(board).call(k < 2 ? _receiptsCall(r) : _complaintCall(r));
        assertTrue(!ok, "a changed record was accepted");
    }

    /// Every record of delivery-batch-v2.json, both panels' batches and
    /// roots, is accepted through its call and emitted exactly as
    /// contract-event-v9.json records it, the seat topic the record's seat at
    /// offset 36; a repeat emits nothing (Calls, Repeats). Seat 1 of each
    /// panel commits a receipt root, each filling its own panel's slot.
    function test_BatchesAndRootsWithTheirEvents() public {
        string memory bj = vm.readFile(BATCHES);
        string memory ej = vm.readFile(EVENTS);
        assertTrue(_eq(_str(bj, ".format"), "abolish-delivery-batch-vectors/2"), "the batch file");
        assertEq(_b32(bj, ".elections[0].definitionHash"), h, "the same election");
        uint256 i;
        for (; vm.keyExistsJson(bj, _at(".records", i, "")); i++) {
            string memory r = _at(".records", i, "");
            string memory id = _str(bj, string.concat(r, ".id"));
            string memory t = _str(bj, string.concat(r, ".type"));
            bytes memory record = _bytes(bj, string.concat(r, ".encoding"));
            assertEq(uint8(record[2]), 2, id);
            assertEq(
                uint8(record[BATCH_PANEL_AT]), vm.parseJsonUint(bj, string.concat(r, ".panel")), id
            );
            assertEq(
                uint8(record[BATCH_SEAT_AT]), vm.parseJsonUint(bj, string.concat(r, ".seat")), id
            );
            bytes memory call_ = _batchCall(t, record);
            Vm.Log[] memory logs = _accept(call_);
            assertEq(logs.length, 1, string.concat("one event for ", id));
            _assertLog(
                ej,
                _eventFields(ej, string.concat("delivery-batch-v2-", id)),
                logs[0],
                _batchTopic(t),
                id
            );
            assertEq(_accept(call_).length, 0, string.concat("a repeat of ", id));
        }
        assertEq(i, 9, "record coverage");
    }

    /// delivery-batch-v2.json's decode rejections, each refused by the call
    /// its type names with the file's code at the file's offset (Delivery
    /// records (version 2), Step 4), version-1 bytes under ballot version 4
    /// as `profile-mismatch`.
    function test_BatchDecodeVectors() public {
        string memory bj = vm.readFile(BATCHES);
        uint256 i;
        for (; vm.keyExistsJson(bj, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            string memory id = _str(bj, string.concat(d, ".id"));
            _refuse(
                _batchCall(
                    _str(bj, string.concat(d, ".type")), _bytes(bj, string.concat(d, ".encoding"))
                ),
                abi.encodeWithSelector(
                    DeliveryCheckLib.DeliveryMalformed.selector,
                    0,
                    _decodeError(_str(bj, string.concat(d, ".error"))),
                    vm.parseJsonUint(bj, string.concat(d, ".offset"))
                ),
                id
            );
        }
        assertEq(i, 43, "decode coverage");
        // A version-2 root cut off inside `root` or `leaves_cid` is
        // `truncated` at the field it ends in, every field read before any
        // is judged.
        bytes memory root = _byId(bj, ".records", "receipt-root-author");
        bytes memory truncated73 = _slice(root, 0, 73);
        bytes memory truncated109 = _slice(root, 0, 109);
        _refuse(
            _rootCall(truncated73),
            abi.encodeWithSelector(
                DeliveryCheckLib.DeliveryMalformed.selector,
                0,
                ElectionDefinitionLib.DecodeError.Truncated,
                42
            ),
            "a root ending inside its root"
        );
        _refuse(
            _rootCall(truncated109),
            abi.encodeWithSelector(
                DeliveryCheckLib.DeliveryMalformed.selector,
                0,
                ElectionDefinitionLib.DecodeError.Truncated,
                74
            ),
            "a root ending inside its CID"
        );
    }

    /// The root slot is kept per panel, seat and kind: author seat 1's first
    /// receipt root (the file's root over 16,384 leaves) fills its slot, so
    /// its other receipt roots are `root-repeat`, while default seat 1's
    /// receipt root and author seat 2's complaint root fill their own slots;
    /// a refused root fills nothing (Delivery records (version 2), Step 8;
    /// T-17, T-52).
    function test_RootSlotsPerPanel() public {
        string memory bj = vm.readFile(BATCHES);
        bytes memory repeat = _refused(DeliveryCheckLib.Code.RootRepeat);
        bytes memory large = _bytes(bj, ".limits[0].encoding");
        bytes memory dagPb = _bytes(bj, ".limits[1].encoding");
        bytes memory author = _byId(bj, ".records", "receipt-root-author");
        assertEq(uint8(large[BATCH_PANEL_AT]), 2, "an author root");
        assertEq(uint8(large[BATCH_SEAT_AT]), 1, "of seat 1");
        assertEq(_accept(_rootCall(large)).length, 1, "the first receipt root");
        _refuse(_rootCall(author), repeat, "author seat 1's second receipt root");
        _refuse(_rootCall(dagPb), repeat, "and its third");
        assertEq(_accept(_rootCall(large)).length, 0, "the accepted root's repeat");
        assertEq(
            _accept(_rootCall(_byId(bj, ".records", "receipt-root-default"))).length,
            1,
            "default seat 1's receipt root fills its own slot"
        );
        assertEq(
            _accept(_rootCall(_byId(bj, ".records", "complaint-root-author"))).length,
            1,
            "author seat 2's complaint root"
        );
        // A root refused before its slot fills nothing: a fresh board takes it.
        Board fresh = new Board(address(elections), address(trustees), RELAY);
        elections.setAuthorKeySet(h, 0);
        (bool ok,) = address(fresh).call(_rootCall(author));
        assertTrue(!ok, "no author panel");
        elections.setAuthorKeySet(h, (1 << 1) | (1 << 2) | (1 << 3));
        (ok,) = address(fresh).call(_rootCall(author));
        assertTrue(ok, "the slot was left empty");
    }

    /// The panel byte decides the key set and the signing key of a batch or
    /// root, as of a receipt: an author record is refused once the author
    /// key set lacks its seat or holds none, whatever the default set says,
    /// and under the default seat's key of the same index; one panel's
    /// record relabelled as the other's is refused, since the panel is
    /// signed; version 1's tags over version 2's statements never verify
    /// (T-37, T-31).
    function test_BatchesAndRootsEachPanelsKeys() public {
        string memory bj = vm.readFile(BATCHES);
        _panelsKeys(bj, "receipt-batch-author", "share-receipt-batch", 0);
        _panelsKeys(bj, "complaint-batch-author", "share-complaint-batch", 1);
        _panelsKeys(bj, "receipt-root-author", "obligation-root", 2);
    }

    /// test_BatchesAndRootsEachPanelsKeys for record `id` of type `t`, the
    /// `kind`th of a receipt batch, a complaint batch and a root.
    function _panelsKeys(string memory bj, string memory id, string memory t, uint256 kind)
        internal
    {
        bytes memory r = _byId(bj, ".records", id);
        uint8 s = uint8(r[BATCH_SEAT_AT]);
        bytes memory seat = _refused(DeliveryCheckLib.Code.DeliverySeat);
        uint256 snapshot = vm.snapshotState();
        elections.setAuthorKeySet(h, ((1 << 1) | (1 << 2) | (1 << 3)) & ~(1 << s));
        _refuse(_batchCall(t, r), seat, string.concat(id, ": seat unregistered"));
        elections.setAuthorKeySet(h, 0);
        _refuse(_batchCall(t, r), seat, string.concat(id, ": no author panel"));
        vm.revertToState(snapshot);

        bytes memory sig = _refused(DeliveryCheckLib.Code.DeliverySignature);
        elections.setAuthorKey(h, s, keys[1][s][0], keys[1][s][1]);
        _refuse(_batchCall(t, r), sig, string.concat(id, ": the default key"));
        vm.revertToState(snapshot);
        // The panel is signed: relabelled as default seat `s`'s, the record
        // fails even with that seat holding the author seat's key.
        trustees.setKey(h, PANEL, s, keys[2][s][0], keys[2][s][1]);
        _refuse(
            _batchCall(t, _withByte(r, BATCH_PANEL_AT, 1)),
            sig,
            string.concat(id, ": relabelled the default panel")
        );
        vm.revertToState(snapshot);
        _panelsTags(bj, id, t, kind);
    }

    /// Record `id` re-signed by its seat under version 1's tag is refused,
    /// and under its own tag accepted.
    function _panelsTags(string memory bj, string memory id, string memory t, uint256 kind)
        internal
    {
        bytes memory r = _byId(bj, ".records", id);
        uint256 sk = secrets[2][uint8(r[BATCH_SEAT_AT])];
        bytes memory body = _slice(r, 0, r.length - 64);
        string[3] memory v1Tags = [
            "abolish/v1/sig/share-receipt-batch",
            "abolish/v1/sig/share-complaint-batch",
            "abolish/v1/sig/obligation-root"
        ];
        _refuse(
            _batchCall(t, _resigned(body, _ds(v1Tags[kind]), sk)),
            _refused(DeliveryCheckLib.Code.DeliverySignature),
            string.concat(id, ": version 1's tag")
        );
        bytes memory again = _resigned(body, _ds(_str(bj, _tagKey(kind))), sk);
        assertEq(_accept(_batchCall(t, again)).length, 1, string.concat(id, ": re-signed"));
    }

    /// `body`, a record up to its signature, signed with `sk` under `ds`
    /// over every byte after its header.
    function _resigned(bytes memory body, bytes memory ds, uint256 sk)
        internal
        pure
        returns (bytes memory)
    {
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(sk, sha256(bytes.concat(ds, _slice(body, 3, body.length - 3))));
        return abi.encodePacked(body, r, s);
    }

    /// Ballot version 4 fixes every batch and root at version 2, and the
    /// board knows no later ballot version: under a pinned ballot version 5
    /// each version-2 record, and its version-1 relabelling, is
    /// `unknown-version` (Delivery records (version 2), Step 3).
    function test_BatchesAndRootsUnderAnUnknownBallotVersion() public {
        string memory bj = vm.readFile(BATCHES);
        ElectionRegistry.Parameters memory p = _shape(alice);
        p.ballotVersion = 5;
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(h, p, tiers, roots);
        bytes memory unknown = abi.encodeWithSelector(
            DeliveryCheckLib.DeliveryMalformed.selector,
            0,
            ElectionDefinitionLib.DecodeError.UnknownVersion,
            2
        );
        string[3] memory ids =
            ["receipt-batch-default", "complaint-batch-author", "receipt-root-author"];
        string[3] memory types = ["share-receipt-batch", "share-complaint-batch", "obligation-root"];
        for (uint256 i; i < 3; i++) {
            bytes memory r = _byId(bj, ".records", ids[i]);
            _refuse(_batchCall(types[i], r), unknown, ids[i]);
            _refuse(_batchCall(types[i], _withByte(r, 2, 1)), unknown, "labelled version 1");
        }
    }

    /// An attestation names only roots of its own panel: author seat 1's
    /// counted-extent attestation naming the author roots the board holds is
    /// accepted, and one naming default seat 1's root, which the board also
    /// holds, is `availability-root`; so is the default seat's naming an
    /// author root. An author seat's attestation is checked against the
    /// author key set and signing key (docs/spec/contracts.md, Board,
    /// Availability records, steps 3 to 5; delivery.md, Leaf availability
    /// (version 2); T-25, T-37).
    function test_AttestationsNameTheirOwnPanelsRoots() public {
        string memory bj = vm.readFile(BATCHES);
        bytes memory authorRoot = _byId(bj, ".records", "receipt-root-author");
        bytes memory authorComplaintRoot = _byId(bj, ".records", "complaint-root-author");
        bytes memory defaultRoot = _byId(bj, ".records", "receipt-root-default");
        _accept(_rootCall(authorRoot));
        _accept(_rootCall(authorComplaintRoot));
        _accept(_rootCall(defaultRoot));
        bytes memory rootDs = _ds(_str(bj, ".tags.recordHash"));
        bytes32 a1 = sha256(bytes.concat(rootDs, authorRoot));
        bytes32 a2 = sha256(bytes.concat(rootDs, authorComplaintRoot));
        bytes32 d1 = sha256(bytes.concat(rootDs, defaultRoot));
        bytes memory wrongRoot = abi.encodeWithSelector(
            AvailabilityCheckLib.AvailabilityRefused.selector,
            AvailabilityCheckLib.Code.AvailabilityRoot
        );

        _refuse(
            _availabilityCall(_signedAttestation(2, 1, _sorted(a1, d1), secrets[2][1])),
            wrongRoot,
            "an author attestation naming a default root"
        );
        _refuse(
            _availabilityCall(_signedAttestation(1, 1, _one(a1), secrets[1][1])),
            wrongRoot,
            "a default attestation naming an author root"
        );
        _refuse(
            _availabilityCall(_signedAttestation(2, 1, _sorted(a1, a2), secrets[1][1])),
            abi.encodeWithSelector(
                AvailabilityCheckLib.AvailabilityRefused.selector,
                AvailabilityCheckLib.Code.AvailabilitySignature
            ),
            "author seat 1 under default seat 1's key"
        );
        Vm.Log[] memory logs =
            _accept(_availabilityCall(_signedAttestation(2, 1, _sorted(a1, a2), secrets[2][1])));
        assertEq(logs.length, 1, "the author attestation");
        assertEq(logs[0].topics[0], ATTESTATION_SUBMITTED, "its event");
        assertEq(uint256(logs[0].topics[2]), 1, "its seat topic");
        assertEq(
            _accept(_availabilityCall(_signedAttestation(1, 1, _one(d1), secrets[1][1]))).length,
            1,
            "the default attestation, its own slot"
        );
        // Each panel's slot for the point is its own, and now filled.
        _refuse(
            _availabilityCall(_signedAttestation(2, 1, _one(a1), secrets[2][1])),
            abi.encodeWithSelector(
                AvailabilityCheckLib.AvailabilityRefused.selector,
                AvailabilityCheckLib.Code.AvailabilityRepeat
            ),
            "a second author attestation"
        );
        elections.setAuthorKeySet(h, 0);
        _refuse(
            _availabilityCall(_signedAttestation(2, 2, _one(a2), secrets[2][2])),
            abi.encodeWithSelector(
                AvailabilityCheckLib.AvailabilityRefused.selector,
                AvailabilityCheckLib.Code.AvailabilitySeat
            ),
            "no author panel"
        );
    }

    /// Any one-byte change to a version-2 batch or root of either panel is
    /// refused: every byte is framed or signed.
    function testFuzz_BatchOneByteChangesRefused(uint256 which, uint256 position, uint8 delta)
        public
    {
        if (delta == 0) delta = 1;
        string memory bj = vm.readFile(BATCHES);
        string[6] memory ids = [
            "receipt-batch-default",
            "receipt-batch-author",
            "complaint-batch-author",
            "complaint-batch-default",
            "receipt-root-author",
            "receipt-root-default"
        ];
        string[6] memory types = [
            "share-receipt-batch",
            "share-receipt-batch",
            "share-complaint-batch",
            "share-complaint-batch",
            "obligation-root",
            "obligation-root"
        ];
        uint256 k = which % 6;
        bytes memory r = _byId(bj, ".records", ids[k]);
        position %= r.length;
        r[position] = bytes1(uint8(r[position]) ^ delta);
        (bool ok,) = address(board).call(_batchCall(types[k], r));
        assertTrue(!ok, "a changed record was accepted");
    }

    // --- the forced path's figures -------------------------------------------

    /// The forced path's call figures (docs/spec/delivery.md, Capacity;
    /// Version 2, What a node owes) hold for version 2's records, which the
    /// capacity check sizes ballot version 4's seats by: for a default seat
    /// and an author seat, a full version-2 receipt batch of
    /// `receiptsPerCall` pairs, a full complaint batch of `complaintsPerCall`
    /// entries and a root with dense calldata each fit one deposit's data,
    /// cost at most their pinned gas with their intrinsic gas, cold, where
    /// P-256 goes through `P256VERIFY`, and are accepted with exactly that
    /// figure as their deposit's gas limit. An author seat's key set and
    /// signing key are the election registry's, which every call reads
    /// already, so a default seat's calls, which also read the trustee
    /// registry, are the dearer. The stubs stand in for the registries:
    /// rule 9 refuses every definition pinning ballot version 4 until P2-16
    /// part 5e, so no real registry holds one yet, and `HEADROOM` keeps back
    /// what real registries cost over them. The board has already accepted a
    /// record, as any board a forced deposit reaches has, so no measurement
    /// carries the accumulator count's first write (T-25, T-52, T-54).
    function test_ForcedPathCallGas() public {
        string memory fj = vm.readFile(OBLIGATION);
        string memory bj = vm.readFile(BATCHES);
        _accept(_batchCall("share-receipt-batch", _byId(bj, ".records", "receipt-batch-default")));
        uint256 receipts = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.receiptsPerCall"));
        uint256 complaints = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.complaintsPerCall"));
        assertEq(receipts, DeliveryCheckLib.BATCH_MAX, "a call is one full receipt batch");
        assertEq(complaints, DeliveryCheckLib.COMPLAINT_BATCH_MAX, "and one full complaint batch");
        uint256[3] memory figures = [
            vm.parseUint(vm.parseJsonString(fj, ".forcedPath.receiptCallGas")),
            vm.parseUint(vm.parseJsonString(fj, ".forcedPath.complaintCallGas")),
            vm.parseUint(vm.parseJsonString(vm.readFile(ROOTS), ".rootCallGas"))
        ];
        for (uint8 panel = 1; panel <= 2; panel++) {
            uint256 sk = secrets[panel][1];
            for (uint256 kind; kind < 3; kind++) {
                string memory what = string.concat(
                    panel == 1 ? "default " : "author ",
                    kind == 0 ? "receipt batch" : kind == 1 ? "complaint batch" : "root"
                );
                bytes memory first =
                    _forcedCall(bj, kind, panel, sk, "forced path", receipts, complaints);
                bytes memory next =
                    _forcedCall(bj, kind, panel, sk, "forced path, next", receipts, complaints);
                _withinFigure(fj, first, next, figures[kind], what);
            }
        }
    }

    /// The `kind`th call of test_ForcedPathCallGas (a receipt batch, a
    /// complaint batch, a root) by seat 1 of `panel`, signed with `sk`, its
    /// contents from `label`. A root's second call is the seat's complaint
    /// root, since its receipt root's slot is then full.
    function _forcedCall(
        string memory bj,
        uint256 kind,
        uint8 panel,
        uint256 sk,
        string memory label,
        uint256 receipts,
        uint256 complaints
    ) internal view returns (bytes memory) {
        bytes memory ds = _ds(_str(bj, _tagKey(kind)));
        if (kind == 0) {
            bytes memory head =
                abi.encodePacked(uint16(0x0016), uint8(2), h, panel, uint8(1), uint32(receipts));
            return abi.encodeCall(
                Board.submitReceiptBatch,
                (_resigned(bytes.concat(head, _densePairs(receipts, label)), ds, sk))
            );
        }
        if (kind == 1) {
            bytes memory head =
                abi.encodePacked(uint16(0x0017), uint8(2), h, panel, uint8(1), uint32(complaints));
            return abi.encodeCall(
                Board.submitComplaintBatch,
                (_resigned(bytes.concat(head, _denseEntries(complaints, label)), ds, sk))
            );
        }
        uint8 rootKind = keccak256(bytes(label)) == keccak256("forced path") ? 1 : 2;
        return _rootCall(_resigned(_denseRoot(panel, rootKind), ds, sk));
    }

    /// A version-2 root by seat 1 of `panel` up to its signature, with no
    /// zero byte in its count, root or CID digest: the calldata's dearest
    /// form. Either kind's leaves at this count are a DAG-PB object.
    function _denseRoot(uint8 panel, uint8 kind) internal view returns (bytes memory) {
        bytes32 dense = bytes32(type(uint256).max / 255);
        return abi.encodePacked(
            uint16(0x001a),
            uint8(2),
            h,
            panel,
            uint8(1),
            kind,
            uint32(0x01010101),
            dense,
            bytes4(0x01701220),
            dense
        );
    }

    /// `first` fits a deposit's data and, where P-256 goes through its
    /// precompile, costs at most `figure` less `HEADROOM`, cold, with its
    /// intrinsic gas; `next`, new records of the same seat, is accepted with
    /// exactly `figure` as its gas limit.
    function _withinFigure(
        string memory fj,
        bytes memory first,
        bytes memory next,
        uint256 figure,
        string memory what
    ) internal {
        assertTrue(first.length <= vm.parseJsonUint(fj, ".portal.maxDepositData"), what);
        assertTrue(figure <= vm.parseUint(vm.parseJsonString(fj, ".portal.maxResourceLimit")), what);
        if (!_expectPrecompile()) return;
        uint256 used = _withIntrinsic(first, _coldGas(first));
        assertTrue(used + HEADROOM <= figure, string.concat(what, ": ", vm.toString(used)));
        _acceptsWithin(next, figure, what);
    }

    // --- helpers -------------------------------------------------------------

    /// `count` pairs ascending by ballot hash, dense as honest hashes are:
    /// each ballot hash leads with its index's two bytes (Board.t.sol,
    /// `_batchPairs`).
    function _densePairs(uint256 count, string memory label)
        internal
        pure
        returns (bytes memory pairs)
    {
        pairs = new bytes(64 * count);
        for (uint256 i; i < count; i++) {
            bytes32 ballot = bytes32(
                (i + 1) << 240 | (uint256(keccak256(abi.encode(label, "ballot", i))) >> 16)
            );
            bytes32 share = keccak256(abi.encode(label, "share", i));
            assembly ("memory-safe") {
                let at := add(add(pairs, 32), mul(i, 64))
                mstore(at, ballot)
                mstore(add(at, 32), share)
            }
        }
    }

    /// `count` complaint entries ascending by ballot hash, each proof framed
    /// and dense, as Board.t.sol's `_complaintEntries`: `D` even and below
    /// `2²⁵⁵ − 19`, `c` and `z` below `ℓ`, little-endian; the board frames
    /// them only.
    function _denseEntries(uint256 count, string memory label)
        internal
        pure
        returns (bytes memory entries)
    {
        entries = new bytes(128 * count);
        for (uint256 i; i < count; i++) {
            bytes32 ballot = bytes32(
                (i + 1) << 240 | (uint256(keccak256(abi.encode(label, "ballot", i))) >> 16)
            );
            uint256 d = uint256(keccak256(abi.encode(label, "D", i)));
            d = ((d & ~uint256(0xff)) | 0x2a) & ~(uint256(1) << 248);
            uint256 c = uint256(keccak256(abi.encode(label, "c", i)));
            c = (c & ~uint256(0xff)) | 0x05;
            uint256 z = uint256(keccak256(abi.encode(label, "z", i)));
            z = (z & ~uint256(0xff)) | 0x07;
            assembly ("memory-safe") {
                let at := add(add(entries, 32), mul(i, 128))
                mstore(at, ballot)
                mstore(add(at, 32), d)
                mstore(add(at, 64), c)
                mstore(add(at, 96), z)
            }
        }
    }

    /// Whether P-256 goes through the precompile at 0x100 here, asserted
    /// where the test script expects it (`EXPECT_P256VERIFY`).
    function _expectPrecompile() internal view returns (bool precompile) {
        bytes32 digest = sha256("forced path");
        (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[1][1], digest);
        (bool ok, bytes memory ret) =
            address(0x100).staticcall(abi.encodePacked(digest, r, s, keys[1][1][0], keys[1][1][1]));
        precompile = ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
        if (vm.envOr("EXPECT_P256VERIFY", false)) assertTrue(precompile, "no P256VERIFY");
    }

    /// The gas the board's call of `data` executes, with the board and both
    /// stubs cold, accounts and slots, as in a deposit of its own.
    function _coldGas(bytes memory data) internal returns (uint256 used) {
        vm.cool(address(board));
        vm.cool(address(elections));
        vm.cool(address(trustees));
        // The call reads `data` where it lies: Solidity's `.call` would copy
        // it first, and that copy's memory expansion, quadratic in the
        // test's whole memory, would be counted as the board's.
        address target = address(board);
        bool ok;
        assembly ("memory-safe") {
            let before := gas()
            ok := call(gas(), target, 0, add(data, 32), mload(data), 0, 0)
            used := sub(before, gas())
        }
        assertTrue(ok, "gas call refused");
    }

    /// A transaction's gas for `data` that executed `used`: 21,000, then
    /// EIP-2028's 4 per zero byte and 16 per other, or EIP-7623's floor of 10
    /// per token when that is higher (Board.t.sol, `_withIntrinsic`).
    function _withIntrinsic(bytes memory data, uint256 used) internal pure returns (uint256) {
        uint256 tokens = _tokens(data);
        uint256 standard = 21_000 + 4 * tokens + used;
        uint256 floor = 21_000 + 10 * tokens;
        return standard > floor ? standard : floor;
    }

    /// The call is accepted, cold, with `gasLimit` as its transaction's
    /// limit: what is left after the intrinsic gas is what the call gets,
    /// and EIP-7623's floor fits the limit too.
    function _acceptsWithin(bytes memory data, uint256 gasLimit, string memory what) internal {
        uint256 tokens = _tokens(data);
        assertTrue(21_000 + 10 * tokens <= gasLimit, string.concat(what, ": the floor fits"));
        vm.cool(address(board));
        vm.cool(address(elections));
        vm.cool(address(trustees));
        vm.recordLogs();
        (bool ok,) = address(board).call{gas: gasLimit - 21_000 - 4 * tokens}(data);
        assertTrue(ok, string.concat(what, ": accepted within the deposit's gas limit"));
        assertTrue(vm.getRecordedLogs().length > 0, string.concat(what, ": the call emitted"));
    }

    /// EIP-7623's tokens: a zero byte one, any other four.
    function _tokens(bytes memory data) internal pure returns (uint256 tokens) {
        for (uint256 i; i < data.length; i++) {
            tokens += data[i] == 0 ? 1 : 4;
        }
    }

    /// Alice's version-4 record: delivery-v2.json's cell, nullifier and
    /// committed vote, with ballot-v4-records.json's first L1 reference and
    /// proof points (which fail against this ballot: postings of it run with
    /// the pairing mocked). Its ballot hash is the file's.
    function _alice(string memory dj) internal view returns (bytes memory record) {
        string memory b = ".elections[0].ballots[0]";
        assertTrue(_eq(_str(dj, string.concat(b, ".id")), "alice"), "Alice's ballot");
        bytes memory other = _bytes(vm.readFile(BALLOTS), ".ballots[0].encoding");
        record = abi.encodePacked(
            uint16(0x0002),
            uint8(4),
            h,
            uint8(vm.parseJsonUint(dj, string.concat(b, ".cell"))),
            vm.parseUint(_str(dj, string.concat(b, ".nullifier"))),
            _slice(
                other,
                BallotCheckLib.L1_NUMBER_AT,
                BallotCheckLib.VOTE_AT - BallotCheckLib.L1_NUMBER_AT
            ),
            _bytes(dj, string.concat(b, ".committedVote"))
        );
        assertEq(
            ballots.ballotHash(record), _b32(dj, string.concat(b, ".ballotHash")), "ballot hash"
        );
    }

    /// The parameters a version-4 record's committed vote fits: `T`, both
    /// panels' thresholds and sizes, and one question per range proof with
    /// its branches (docs/spec/ballot-validity.md, Committed vote (versions
    /// 3 and 4)).
    function _shape(bytes memory record)
        internal
        pure
        returns (ElectionRegistry.Parameters memory p)
    {
        uint256 o = BallotCheckLib.VOTE_AT;
        uint256 options = _u32(record, o);
        p.ballotVersion = 4;
        p.optionCount = uint16(options);
        p.closesAt = type(uint64).max;
        p.threshold = uint8(_u32(record, o + 4));
        o = _rows(record, o);
        p.panelSize = uint8(_u32(record, o));
        o += 4 + 32 * p.panelSize;
        if (_u32(record, o) != 0) p.authorThreshold = uint8(_u32(record, o + 4));
        o = _rows(record, o);
        p.authorPanelSize = uint8(_u32(record, o));
        o += 4 + 32 * p.authorPanelSize;
        o += 4 + 128 * _u32(record, o);
        uint256 questions = _u32(record, o);
        o += 4;
        p.questions = new ElectionRegistry.Question[](questions);
        for (uint256 q; q < questions; q++) {
            uint256 branches = _u32(record, o);
            p.questions[q] =
                ElectionRegistry.Question(1, q == 0 ? uint16(options) : 0, 0, uint16(branches - 1));
            o += 4 + 64 * branches;
        }
    }

    /// Past a list of VSS rows at `o`.
    function _rows(bytes memory r, uint256 o) internal pure returns (uint256) {
        uint256 count = _u32(r, o);
        o += 4;
        for (uint256 j; j < count; j++) {
            o += 4 + 32 * _u32(r, o);
        }
        return o;
    }

    /// One panel's seats of delivery-v2.json: secrets and keys, registered
    /// in the trustee registry (default) or the election registry (author).
    function _seats(string memory dj, string memory list, uint256 panel) internal {
        for (uint256 i; vm.keyExistsJson(dj, _at(list, i, "")); i++) {
            uint256 seat = vm.parseJsonUint(dj, _at(list, i, ".seat"));
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(dj, _at(list, i, ".signingKey")));
            assertTrue(onCurve, "signing key");
            keys[panel][seat] = [x, y];
            secrets[panel][seat] =
                vm.parseUint(string.concat("0x", _str(dj, _at(list, i, ".signingSecret"))));
            if (panel == 1) trustees.setKey(h, PANEL, seat, x, y);
            else elections.setAuthorKey(h, seat, x, y);
        }
    }

    /// One election of ballot-v4-records.json in the stubs, as
    /// BoardBallotV4.t.sol sets it, with both its key sets.
    function _election(string memory bj, string memory e) internal {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(bj, string.concat(e, ".definition")));
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 4;
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
        uint256 n;
        while (vm.keyExistsJson(bj, _at(string.concat(e, ".cells"), n, ""))) n++;
        uint8[] memory tiers = new uint8[](n);
        uint256[] memory roots = new uint256[](n);
        for (uint256 c; c < n; c++) {
            string memory cell = _at(string.concat(e, ".cells"), c, "");
            tiers[c] = uint8(vm.parseJsonUint(bj, string.concat(cell, ".tier")));
            roots[c] = vm.parseUint(_str(bj, string.concat(cell, ".root")));
        }
        bytes32 dh = bytes32(_bytes(bj, string.concat(e, ".definitionHash")));
        elections.set(dh, p, tiers, roots);
        elections.setCeremony(dh, dh, PANEL);
    }

    /// The posting call of intake case `c`: its seat's ciphertext under its
    /// panel, with any `m` (the board can't check it), carrying the case's
    /// ballot record, with the case's key sets registered.
    function _intakePosting(string memory ij, string memory bj, string memory c)
        internal
        returns (bytes memory)
    {
        bytes32 dh = bytes32(
            _bytes(
                bj,
                string.concat(
                    ".elections.", _str(ij, string.concat(c, ".election")), ".definitionHash"
                )
            )
        );
        trustees.setKeySet(
            dh, PANEL, _mask(vm.parseJsonUintArray(ij, string.concat(c, ".registered")))
        );
        elections.setAuthorKeySet(
            dh, _mask(vm.parseJsonUintArray(ij, string.concat(c, ".authorRegistered")))
        );
        bytes memory posting = abi.encodePacked(
            uint16(0x000d),
            uint8(2),
            dh,
            ballots.ballotHash(_bytes(ij, string.concat(c, ".record"))),
            uint8(vm.parseJsonUint(ij, string.concat(c, ".panel"))),
            uint8(vm.parseJsonUint(ij, string.concat(c, ".seat"))),
            keccak256(bytes(_str(ij, string.concat(c, ".id")))),
            _bytes(ij, string.concat(c, ".ciphertext"))
        );
        return _postingCall(posting, _bytes(ij, string.concat(c, ".record")));
    }

    /// A version-2 receipt by `seat` of `panel` for Alice's ballot, signed
    /// with `sk` under version 2's tag.
    function _signedReceipt(uint8 panel, uint8 seat, bytes32 shareHash, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(h, ballots.ballotHash(alice), panel, seat, shareHash);
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, sha256(bytes.concat(receiptDs, body)));
        return abi.encodePacked(uint16(0x000c), uint8(2), body, r, s);
    }

    /// The offset each decode rejection of delivery-v2.json fails at, from
    /// Delivery records (version 2), Step 4.
    function _offset(string memory id, bytes memory enc) internal pure returns (uint256) {
        bytes32 c = keccak256(bytes(id));
        if (
            c == keccak256("receipt-version-1") || c == keccak256("receipt-v1-bytes")
                || c == keccak256("posting-version-1") || c == keccak256("complaint-version-1")
        ) return 2;
        if (c == keccak256("receipt-as-posting")) return 0;
        if (
            c == keccak256("receipt-panel-0") || c == keccak256("receipt-panel-3")
                || c == keccak256("posting-panel-3") || c == keccak256("complaint-panel-0")
        ) return PANEL_AT;
        if (c == keccak256("receipt-high-s")) return RECEIPT_SIG_AT;
        // A posting: `m` at 69, `ct_dh` at 1189, `sealed`'s count at 1285.
        if (c == keccak256("posting-identity-dh")) return 1189;
        if (c == keccak256("posting-sealed-over-max")) return 1285;
        if (c == keccak256("posting-truncated")) return 1289;
        if (c == keccak256("posting-trailing")) return enc.length - 1;
        // A complaint: `D` at 69, `c` at 101, `z` at 133, the signature at 165.
        if (c == keccak256("complaint-identity-dh")) return 69;
        if (c == keccak256("complaint-c-l")) return 101;
        if (c == keccak256("complaint-truncated")) return COMPLAINT_SIG_AT;
        if (c == keccak256("complaint-trailing")) return 229;
        revert(string.concat("no offset for ", id));
    }

    function _batchCall(string memory t, bytes memory record) internal pure returns (bytes memory) {
        if (_eq(t, "share-receipt-batch")) {
            return abi.encodeCall(Board.submitReceiptBatch, (record));
        }
        if (_eq(t, "share-complaint-batch")) {
            return abi.encodeCall(Board.submitComplaintBatch, (record));
        }
        assertTrue(_eq(t, "obligation-root"), t);
        return _rootCall(record);
    }

    function _batchTopic(string memory t) internal pure returns (bytes32) {
        if (_eq(t, "share-receipt-batch")) return BATCH_SUBMITTED;
        if (_eq(t, "share-complaint-batch")) return COMPLAINT_BATCH_SUBMITTED;
        return ROOT_SUBMITTED;
    }

    function _rootCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitObligationRoot, (r));
    }

    function _availabilityCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitAvailabilityRecord, (r));
    }

    /// delivery-batch-v2.json's tag key for the `i`th of a receipt batch, a
    /// complaint batch and a root.
    function _tagKey(uint256 i) internal pure returns (string memory) {
        return i == 0 ? ".tags.receiptBatch" : i == 1 ? ".tags.complaintBatch" : ".tags.root";
    }

    /// A counted-extent attestation (docs/spec/availability.md, Records) by
    /// `seat` of `panel` for the file's election, naming `roots`, signed
    /// with `sk` over every byte before its signature, header included.
    function _signedAttestation(uint8 panel, uint8 seat, bytes32[] memory roots, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(
            uint16(0x001b),
            uint8(1),
            h,
            panel,
            seat,
            uint8(2),
            keccak256("counted checkpoint"),
            uint32(roots.length),
            roots
        );
        (uint256 r, uint256 s) = TrusteeFixture.sign(
            sk, sha256(bytes.concat(_ds("abolish/v1/sig/availability-attestation"), body))
        );
        return abi.encodePacked(body, r, s);
    }

    function _one(bytes32 a) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = a;
    }

    /// Two roots in the ascending order an attestation lists them.
    function _sorted(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](2);
        (r[0], r[1]) = a < b ? (a, b) : (b, a);
    }

    function _call(string memory t, bytes memory record) internal view returns (bytes memory) {
        if (_eq(t, "share-receipt")) return _receiptsCall(record);
        if (_eq(t, "share-posting")) return _postingCall(record, alice);
        assertTrue(_eq(t, "share-complaint"), t);
        return _complaintCall(record);
    }

    function _topic(string memory t) internal pure returns (bytes32) {
        if (_eq(t, "share-receipt")) return RECEIPT_SUBMITTED;
        if (_eq(t, "share-posting")) return SHARE_POSTED;
        return COMPLAINT_SUBMITTED;
    }

    function _receiptsCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitReceipts, (r));
    }

    function _complaintCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitComplaint, (r));
    }

    function _postingCall(bytes memory p, bytes memory b) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitPosting, (p, b));
    }

    /// Makes the pairing precompile answer "valid", so Alice's record, whose
    /// proof points are another ballot's, passes its membership check.
    function _mockPairing() internal {
        vm.mockCall(address(8), "", abi.encode(uint256(1)));
    }

    /// The `.fields` key of contract-event-v9.json's record `id`.
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
        assertEq(after_, acc, "a refusal moved the accumulator");
        assertEq(countAfter, count, "a refusal counted");
    }

    function _refused(DeliveryCheckLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DeliveryCheckLib.DeliveryRefused.selector, 0, code);
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
        if (c == keccak256("invalid-enum")) return ElectionDefinitionLib.DecodeError.InvalidEnum;
        if (c == keccak256("unexpected-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
        }
        if (c == keccak256("unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        revert(string.concat("unknown decode error ", s));
    }

    /// The encoding of delivery-v2.json's record `id`.
    function _record(string memory dj, string memory id) internal view returns (bytes memory) {
        return _byId(dj, ".records", id);
    }

    /// The encoding of delivery-v2.json's decode rejection `id`.
    function _decode(string memory dj, string memory id) internal view returns (bytes memory) {
        return _byId(dj, ".decode", id);
    }

    function _byId(string memory j, string memory list, string memory id)
        internal
        view
        returns (bytes memory)
    {
        for (uint256 i; vm.keyExistsJson(j, _at(list, i, "")); i++) {
            if (_eq(_str(j, _at(list, i, ".id")), id)) return _bytes(j, _at(list, i, ".encoding"));
        }
        revert(string.concat("no record ", id));
    }

    /// `u8(len(tag)) ‖ tag`.
    function _ds(string memory tag) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(uint8(bytes(tag).length)), bytes(tag));
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    function _withByte(bytes memory b, uint256 at, uint8 v) internal pure returns (bytes memory c) {
        c = bytes.concat(b);
        c[at] = bytes1(v);
    }

    function _slice(bytes memory b, uint256 start, uint256 len)
        internal
        pure
        returns (bytes memory s)
    {
        s = new bytes(len);
        for (uint256 i; i < len; i++) {
            s[i] = b[start + i];
        }
    }

    function _u32(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 4; i++) {
            v = (v << 8) | uint8(b[o + i]);
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

    function _b32(string memory j, string memory key) internal pure returns (bytes32) {
        return bytes32(_bytes(j, key));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
