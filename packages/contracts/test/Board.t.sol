// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {DeliveryCheckLib} from "../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TrusteeIdentityLib, TrusteeRegistry} from "../src/TrusteeRegistry.sol";
import {BallotHarness} from "./utils/BallotHarness.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {
    ByteWriter,
    DefinitionEncoder,
    DefinitionHarness,
    MockTrusteeRegistry
} from "./utils/DefinitionHarness.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {TrusteeFixture, TrusteeHarness} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's direct-submit path (docs/spec/contracts.md, Board: Ballots,
/// Deployment, Delivery records, Calls, Events; docs/spec/delivery.md,
/// Records and Direct submit) against the vectors: delivery.json (an honest
/// receipt, posting and complaint, their decode rejections, and every
/// delivery record of its elections with the delivery check's verdicts),
/// share-receipt.json (receipt signature checks), and ballot.json and
/// ballot-v3-records.json (records with real membership proofs). Every expected value comes from the files
/// or from the spec's field offsets, never from the code under test; the
/// registries are stubs set from the files, and one test each runs against
/// a real election registry and a real trustee registry. Threats: T-25
/// (records kept off the board), T-17 (chosen bytes in the archive), T-54
/// (a record occupying a slot), T-52 (input that costs others work), T-31.
contract BoardTest is TestBase {
    using ByteWriter for ByteWriter.Writer;

    string internal constant DELIVERY = "../../docs/spec/vectors/delivery.json";
    string internal constant RECEIPTS = "../../docs/spec/vectors/share-receipt.json";
    string internal constant OBLIGATION = "../../docs/spec/vectors/delivery-obligation.json";
    string internal constant BATCHES = "../../docs/spec/vectors/delivery-batch.json";
    string internal constant EVENTS_V4 = "../../docs/spec/vectors/contract-event-v4.json";
    string internal constant ROOTS = "../../docs/spec/vectors/delivery-root.json";
    string internal constant EVENTS_V5 = "../../docs/spec/vectors/contract-event-v5.json";
    string internal constant V1 = "../../docs/spec/vectors/ballot.json";
    string internal constant V3 = "../../docs/spec/vectors/ballot-v3-records.json";
    /// Framed values with no zero byte, for the largest record's elements and scalars.
    uint256 internal constant DENSE_ELEMENT =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 internal constant DENSE_SCALAR =
        0x0101010101010101010101010101010101010101010101010101010101010101;

    /// The ceremonies the stubs record the vectors' key sets under: any
    /// values, since the board only passes them from one registry to the other.
    bytes32 internal constant STUB = keccak256("delivery stub");
    bytes32 internal constant STUB_V1 = keccak256("ballot stub");
    bytes32 internal constant STUB_RECEIPTS = keccak256("share-receipt stub");
    bytes32 internal constant PANEL = keccak256("panel");

    /// The spec's event signatures (contracts.md, Board, Events).
    bytes32 internal constant BALLOT_SUBMITTED =
        keccak256("BallotSubmitted(bytes32,bytes32,bytes)");
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

    /// Record layouts (delivery.md, Records): every delivery record's header
    /// and first fields, a receipt's and a complaint's signature, a
    /// posting's `m` and its ciphertext's fields (share-encryption.md,
    /// Ciphertext: `ct_mlkem` 1088 bytes, `ct_dh`, `pok_c`, `pok_z`, `sealed`).
    uint256 internal constant BALLOT_HASH_AT = 35;
    uint256 internal constant SEAT_AT = 67;
    uint256 internal constant RECEIPT_LENGTH = 164;
    uint256 internal constant RECEIPT_SIG_AT = 100;
    uint256 internal constant COMPLAINT_D_AT = 68;
    uint256 internal constant COMPLAINT_C_AT = 100;
    uint256 internal constant COMPLAINT_SIG_AT = 164;
    uint256 internal constant COMPLAINT_LENGTH = 228;
    uint256 internal constant M_AT = 68;
    uint256 internal constant CT_DH_AT = 100 + 1088;
    uint256 internal constant POK_Z_AT = CT_DH_AT + 64;
    uint256 internal constant SEALED_AT = CT_DH_AT + 96;
    uint256 internal constant POK_C_AT = CT_DH_AT + 32;
    uint256 internal constant COMPLAINT_Z_AT = 132;
    /// An obligation root's CID and signature (delivery.md, Obligation root),
    /// and the CID's first four bytes for a raw block and a dag-pb root
    /// (content-addressing.md: CIDv1, the codec, sha2-256, 32 bytes).
    uint256 internal constant ROOT_ROOT_AT = 41;
    uint256 internal constant ROOT_CID_AT = 73;
    uint256 internal constant ROOT_SIG_AT = 109;
    bytes4 internal constant RAW_PREFIX = 0x01551220;
    bytes4 internal constant DAG_PB_PREFIX = 0x01701220;

    /// ristretto255's base field prime `2²⁵⁵ − 19` and group order `ℓ`
    /// (RFC 9496), and P-256's group order `n` (SEC 2), as the spec states them.
    uint256 internal constant P25519 = 2 ** 255 - 19;
    uint256 internal constant ELL = 2 ** 252 + 27742317777372353535851937790883648493;
    uint256 internal constant P256_N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    /// The L1 reference and proof of the ballot records built around the
    /// vectors' committed votes: posting framing checks neither.
    uint64 internal constant L1_NUMBER = 7_000_000;
    bytes32 internal constant L1_HASH = keccak256("l1 block");

    /// The L1 relay the board pins: the registry fixture's `l1Relay`.
    address internal constant RELAY = address(0x4E1A);

    ElectionsStub internal elections;
    /// The real registries `_realRegistries` deployed, for `_coldGas`.
    address internal realElections;
    address internal realTrustees;
    TrusteesStub internal trustees;
    Board internal board;
    BallotHarness internal ballots;
    DefinitionHarness internal defs;

    /// delivery.json's definition, its honest records, and the ballots they name.
    bytes32 internal h;
    bytes internal receipt;
    bytes internal posting;
    bytes internal complaint;
    bytes internal alice;
    bytes32 internal aliceHash;
    bytes32 internal carolHash;
    uint256[2][4] internal signingKeys;
    uint256[4] internal signingSecrets;
    /// all-receipted's key set and its three receipts, seats 1 to 3.
    uint256 internal registeredAll;
    bytes[3] internal allReceipted;
    bytes internal receiptHighS;
    bytes internal postingIdentityDh;
    /// `u8(len(tag)) ‖ tag` for the receipt and complaint signatures, from
    /// the tags delivery.json names.
    bytes internal receiptDs;
    bytes internal complaintDs;
    /// The same for the share-receipt batch, from delivery-batch.json.
    bytes internal batchDs;
    bytes internal complaintBatchDs;
    /// The same for the obligation root, from delivery-root.json.
    bytes internal rootDs;

    /// ballot.json's plurality election and its first, admitted, ballot.
    bytes32 internal hV1;
    bytes internal honestBallot;
    bytes32 internal honestBallotHash;
    /// Its membership proof: valid points, which a posting's ballot built
    /// around a delivery.json committed vote carries.
    bytes internal proof;

    function setUp() public {
        string memory dj = vm.readFile(DELIVERY);
        string memory bj = vm.readFile(V1);
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), RELAY);
        ballots = new BallotHarness();
        defs = new DefinitionHarness();

        honestBallot = _bytes(bj, ".ballots[0].encoding");
        proof = _slice(
            honestBallot, BallotCheckLib.PROOF_AT, BallotCheckLib.VOTE_AT - BallotCheckLib.PROOF_AT
        );

        h = _b32(dj, ".definitionHash");
        string memory e = _election(dj, "all-receipted");
        string memory a = _ballot(dj, e, "alice");
        _setParameters(h, _shape(_bytes(dj, string.concat(a, ".committedVote"))));
        elections.setCeremony(h, STUB, PANEL);
        trustees.setKeySet(STUB, PANEL, _registered(dj, e));
        for (uint256 i; vm.keyExistsJson(dj, _at(".panel", i, "")); i++) {
            uint256 seat = vm.parseJsonUint(dj, _at(".panel", i, ".seat"));
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(dj, _at(".panel", i, ".signingKey")));
            assertTrue(onCurve, "signing key");
            signingKeys[seat] = [x, y];
            signingSecrets[seat] =
                vm.parseUint(string.concat("0x", _str(dj, _at(".panel", i, ".signingSecret"))));
            trustees.setKey(STUB, PANEL, seat, x, y);
        }
        registeredAll = _registered(dj, e);
        for (uint256 i; i < 3; i++) {
            allReceipted[i] = _bytes(dj, _at(string.concat(e, ".entries"), i, ".payload"));
            assertEq(uint8(allReceipted[i][SEAT_AT]), i + 1, "all-receipted's seats in order");
        }
        receiptHighS = _decodeVector(dj, "receipt-high-s");
        postingIdentityDh = _decodeVector(dj, "posting-identity-dh");
        receiptDs = _ds(_str(dj, ".tags.receipt"));
        complaintDs = _ds(_str(dj, ".tags.complaint"));
        batchDs = _ds(_str(vm.readFile(BATCHES), ".tag"));
        complaintBatchDs = _ds(_str(vm.readFile(BATCHES), ".complaintTag"));
        rootDs = _ds(_str(vm.readFile(ROOTS), ".tag"));
        receipt = _vectorRecord(dj, "receipt", "share-receipt");
        assertTrue(keccak256(receipt) == keccak256(allReceipted[0]), "the receipt is seat 1's");
        posting = _vectorRecord(dj, "posting", "share-posting");
        complaint = _vectorRecord(dj, "complaint", "share-complaint");
        aliceHash = _b32(dj, string.concat(a, ".ballotHash"));
        alice = _ballotRecord(dj, a);
        assertEq(_nonZeroShareHashes(alice), registeredAll, "Alice's seats are the key set");
        carolHash = _b32(
            dj,
            string.concat(_ballot(dj, _election(dj, "proven-complaint"), "carol"), ".ballotHash")
        );

        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV1(bj, ".elections.plurality");
        hV1 = _b32(bj, ".elections.plurality.definitionHash");
        elections.set(hV1, p, tiers, roots);
        // Every vector election shares this window: ordinary ballots are
        // submitted at its opening second, the earliest the board takes.
        vm.warp(p.opensAt);
        elections.setCeremony(hV1, STUB_V1, PANEL);
        assertTrue(_eq(_str(bj, ".ballots[0].id"), "ok-tier-0"), "the honest ballot");
        assertTrue(_eq(_str(bj, ".ballots[0].election"), "plurality"), "its election");
        trustees.setKeySet(
            STUB_V1, PANEL, _mask(vm.parseJsonUintArray(bj, ".ballots[0].registered"))
        );
        honestBallotHash = _b32(bj, ".ballots[0].ballotHash");
    }

    function test_VectorFileFormats() public view {
        string memory dj = vm.readFile(DELIVERY);
        string memory bj = vm.readFile(V1);
        assertTrue(_eq(_str(dj, ".format"), "abolish-delivery-vectors/1"), "delivery format");
        assertTrue(
            _eq(_str(vm.readFile(RECEIPTS), ".format"), "abolish-share-receipt-vectors/1"),
            "share-receipt format"
        );
        assertTrue(_eq(_str(bj, ".format"), "abolish-ballot-vectors/1"), "ballot format");
    }

    // --- deployment ----------------------------------------------------------

    /// Both registries non-zero, distinct and not the board itself
    /// (contracts.md, Board, Deployment).
    function test_DeploymentRefusesZeroEqualOrSelfRegistries() public {
        _refuseDeployment(address(0), address(trustees));
        _refuseDeployment(address(elections), address(0));
        _refuseDeployment(address(0), address(0));
        _refuseDeployment(address(elections), address(elections));
        _refuseDeployment(address(trustees), address(trustees));
        _refuseDeployment(_next(), address(trustees));
        _refuseDeployment(address(elections), _next());
        _refuseDeployment(_next(), _next());
    }

    /// The registries are immutables, the ones the deployment names, and the
    /// board's accumulator starts at its genesis with no log.
    function test_DeploymentPinsBothRegistries() public view {
        assertTrue(address(board.electionRegistry()) == address(elections), "election registry");
        assertTrue(address(board.trusteeRegistry()) == address(trustees), "trustee registry");
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        assertEq(count, 0, "no log yet");
        assertEq(
            acc,
            EventAccumulatorLib.genesis(uint64(block.chainid), address(board)),
            "accumulator genesis"
        );
    }

    // --- ballots ---------------------------------------------------------------

    /// An admitted ballot is emitted whole, under its definition hash and
    /// the file's ballot hash, through the accumulator.
    function test_AcceptsAnHonestBallotWithItsEvent() public {
        Vm.Log[] memory logs = _accept(_ballotCall(honestBallot));
        assertEq(logs.length, 1, "one event");
        _assertEvent(logs[0], BALLOT_SUBMITTED, hV1, honestBallotHash, honestBallot);
    }

    /// Every ballot of ballot.json, with `qualified` the key set the trustee
    /// stub holds for the ceremony the election stub names: the file's
    /// admitted ballots are emitted with its ballot hash, a ballot the
    /// verifier rejects only at `option-proof` or `sum-proof` is accepted
    /// (contracts.md, Ballots, What it leaves out), and every other gets the
    /// file's code.
    function test_BallotVectorsUnderTheRegisteredKeySet() public {
        string memory bj = vm.readFile(V1);
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV1(bj, ".elections.approval");
        bytes32 approval = _b32(bj, ".elections.approval.definitionHash");
        elections.set(approval, p, tiers, roots);
        elections.setCeremony(approval, keccak256("approval stub"), PANEL);
        uint256 i;
        for (; vm.keyExistsJson(bj, _at(".ballots", i, "")); i++) {
            _ballotVector(bj, _at(".ballots", i, ""), ["plurality", "approval"], 1);
        }
        assertEq(i, 20, "ballot coverage");
    }

    /// Every ballot of ballot-v3-records.json, as ballot.json's above, under
    /// its version-5 definition's questions and cells: a ballot whose range
    /// proof fails (`sum-proof`) is accepted, the verifier's to reject, and
    /// one shaped for other questions is `validity-shape` (T-28).
    function test_BallotVectorsV3UnderTheRegisteredKeySet() public {
        string memory bj = vm.readFile(V3);
        bytes32 questions = _b32(bj, ".elections.questions.definitionHash");
        elections.setCeremony(questions, keccak256("questions stub"), PANEL);
        uint256 i;
        for (; vm.keyExistsJson(bj, _at(".ballots", i, "")); i++) {
            _ballotVector(bj, _at(".ballots", i, ""), ["questions", "other"], 3);
        }
        assertEq(i, 20, "v3 ballot coverage");
    }

    /// The largest version-3 record a definition allows ([[ballot-validity]],
    /// Committed vote (version 3)): `T = MAX_OPTIONS` options of `k = n =
    /// MAX_TRUSTEES` commitments and `MAX_QUESTIONS` two-option questions of
    /// range 0 to 2, whose 96 range branches are the most `T + Q` allows. It
    /// fits one direct submission: the board frames and checks it whole and
    /// emits it, with the pairing mocked (an honest ballot's proof, whose
    /// pairing the honest ballot below prices), and the transaction stays
    /// under EIP-7825's per-transaction gas cap and op-geth's 128 KiB
    /// transaction size (T-25, T-52).
    function test_TheLargestVersion3BallotFitsOneSubmission() public {
        bytes32 dh = keccak256("largest version-3 definition");
        ElectionRegistry.Parameters memory p;
        (p.ballotVersion, p.threshold, p.panelSize, p.optionCount) = (3, 16, 16, 64);
        (p.opensAt, p.closesAt) = (uint64(block.timestamp), uint64(block.timestamp));
        p.questions = new ElectionRegistry.Question[](32);
        for (uint256 q; q < 32; q++) {
            p.questions[q] = ElectionRegistry.Question(1, 2, 0, 2);
        }
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(dh, p, tiers, roots);
        elections.setCeremony(dh, keccak256("largest stub"), PANEL);
        trustees.setKeySet(keccak256("largest stub"), PANEL, ((1 << 17) - 1) ^ 1);
        bytes memory record = _largestV3(dh);
        // 364 bytes before the vote; `vss` 4 + 64 · (4 + 16 · 32), `share_hashes`
        // 4 + 16 · 32, `option_proofs` 4 + 64 · 128, `sum_proofs` 4 + 32 · 4 + 96 · 64.
        assertEq(record.length, 364 + 33_028 + 516 + 8196 + 6276, "the largest record");
        bytes memory data = _ballotCall(record);
        assertTrue(data.length < 128 * 1024, "op-geth's transaction size");
        // Each measurement on a fresh board, so none is a repeat's no-op.
        uint256 pairing = _gas(_ballotCall(honestBallot));
        _mockPairing();
        board = new Board(address(elections), address(trustees), RELAY);
        pairing -= _gas(_ballotCall(honestBallot));
        board = new Board(address(elections), address(trustees), RELAY);
        uint256 used = _gas(data);
        board = new Board(address(elections), address(trustees), RELAY);
        Vm.Log[] memory logs = _accept(data);
        assertEq(logs.length, 1, "one event");
        _assertEvent(logs[0], BALLOT_SUBMITTED, dh, ballots.ballotHash(record), record);
        // The transaction under EIP-7623: 21,000 plus the larger of its
        // execution (`used` already counts its calldata at the standard
        // price, and the pairing is added back) and its calldata at the
        // floor price (10 a token, 4 tokens a non-zero byte).
        uint256 tokens;
        for (uint256 i; i < data.length; i++) {
            tokens += data[i] == 0 ? 1 : 4;
        }
        uint256 execution = used + pairing;
        uint256 total = 21_000 + (execution > 10 * tokens ? execution : 10 * tokens);
        // Measured about 2.7 million in the call (calldata, framing, the
        // ballot hash over 48 KB, the event and its accumulator step) and
        // 2.9 million for the transaction. Every slot the check reads is
        // warm here, as the test wrote it; a real call pays tens of
        // thousands more for cold reads.
        assertTrue(used < 3_000_000, "the call");
        assertTrue(total < 3_500_000, "the transaction");
        assertTrue(total < 1 << 24, "EIP-7825's cap");
    }

    /// `qualified` is the key set the trustee registry recorded for the
    /// ceremony the election registry names, never anything the submitter
    /// says: the honest ballot fills seats 1 and 2, so a key set without
    /// seat 2, or a ceremony with no key set, refuses it.
    function test_QualifiedSeatsComeFromTheCeremonysKeySet() public {
        trustees.setKeySet(STUB_V1, PANEL, 1 << 1);
        _refuse(
            _ballotCall(honestBallot),
            _ballotRefused(BallotCheckLib.Code.ShareHashUnqualified),
            "seat 2 outside the key set"
        );
        trustees.setKeySet(STUB_V1, PANEL, (1 << 1) | (1 << 2));
        elections.setCeremony(hV1, keccak256("another stub"), PANEL);
        _refuse(
            _ballotCall(honestBallot),
            _ballotRefused(BallotCheckLib.Code.ShareHashUnqualified),
            "a ceremony with no key set"
        );
        elections.setCeremony(hV1, STUB_V1, keccak256("another panel"));
        _refuse(
            _ballotCall(honestBallot),
            _ballotRefused(BallotCheckLib.Code.ShareHashUnqualified),
            "another panel"
        );
        elections.setCeremony(hV1, STUB_V1, PANEL);
        assertEq(_accept(_ballotCall(honestBallot)).length, 1, "admitted under the key set");
    }

    /// A ballot naming no registered definition is stray; one too short to
    /// name an election fails its header, read before anything else.
    function test_RefusesStrayAndShortBallots() public {
        _refuse(
            _ballotCall(_withWord(honestBallot, 3, uint256(keccak256("unregistered")))),
            _ballotRefused(BallotCheckLib.Code.BallotStray),
            "stray"
        );
        _refuse(
            _ballotCall(""),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 0),
            "empty"
        );
        _refuse(
            _ballotCall(_slice(honestBallot, 0, 1)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 0),
            "one byte"
        );
        _refuse(
            _ballotCall(_slice(honestBallot, 0, 2)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 2),
            "two bytes"
        );
        _refuse(
            _ballotCall(_slice(honestBallot, 0, 34)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 3),
            "34 bytes"
        );
        _refuse(
            _ballotCall(_slice(honestBallot, 0, 35)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 35),
            "35 bytes"
        );
    }

    // --- receipts --------------------------------------------------------------

    /// delivery.json's receipt is emitted whole under its definition hash and
    /// the ballot hash of the file's ballot it names.
    function test_AcceptsAnHonestReceiptWithItsEvent() public {
        Vm.Log[] memory logs = _accept(_receiptsCall(receipt));
        assertEq(logs.length, 1, "one event");
        _assertEvent(logs[0], RECEIPT_SUBMITTED, h, aliceHash, receipt);
    }

    /// A batch emits one event per receipt not accepted before, in order,
    /// skipping repeats inside the batch and across batches.
    function test_BatchEmitsOncePerNewReceipt() public {
        bytes[3] memory r = allReceipted;
        Vm.Log[] memory logs = _accept(_receiptsCall(bytes.concat(r[0], r[1], r[0])));
        assertEq(logs.length, 2, "two new receipts");
        _assertEvent(logs[0], RECEIPT_SUBMITTED, h, aliceHash, r[0]);
        _assertEvent(logs[1], RECEIPT_SUBMITTED, h, aliceHash, r[1]);
        logs = _accept(_receiptsCall(bytes.concat(r[1], r[2], r[2])));
        assertEq(logs.length, 1, "one new receipt");
        _assertEvent(logs[0], RECEIPT_SUBMITTED, h, aliceHash, r[2]);
        assertEq(_accept(_receiptsCall(bytes.concat(r[2], r[0], r[1]))).length, 0, "all repeats");
    }

    /// The argument is a non-zero multiple of 164 bytes, checked before any
    /// receipt in it.
    function test_BatchLengthMustBeANonZeroMultipleOf164() public {
        uint256[6] memory lengths = [uint256(0), 1, 163, 165, 228, 2 * 164 + 1];
        bytes memory three = bytes.concat(receipt, receipt, receipt);
        for (uint256 i; i < lengths.length; i++) {
            _refuse(
                _receiptsCall(_slice(three, 0, lengths[i])),
                abi.encodeWithSelector(Board.ReceiptBatchLength.selector, lengths[i]),
                vm.toString(lengths[i])
            );
        }
    }

    /// A failing receipt reverts its whole batch, naming its position, and
    /// leaves nothing remembered: the receipts before it are accepted later.
    function test_AFailingReceiptRevertsTheWholeBatchNamingIt() public {
        bytes[3] memory r = allReceipted;
        bytes memory highS = receiptHighS;
        _refuse(
            _receiptsCall(bytes.concat(r[0], r[1], highS)),
            _malformed(2, ElectionDefinitionLib.DecodeError.NonCanonical, RECEIPT_SIG_AT),
            "high-s third"
        );
        _refuse(
            _receiptsCall(bytes.concat(r[0], _withByte(r[1], RECEIPT_LENGTH - 1, 0))),
            _refused(1, DeliveryCheckLib.Code.DeliverySignature),
            "bad signature second"
        );
        _refuse(
            _receiptsCall(bytes.concat(_withWord(r[2], 3, 1), r[0])),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "stray first"
        );
        assertEq(_accept(_receiptsCall(bytes.concat(r[0], r[1]))).length, 2, "none remembered");
    }

    /// Every decode rejection of delivery.json, through the call for the
    /// type the file reads it as, with the file's code at the field the
    /// spec's layout puts it (the file gives no offsets). A receipt one byte
    /// short or long, or a complaint read as a receipt, is no batch of
    /// 164-byte receipts (contracts.md, Calls); the complaint's first 164
    /// bytes are then refused by their type.
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
                // The call frames each receipt by its version byte: 165
                // bytes at version 2, 164 otherwise.
                uint256 framed = enc[2] == 0x02 ? RECEIPT_LENGTH + 1 : RECEIPT_LENGTH;
                if (enc.length % framed != 0) {
                    _refuse(
                        _receiptsCall(enc),
                        abi.encodeWithSelector(Board.ReceiptBatchLength.selector, enc.length),
                        id
                    );
                    // Only the complaint read as a receipt, and the receipt
                    // labelled version 2, say something more in a framed
                    // record: their type, and their version under ballot
                    // version 1, refused before any field is read.
                    if (code == ElectionDefinitionLib.DecodeError.UnexpectedRecordType) {
                        enc = _slice(enc, 0, framed);
                    } else if (code == ElectionDefinitionLib.DecodeError.ProfileMismatch) {
                        enc = bytes.concat(enc, hex"00");
                    } else {
                        continue;
                    }
                }
                _refuse(_receiptsCall(enc), _malformed(0, code, _decodeOffset(id)), id);
            } else if (_eq(t, "share-posting")) {
                _refuse(_postingCall(enc, alice), _malformed(0, code, _decodeOffset(id)), id);
            } else {
                assertTrue(_eq(t, "share-complaint"), id);
                _refuse(_complaintCall(enc), _malformed(0, code, _decodeOffset(id)), id);
            }
        }
        assertEq(i, 15, "decode coverage");
    }

    /// share-receipt.json's receipt checks, each a record under the file's
    /// definition and the panel the check names: the board accepts exactly
    /// the valid ones, and refuses each other as its description says. Every
    /// invalid check changes a signed byte or the key it is checked under,
    /// so none depends on what the board can't see (the share hash against
    /// the ballot, contracts.md, Delivery records).
    function test_ShareReceiptVectors() public {
        string memory sr = vm.readFile(RECEIPTS);
        bytes32 dh = _b32(sr, ".receiptChecks[0].definitionHash");
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 1;
        _setParameters(dh, p);
        elections.setCeremony(dh, STUB_RECEIPTS, PANEL);
        uint256 i;
        uint256 valid;
        for (; vm.keyExistsJson(sr, _at(".receiptChecks", i, "")); i++) {
            string memory c = _at(".receiptChecks", i, "");
            string memory id = _str(sr, string.concat(c, ".id"));
            // A board of its own: `other-panel` is `valid`'s bytes, and a
            // repeat checks nothing (Calls).
            board = new Board(address(elections), address(trustees), RELAY);
            _setPanel(sr, string.concat(".panels.", _str(sr, string.concat(c, ".panel"))));
            bytes memory r = abi.encodePacked(
                uint16(0x000c),
                uint8(1),
                _b32(sr, string.concat(c, ".definitionHash")),
                _b32(sr, string.concat(c, ".ballotHash")),
                uint8(vm.parseJsonUint(sr, string.concat(c, ".seat"))),
                _b32(sr, string.concat(c, ".shareHash")),
                _bytes(sr, string.concat(c, ".signature"))
            );
            if (vm.parseJsonBool(sr, string.concat(c, ".valid"))) {
                valid++;
                Vm.Log[] memory logs = _accept(_receiptsCall(r));
                assertEq(logs.length, 1, id);
                _assertEvent(
                    logs[0], RECEIPT_SUBMITTED, dh, _b32(sr, string.concat(c, ".ballotHash")), r
                );
            } else {
                _refuse(_receiptsCall(r), _receiptCheckVerdict(id, r.length), id);
            }
        }
        assertEq(i, 16, "receipt check coverage");
        assertEq(valid, 2, "valid receipts");
    }

    /// Every delivery record of delivery.json's elections, submitted through
    /// the contract path to a board of its own under the election's key set,
    /// gets the verdict the file's delivery check implies for the parts the
    /// board checks (contracts.md, Delivery records): `delivery-seat`,
    /// `delivery-stray` and `posting-hash` are refused as such; a receipt or
    /// complaint the file attributes to no seat fails its signature; a
    /// rejected entry fails its decoding. Everything else is accepted: the
    /// board leaves out whether a record is in time, whether a receipt's
    /// share hash is the ballot's, whether a posting passes the public check
    /// and whether a complaint is proven or void (What the board leaves out).
    /// A posting that reached the board through the board path is rejected
    /// by its path alone (delivery.md, Decoding), which says nothing of the
    /// contract path, so it is skipped.
    function test_ElectionVectorsThroughTheContractPath() public {
        _mockPairing();
        string memory dj = vm.readFile(DELIVERY);
        uint256[3] memory n; // accepted, refused, skipped
        for (uint256 i; vm.keyExistsJson(dj, _at(".elections", i, "")); i++) {
            string memory e = _at(".elections", i, "");
            board = new Board(address(elections), address(trustees), RELAY);
            trustees.setKeySet(STUB, PANEL, _registered(dj, e));
            for (uint256 j; vm.keyExistsJson(dj, _at(string.concat(e, ".entries"), j, "")); j++) {
                string memory en = _at(string.concat(e, ".entries"), j, "");
                bytes memory payload = _bytes(dj, string.concat(en, ".payload"));
                uint256 t = payload.length < 2 ? 0x000c : _type(payload);
                bool boardPath = _eq(_str(dj, string.concat(en, ".path")), "board");
                if (t == 0x0002 || (t == 0x000d && boardPath)) {
                    n[2]++;
                    continue;
                }
                bytes memory call_ = t == 0x000c
                    ? _receiptsCall(payload)
                    : t == 0x000d
                        ? _postingCall(payload, _ballotFor(dj, e, payload))
                        : _complaintCall(payload);
                string memory what =
                    string.concat(_str(dj, string.concat(e, ".id")), " entry ", vm.toString(j));
                (bool refusedAtAll, bytes memory expected, bool anyOffset) =
                    _electionVerdict(dj, e, j, payload, t);
                if (!refusedAtAll) {
                    n[0]++;
                    Vm.Log[] memory logs = _accept(call_);
                    assertTrue(logs.length <= 1, what);
                    if (logs.length == 1) {
                        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(payload)), what);
                    }
                } else if (anyOffset) {
                    n[1]++;
                    _refuseAnyOffset(call_, expected, what);
                } else {
                    n[1]++;
                    _refuse(call_, expected, what);
                }
            }
        }
        assertEq(n[0], 107, "accepted coverage");
        assertEq(n[1], 10, "refused coverage");
        assertEq(n[2], 5, "skipped coverage");
    }

    /// The steps run in the spec's order (contracts.md, Delivery records):
    /// the election before the version, the version before the fields, the
    /// fields before the seat, the seat before the signature; a pinned
    /// ballot version above 4 is `unknown-version` before `profile-mismatch`,
    /// and ballot version 4 fixes version 2 (Delivery records (version 2)).
    function test_DeliveryCheckOrder() public {
        bytes memory highS = receiptHighS;
        // Labelled version 2, so framed as 165 bytes.
        bytes memory v2HighS = bytes.concat(_withByte(highS, 2, 2), hex"00");
        _refuse(
            _receiptsCall(_withWord(v2HighS, 3, 1)),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "stray before version"
        );
        _refuse(
            _receiptsCall(v2HighS),
            _malformed(0, ElectionDefinitionLib.DecodeError.ProfileMismatch, 2),
            "version before fields"
        );
        trustees.setKeySet(STUB, PANEL, 0);
        _refuse(
            _receiptsCall(highS),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, RECEIPT_SIG_AT),
            "fields before seat"
        );
        _refuse(
            _receiptsCall(_withByte(receipt, RECEIPT_LENGTH - 1, 0)),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat before signature"
        );

        ElectionRegistry.Parameters memory p = elections.parameters(h);
        p.ballotVersion = 4;
        _setParameters(h, p);
        bytes memory mismatch = _malformed(0, ElectionDefinitionLib.DecodeError.ProfileMismatch, 2);
        _refuse(_receiptsCall(receipt), mismatch, "receipt under ballot version 4");
        _refuse(_complaintCall(complaint), mismatch, "complaint under ballot version 4");
        _refuse(_postingCall(posting, alice), mismatch, "posting under ballot version 4");

        p.ballotVersion = 5;
        _setParameters(h, p);
        bytes memory unknown = _malformed(0, ElectionDefinitionLib.DecodeError.UnknownVersion, 2);
        _refuse(_receiptsCall(receipt), unknown, "receipt under ballot version 5");
        _refuse(_receiptsCall(v2HighS), unknown, "version 2 under ballot version 5");
        _refuse(_complaintCall(complaint), unknown, "complaint under ballot version 5");
        _refuse(_postingCall(posting, alice), unknown, "posting under ballot version 5");
    }

    /// The seat's registered signing key decides: pointing seat 1's at seat
    /// 2's refuses seat 1's receipt, and seat 0 or a seat outside the key
    /// set is refused before any key is read.
    function test_ReceiptSeatAndSignature() public {
        trustees.setKey(STUB, PANEL, 1, signingKeys[2][0], signingKeys[2][1]);
        _refuse(
            _receiptsCall(receipt),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat's key"
        );
        trustees.setKey(STUB, PANEL, 1, signingKeys[1][0], signingKeys[1][1]);
        trustees.setKeySet(STUB, PANEL, (1 << 2) | (1 << 3));
        _refuse(
            _receiptsCall(receipt), _refused(0, DeliveryCheckLib.Code.DeliverySeat), "seat outside"
        );
        trustees.setKeySet(STUB, PANEL, type(uint256).max);
        _refuse(
            _receiptsCall(_withByte(receipt, SEAT_AT, 0)),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 0 even in a key set with bit 0"
        );
        trustees.setKeySet(STUB, PANEL, registeredAll);
        _refuse(
            _receiptsCall(_withByte(receipt, SEAT_AT, 0)),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 0"
        );
        _refuse(
            _receiptsCall(_withByte(receipt, SEAT_AT, 4)),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 4"
        );
        assertEq(_accept(_receiptsCall(receipt)).length, 1, "restored");
    }

    // --- complaints ------------------------------------------------------------

    function test_AcceptsAnHonestComplaintWithItsEvent() public {
        Vm.Log[] memory logs = _accept(_complaintCall(complaint));
        assertEq(logs.length, 1, "one event");
        _assertEvent(logs[0], COMPLAINT_SUBMITTED, h, carolHash, complaint);
    }

    function test_ComplaintSeatAndSignature() public {
        trustees.setKeySet(STUB, PANEL, (1 << 1) | (1 << 3));
        _refuse(
            _complaintCall(complaint),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat outside"
        );
        trustees.setKeySet(STUB, PANEL, registeredAll);
        trustees.setKey(STUB, PANEL, 2, signingKeys[1][0], signingKeys[1][1]);
        _refuse(
            _complaintCall(complaint),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat's key"
        );
        trustees.setKey(STUB, PANEL, 2, signingKeys[2][0], signingKeys[2][1]);
        // The same proof re-signed by seat 2 for seat 3: seat 3's key doesn't verify it.
        _refuse(
            _complaintCall(_withByte(complaint, SEAT_AT, 3)),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat named"
        );
        // A complaint seat 2 signs for another ballot hash is accepted: the
        // board can't run the proof (contracts.md, Delivery records).
        bytes memory body = _slice(complaint, 3, COMPLAINT_SIG_AT - 3);
        body = _withWord(body, BALLOT_HASH_AT - 3, uint256(aliceHash));
        bytes memory resigned = _signed(0x000e, body, signingSecrets[2]);
        Vm.Log[] memory logs = _accept(_complaintCall(resigned));
        assertEq(logs.length, 1, "re-signed complaint");
        _assertEvent(logs[0], COMPLAINT_SUBMITTED, h, aliceHash, resigned);
    }

    // --- postings --------------------------------------------------------------

    /// A posting with the record of the ballot it delivers is emitted alone:
    /// the event carries the posting and nothing of the ballot. Its repeat
    /// is the posting's bytes, whatever ballot record carries it.
    function test_AcceptsAnHonestPostingWithItsEvent() public {
        _mockPairing();
        Vm.Log[] memory logs = _accept(_postingCall(posting, alice));
        assertEq(logs.length, 1, "one event");
        _assertEvent(logs[0], SHARE_POSTED, h, aliceHash, posting);
        bytes memory otherProof = _withWord(alice, BallotCheckLib.PROOF_AT, 7);
        assertEq(_accept(_postingCall(posting, otherProof)).length, 0, "a repeat");
    }

    /// The board can't check `m`, so a posting with any other `m` is another
    /// posting, accepted beside the first: none occupies a slot (delivery.md,
    /// Direct submit; T-54).
    function test_AnyNumberOfPostingsPerSeat() public {
        _mockPairing();
        _accept(_postingCall(posting, alice));
        bytes memory otherM = _withWord(posting, M_AT, uint256(keccak256("another m")));
        Vm.Log[] memory logs = _accept(_postingCall(otherM, alice));
        assertEq(logs.length, 1, "another posting");
        _assertEvent(logs[0], SHARE_POSTED, h, aliceHash, otherM);
    }

    function test_PostingRefusals() public {
        _mockPairing();
        trustees.setKeySet(STUB, PANEL, (1 << 1) | (1 << 2));
        _refuse(
            _postingCall(posting, alice),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat outside"
        );
        trustees.setKeySet(STUB, PANEL, (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4));

        // `sealed` must be 4 + 64·T + 16 bytes for the definition's T.
        ElectionRegistry.Parameters memory p = elections.parameters(h);
        uint16 t = p.optionCount;
        p.optionCount = t + 1;
        _setParameters(h, p);
        _refuse(
            _postingCall(posting, alice),
            _refused(0, DeliveryCheckLib.Code.PostingLength),
            "another option count"
        );
        p.optionCount = t;
        _setParameters(h, p);

        // The ballot, which passes its check, must be the posting's: its
        // ballot hash, which binds its election.
        bytes memory otherNullifier = _withWord(
            alice, BallotCheckLib.NULLIFIER_AT, _word(alice, BallotCheckLib.NULLIFIER_AT) + 1
        );
        _refuse(
            _postingCall(posting, otherNullifier),
            _refused(0, DeliveryCheckLib.Code.PostingBallot),
            "another nullifier"
        );
        bytes32 other = keccak256("another definition");
        bytes memory otherDefinition = _withWord(alice, 3, uint256(other));
        _refuse(
            _postingCall(posting, otherDefinition),
            _ballotRefused(BallotCheckLib.Code.BallotStray),
            "a ballot of an unregistered definition"
        );
        _setParameters(other, p);
        elections.setCeremony(other, STUB, PANEL);
        _refuse(
            _postingCall(posting, otherDefinition),
            _refused(0, DeliveryCheckLib.Code.PostingBallot),
            "a ballot of another definition"
        );
        // The posting's own definition hash, which its ballot hash doesn't
        // bind, must be the ballot's too: here it names another registered
        // election with the same option count and key set, so every check
        // judged against it passes, and only this comparison refuses it.
        _refuse(
            _postingCall(_withWord(posting, 3, uint256(other)), alice),
            _refused(0, DeliveryCheckLib.Code.PostingBallot),
            "a posting naming another registered election"
        );

        // The ciphertext must be the one the ballot committed to for the seat.
        _refuse(
            _postingCall(_withByte(posting, SEAT_AT, 1), alice),
            _refused(0, DeliveryCheckLib.Code.PostingHash),
            "another qualified seat"
        );
        // Only a stub's key set has a seat beyond `n`: the real registries
        // record key sets of the definition's own panel.
        _refuse(
            _postingCall(_withByte(posting, SEAT_AT, 4), alice),
            _refused(0, DeliveryCheckLib.Code.PostingHash),
            "a seat beyond the ballot's share count"
        );

        // A ballot that fails its check gets the ballot check's error.
        _refuse(
            _postingCall(posting, _slice(alice, 0, 1)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.Truncated, 0),
            "a one-byte ballot"
        );
        _refuse(
            _postingCall(posting, bytes.concat(alice, hex"00")),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.TrailingBytes, alice.length),
            "a ballot with a trailing byte"
        );
        _refuse(
            _postingCall(posting, _withByte(alice, 2, 2)),
            _ballotMalformed(ElectionDefinitionLib.DecodeError.ProfileMismatch, 2),
            "a ballot of another version"
        );
        _refuse(
            _postingCall(posting, _withByte(alice, BallotCheckLib.TIER_AT, 2)),
            _ballotRefused(BallotCheckLib.Code.BallotTier),
            "a ballot of a tier with no cell"
        );
        assertEq(_accept(_postingCall(posting, alice)).length, 1, "restored");
    }

    /// Decoding, then the seat, then the length, then the ballot.
    function test_PostingCheckOrder() public {
        bytes memory identityDh = postingIdentityDh;
        trustees.setKeySet(STUB, PANEL, 0);
        _refuse(
            _postingCall(identityDh, ""),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, CT_DH_AT),
            "decoding before the seat and the ballot"
        );
        ElectionRegistry.Parameters memory p = elections.parameters(h);
        p.optionCount += 1;
        _setParameters(h, p);
        _refuse(
            _postingCall(posting, ""),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "the seat before the length"
        );
        trustees.setKeySet(STUB, PANEL, registeredAll);
        _refuse(
            _postingCall(posting, ""),
            _refused(0, DeliveryCheckLib.Code.PostingLength),
            "the length before the ballot"
        );
    }

    /// The reviewer's attack: a ballot made up to commit to a ciphertext of
    /// one's choice (no options, one share hash, no proofs) carrying a
    /// posting of that ciphertext, which would archive chosen bytes (T-17).
    /// The posting's ballot must pass the whole ballot check, so it fails
    /// its shape, with the pairing mocked or not; a ballot of the right
    /// shape fails its membership proof unmocked, and one with a share hash
    /// at a seat outside the key set fails `share-hash-unqualified`.
    function test_AFabricatedBallotCannotCarryAPosting() public {
        uint256 options = elections.parameters(h).optionCount;
        bytes memory mlkem = new bytes(1088);
        for (uint256 i; i < mlkem.length; i++) {
            mlkem[i] = bytes1(uint8(0x61 + (i % 26)));
        }
        bytes memory ct = abi.encodePacked(
            mlkem,
            _le(2),
            uint256(0),
            uint256(0),
            uint32(4 + 64 * options + 16),
            new bytes(4 + 64 * options + 16)
        );
        bytes32 shareHash = sha256(bytes.concat(_ds("abolish/v1/share-ciphertext"), ct));
        bytes memory fabricated = abi.encodePacked(
            _slice(alice, 0, BallotCheckLib.VOTE_AT),
            uint32(0),
            uint32(1),
            shareHash,
            uint32(0),
            uint32(0)
        );
        bytes memory chosen = abi.encodePacked(
            uint16(0x000d),
            uint8(1),
            h,
            ballots.ballotHash(fabricated),
            uint8(1),
            keccak256("any m"),
            ct
        );
        bytes memory shape = _ballotRefused(BallotCheckLib.Code.ValidityShape);
        _refuse(_postingCall(chosen, fabricated), shape, "fabricated, unmocked");
        _mockPairing();
        _refuse(_postingCall(chosen, fabricated), shape, "fabricated, mocked");
        vm.clearMockedCalls();

        _refuse(
            _postingCall(posting, alice),
            _ballotRefused(BallotCheckLib.Code.MembershipProof),
            "a ballot whose membership proof fails"
        );
        // Seat 1 outside the key set, where Alice's ballot has a share hash.
        trustees.setKeySet(STUB, PANEL, (1 << 2) | (1 << 3));
        _refuse(
            _postingCall(posting, alice),
            _ballotRefused(BallotCheckLib.Code.ShareHashUnqualified),
            "a share hash at an unqualified seat"
        );
    }

    /// A complaint's `D` is refused odd or at or above `2²⁵⁵ − 19` and
    /// framed below it when even; its `z` is refused at `ℓ` and framed at
    /// `ℓ − 1`. Each is re-signed by seat 2, so only framing can refuse it,
    /// and a framed one is accepted: the board doesn't run the proof.
    function test_ComplaintElementAndScalarFraming() public {
        bytes memory body = _slice(complaint, 3, COMPLAINT_SIG_AT - 3);
        uint256 d = _le(_word(complaint, COMPLAINT_D_AT));
        assertTrue(d & 1 == 0 && d + 1 < P25519, "the honest D");
        uint256 dAt = COMPLAINT_D_AT - 3;
        uint256 zAt = COMPLAINT_Z_AT - 3;
        bytes memory nonCanonicalD =
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, COMPLAINT_D_AT);
        _refuse(
            _complaintCall(_signed(0x000e, _withWord(body, dAt, _le(d + 1)), signingSecrets[2])),
            nonCanonicalD,
            "odd D"
        );
        _refuse(
            _complaintCall(
                _signed(0x000e, _withWord(body, dAt, _le(P25519 + 1)), signingSecrets[2])
            ),
            nonCanonicalD,
            "even D above p"
        );
        _refuse(
            _complaintCall(
                _signed(0x000e, _withWord(body, dAt, _le(P25519 - 2)), signingSecrets[2])
            ),
            nonCanonicalD,
            "odd D below p"
        );
        _refuse(
            _complaintCall(_signed(0x000e, _withWord(body, zAt, _le(ELL)), signingSecrets[2])),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, COMPLAINT_Z_AT),
            "z at l"
        );
        assertEq(
            _accept(
                _complaintCall(
                    _signed(0x000e, _withWord(body, dAt, _le(P25519 - 1)), signingSecrets[2])
                )
            )
            .length,
            1,
            "even D below p"
        );
        assertEq(
            _accept(
                _complaintCall(
                    _signed(0x000e, _withWord(body, zAt, _le(ELL - 1)), signingSecrets[2])
                )
            )
            .length,
            1,
            "z below l"
        );
    }

    /// A signature's `r` is refused at 0 and at `n`, and its `s` at 0, as
    /// `non-canonical` at the signature, before any key is read.
    function test_SignatureFraming() public {
        bytes memory body = _slice(receipt, 3, RECEIPT_SIG_AT - 3);
        uint256 r = _word(receipt, RECEIPT_SIG_AT);
        uint256 s = _word(receipt, RECEIPT_SIG_AT + 32);
        bytes memory nonCanonical =
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, RECEIPT_SIG_AT);
        uint256[2][4] memory sigs = [[uint256(0), s], [P256_N, s], [P256_N + 1, s], [r, uint256(0)]];
        for (uint256 i; i < sigs.length; i++) {
            _refuse(
                _receiptsCall(
                    abi.encodePacked(uint16(0x000c), uint8(1), body, sigs[i][0], sigs[i][1])
                ),
                nonCanonical,
                string.concat("signature ", vm.toString(i))
            );
        }
        bytes memory cbody = _slice(complaint, 3, COMPLAINT_SIG_AT - 3);
        _refuse(
            _complaintCall(abi.encodePacked(uint16(0x000e), uint8(1), cbody, uint256(0), s)),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, COMPLAINT_SIG_AT),
            "a complaint's r at 0"
        );
    }

    /// A posting's `pok_c` is refused at `ℓ`, before its ballot is read.
    function test_PostingScalarFraming() public {
        _refuse(
            _postingCall(_withWord(posting, POK_C_AT, _le(ELL)), ""),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, POK_C_AT),
            "pok_c at l"
        );
        _refuse(
            _postingCall(_withWord(posting, CT_DH_AT, _le(P25519 + 1)), ""),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, CT_DH_AT),
            "ct_dh above p"
        );
        _refuse(
            _postingCall(_withWord(posting, CT_DH_AT, _le(3)), ""),
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, CT_DH_AT),
            "odd ct_dh"
        );
    }

    // --- calls -----------------------------------------------------------------

    /// Every call takes exactly the standard ABI encoding of its arguments:
    /// a trailing word, dirty padding, a moved or zero offset, or (for the
    /// posting) tails in the other order is refused, and nothing is emitted.
    function test_EveryCallRefusesNonCanonicalCalldata() public {
        _mockPairing();
        _assertCanonicalOnly(_ballotCall(honestBallot));
        _assertCanonicalOnly(_receiptsCall(receipt));
        _assertCanonicalOnly(_complaintCall(complaint));
        _assertCanonicalOnly(_rootCall(_bytes(vm.readFile(ROOTS), ".records[0].encoding")));

        bytes memory good = _postingCall(posting, alice);
        uint256 paddedA = (posting.length + 31) / 32 * 32;
        uint256 paddedB = (alice.length + 31) / 32 * 32;
        assertTrue(paddedA != posting.length && paddedB != alice.length, "both need padding");
        bytes memory tailA = _slice(good, 68, 32 + paddedA);
        bytes memory tailB = _slice(good, 100 + paddedA, 32 + paddedB);
        bytes4 sel = Board.submitPosting.selector;
        bytes[5] memory bad = [
            abi.encodePacked(good, bytes32(0)),
            _withByte(good, 100 + posting.length, 1),
            _withByte(good, good.length - 1, 1),
            abi.encodePacked(sel, uint256(0x60), uint256(0x80 + paddedA), uint256(0), tailA, tailB),
            abi.encodePacked(sel, uint256(0x60 + paddedB), uint256(0x40), tailB, tailA)
        ];
        for (uint256 i; i < bad.length; i++) {
            _refuse(
                bad[i],
                abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector),
                string.concat("posting calldata ", vm.toString(i))
            );
        }
        assertEq(_accept(good).length, 1, "canonical posting calldata");
    }

    /// Topic 0 of each event is the keccak-256 of the spec's signature.
    function test_EventSignaturesAreTheSpecs() public pure {
        assertEq(Board.BallotSubmitted.selector, BALLOT_SUBMITTED, "BallotSubmitted");
        assertEq(Board.ShareReceiptSubmitted.selector, RECEIPT_SUBMITTED, "ShareReceiptSubmitted");
        assertEq(Board.SharePosted.selector, SHARE_POSTED, "SharePosted");
        assertEq(
            Board.ShareComplaintSubmitted.selector, COMPLAINT_SUBMITTED, "ShareComplaintSubmitted"
        );
        assertEq(Board.ShareReceiptBatchSubmitted.selector, BATCH_SUBMITTED, "receipt batch");
        assertEq(
            Board.ShareComplaintBatchSubmitted.selector,
            COMPLAINT_BATCH_SUBMITTED,
            "complaint batch"
        );
        assertEq(Board.ObligationRootSubmitted.selector, ROOT_SUBMITTED, "ObligationRootSubmitted");
    }

    /// A byte-identical record is accepted again as a no-op by any call:
    /// it succeeds, emits nothing and leaves the accumulator as it was.
    function test_ByteIdenticalRepeatsAreNoOps() public {
        _mockPairing();
        bytes[5] memory calls = [
            _ballotCall(honestBallot),
            _receiptsCall(receipt),
            _postingCall(posting, alice),
            _complaintCall(complaint),
            _rootCall(_bytes(vm.readFile(ROOTS), ".records[0].encoding"))
        ];
        for (uint256 i; i < calls.length; i++) {
            assertEq(_accept(calls[i]).length, 1, "first");
        }
        for (uint256 i; i < calls.length; i++) {
            assertEq(_accept(calls[i]).length, 0, "repeat");
        }
    }

    // --- the real registries -----------------------------------------------------

    /// The board reads the ceremony the election registry recorded at
    /// registration: a receipt signed by delivery.json's seat 1 for the
    /// registered definition is accepted when the trustee registry holds the
    /// key set under that stub hash and panel, and refused as `delivery-seat`
    /// when it holds it under another stub hash.
    function test_ReadsTheCeremonyFromTheElectionRegistry() public {
        RegistryFixture.installL1Block(vm);
        MockTrusteeRegistry approvals = new MockTrusteeRegistry();
        ElectionRegistry registry =
            new ElectionRegistry(RegistryFixture.deployment(address(approvals)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
        vm.prank(address(0xC4EA));
        bytes32 id = registry.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        (d.threshold, d.panelSize) = (2, 3);
        bytes memory enc = RegistryFixture.approve(defs, approvals, d);
        vm.prank(address(0xC4EA));
        registry.registerDefinition(enc);
        bytes32 dh = defs.hash(enc);
        (bytes32 stub, bytes32 panel) = registry.ceremony(dh);
        assertEq(stub, defs.stubHash(enc), "the ceremony's stub hash");
        assertEq(panel, d.panelId, "the ceremony's panel");

        TrusteesStub keys = new TrusteesStub();
        keys.setKeySet(stub, panel, registeredAll);
        keys.setKey(stub, panel, 1, signingKeys[1][0], signingKeys[1][1]);
        board = new Board(address(registry), address(keys), RELAY);
        bytes memory r = _receiptFor(dh, 1, signingSecrets[1]);
        Vm.Log[] memory logs = _accept(_receiptsCall(r));
        assertEq(logs.length, 1, "accepted under the registered ceremony");
        _assertEvent(logs[0], RECEIPT_SUBMITTED, dh, aliceHash, r);
        _refuse(
            _receiptsCall(receipt),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "delivery.json's definition isn't registered here"
        );

        TrusteesStub elsewhere = new TrusteesStub();
        elsewhere.setKeySet(keccak256("another stub"), panel, registeredAll);
        elsewhere.setKey(keccak256("another stub"), panel, 1, signingKeys[1][0], signingKeys[1][1]);
        board = new Board(address(registry), address(elsewhere), RELAY);
        _refuse(
            _receiptsCall(r),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "a key set under another stub hash"
        );
    }

    /// Both registries real: the trustee registry records a key set whose
    /// seats 1 to 3 hold delivery.json's signing keys, approved by a quorum
    /// of trustee.json's panel, and the election registry registers a
    /// definition for that ceremony. The board accepts seat 1's receipt; a
    /// seat outside the key set is `delivery-seat` and another seat's
    /// signature `delivery-signature`; and a ballot of the wrong shape reaches
    /// `validity-shape` with `qualified` read from the real registry.
    function test_ReadsARealTrusteeRegistry() public {
        bytes32 dh = _realRegistries();
        bytes memory r1 = _receiptFor(dh, 1, signingSecrets[1]);
        Vm.Log[] memory logs = _accept(_receiptsCall(r1));
        assertEq(logs.length, 1, "seat 1's receipt");
        _assertEvent(logs[0], RECEIPT_SUBMITTED, dh, aliceHash, r1);
        _refuse(
            _receiptsCall(_receiptFor(dh, 5, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 5 isn't in the key set"
        );
        _refuse(
            _receiptsCall(_receiptFor(dh, 2, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "seat 2's receipt signed by seat 1"
        );
        // ballot.json's honest ballot (k = 2, n = 3) under this definition
        // (k = 4, n = 7) frames and fails its shape.
        _refuse(
            _ballotCall(_withWord(honestBallot, 3, uint256(dh))),
            _ballotRefused(BallotCheckLib.Code.ValidityShape),
            "a ballot of another shape"
        );
    }

    /// A real trustee registry (trustee.json's `panel-4-of-7`, seats 1 to 3
    /// holding delivery.json's signing keys) and a real election registry with
    /// one definition registered under it, and `board` reading both; returns
    /// the definition's hash.
    function _realRegistries() internal returns (bytes32 dh) {
        string memory tj = vm.readFile(TrusteeFixture.VECTORS);
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](1);
        panels[0] = TrusteeFixture.panel(tj, "panel-4-of-7", 4);
        TrusteeRegistry treg = new TrusteeRegistry(panels);
        bytes32 panel = treg.panelIds(0);

        RegistryFixture.installL1Block(vm);
        ElectionRegistry registry = new ElectionRegistry(RegistryFixture.deployment(address(treg)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
        vm.prank(address(0xC4EA));
        bytes32 id = registry.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.panelId = panel;
        (d.threshold, d.panelSize) = (4, 7);
        d.ceremonyTranscriptHash = keccak256("transcript");
        bytes memory enc = DefinitionEncoder.encode(d);
        bytes32 stub = defs.stubHash(enc);

        _registerCeremony(treg, tj, stub, d.ceremonyTranscriptHash);
        vm.prank(address(0xC4EA));
        registry.registerDefinition(enc);
        dh = defs.hash(enc);

        board = new Board(address(registry), address(treg), RELAY);
        realElections = address(registry);
        realTrustees = address(treg);
    }

    /// Records a key set for `stub` in `treg`'s one panel, approved by seats
    /// 1 to 4 of trustee.json's `panel-4-of-7`: seats 1 to 3 hold
    /// delivery.json's signing keys, seat 4 another valid key
    /// (share-receipt.json's panel-3 seat 1), since the key set needs the
    /// threshold's four seats.
    function _registerCeremony(
        TrusteeRegistry treg,
        string memory tj,
        bytes32 stub,
        bytes32 transcript
    ) internal {
        bytes32 panel = treg.panelIds(0);
        TrusteeFixture.Seat[] memory seats = new TrusteeFixture.Seat[](4);
        for (uint8 s = 1; s <= 3; s++) {
            seats[s - 1] = TrusteeFixture.Seat(
                s, sha256(abi.encode("kem", s)), signingKeys[s][0], signingKeys[s][1]
            );
        }
        (uint256 x4, uint256 y4,) =
            TrusteeFixture.point(_bytes(vm.readFile(RECEIPTS), ".panels.panel-3[0].signingKey"));
        seats[3] = TrusteeFixture.Seat(4, sha256(abi.encode("kem", 4)), x4, y4);
        bytes32 keySetHash = new TrusteeHarness().keySetHash(TrusteeFixture.seatBytes(seats));
        TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](4);
        for (uint8 s = 1; s <= 4; s++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid), address(treg), panel, s, stub, transcript, keySetHash
            );
            (uint256 r, uint256 sig) = TrusteeFixture.sign(TrusteeFixture.secret(tj, s), digest);
            a[s - 1] = TrusteeFixture.Approval(s, r, sig);
        }
        treg.registerCeremony(TrusteeFixture.encode(panel, stub, transcript, seats, a));
    }

    // --- share-receipt batches ------------------------------------------------------

    /// delivery-batch.json is made from delivery.json's panel and definition,
    /// so the stubs set from delivery.json hold its seats' keys.
    function test_BatchVectorsShareDeliveryJsonsElection() public view {
        string memory bj = vm.readFile(BATCHES);
        assertTrue(_eq(_str(bj, ".format"), "abolish-delivery-batch-vectors/1"), "batch format");
        assertEq(_b32(bj, ".definitionHash"), h, "the definition");
        for (uint256 i; i < 3; i++) {
            assertEq(
                keccak256(_bytes(bj, _at(".panel", i, ".signingKey"))),
                keccak256(_bytes(vm.readFile(DELIVERY), _at(".panel", i, ".signingKey"))),
                "the panel"
            );
        }
        assertEq(vm.parseJsonUint(bj, ".maxPairs"), DeliveryCheckLib.BATCH_MAX, "the maximum");
    }

    /// Every batch of delivery-batch.json is accepted and emitted whole, its
    /// topics its definition hash and seat, exactly as contract-event-v4.json's
    /// records carry it (contracts.md, Board, Events); a repeat emits nothing.
    function test_AcceptsEveryVectorBatchWithItsEvent() public {
        string memory bj = vm.readFile(BATCHES);
        string memory ej = vm.readFile(EVENTS_V4);
        for (uint256 i; vm.keyExistsJson(bj, _at(".records", i, "")); i++) {
            bytes memory b = _bytes(bj, _at(".records", i, ".encoding"));
            Vm.Log[] memory logs = _accept(_batchCall(b));
            assertEq(logs.length, 1, "one event");
            assertEq(logs[0].topics.length, 3, "three topics");
            assertEq(logs[0].topics[0], BATCH_SUBMITTED, "topic 0");
            assertEq(logs[0].topics[1], h, "definition topic");
            assertEq(uint256(logs[0].topics[2]), uint8(b[35]), "seat topic");
            assertEq(keccak256(logs[0].data), keccak256(abi.encode(b)), "data");
            // contract-event-v4.json's record of the same batch: its data and topics.
            string memory key = _at(".records", i + 1, ".fields");
            assertEq(
                keccak256(_bytes(ej, string.concat(key, ".data"))),
                keccak256(logs[0].data),
                "the event file's data"
            );
            assertEq(_b32(ej, string.concat(key, ".topics[2]")), logs[0].topics[2], "seat word");
            assertEq(_accept(_batchCall(b)).length, 0, "a repeat emits nothing");
        }
    }

    /// Each decode rejection of delivery-batch.json is refused with its code
    /// at its offset (contracts.md, Board, Delivery records, step 4), the
    /// record named as position 0.
    function test_BatchDecodeRejections() public {
        string memory bj = vm.readFile(BATCHES);
        for (uint256 i; vm.keyExistsJson(bj, _at(".decode", i, "")); i++) {
            bytes memory b = _bytes(bj, _at(".decode", i, ".encoding"));
            _refuse(
                _batchCall(b),
                _malformed(
                    0,
                    _decodeError(_str(bj, _at(".decode", i, ".error"))),
                    vm.parseJsonUint(bj, _at(".decode", i, ".offset"))
                ),
                _str(bj, _at(".decode", i, ".id"))
            );
        }
    }

    /// A batch for no registered definition, for a seat outside the key set,
    /// or signed by another seat's key, its identity key or over other bytes
    /// is refused, in that order (contracts.md, Board, Delivery records,
    /// steps 2, 5 and 6), and nothing is remembered.
    function test_BatchRefusals() public {
        bytes memory pairs = _batchPairs(3, "refusals");
        _refuse(
            _batchCall(_signedBatch(keccak256("no such definition"), 1, pairs, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "stray"
        );
        _refuse(
            _batchCall(_signedBatch(h, 4, pairs, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 4"
        );
        _refuse(
            _batchCall(_signedBatch(h, 0, pairs, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 0"
        );
        _refuse(
            _batchCall(_signedBatch(h, 1, pairs, signingSecrets[2])),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat's key"
        );
        // A single receipt's tag over the batch's bytes never verifies as a batch.
        bytes memory body = abi.encodePacked(h, uint8(1), uint32(3), pairs);
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(signingSecrets[1], sha256(bytes.concat(receiptDs, body)));
        _refuse(
            _batchCall(abi.encodePacked(uint16(0x0016), uint8(1), body, r, s)),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "the receipt's tag"
        );
        bytes memory honest = _signedBatch(h, 1, pairs, signingSecrets[1]);
        assertEq(_accept(_batchCall(honest)).length, 1, "the honest batch, still new");
        // Canonical calldata only: a padding byte appended.
        _refuse(
            bytes.concat(_batchCall(_signedBatch(h, 2, pairs, signingSecrets[2])), hex"00"),
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector),
            "non-canonical calldata"
        );
    }

    /// Every complaint batch of delivery-batch.json is accepted and emitted
    /// whole, with its definition hash and seat as topics and the data
    /// contract-event-v4.json records for it; the board frames each `D`,
    /// never decodes it, so the batch whose `D` isn't a point is accepted too
    /// (T-53). A repeat emits nothing.
    function test_AcceptsEveryVectorComplaintBatchWithItsEvent() public {
        string memory bj = vm.readFile(BATCHES);
        string memory ej = vm.readFile(EVENTS_V4);
        assertEq(
            vm.parseJsonUint(bj, ".maxComplaints"), DeliveryCheckLib.COMPLAINT_BATCH_MAX, "maximum"
        );
        // contract-event-v4.json lists the ballot, three receipt batches, then
        // the complaint batches in delivery-batch.json's order, then the one
        // whose `D` only frames.
        uint256 i;
        for (; vm.keyExistsJson(bj, _at(".complaintRecords", i, "")); i++) {
            bytes memory b = _bytes(bj, _at(".complaintRecords", i, ".encoding"));
            _acceptComplaintBatch(b, _bytes(ej, _at(".records", 4 + i, ".fields.data")));
        }
        string memory last = _at(".records", 4 + i, ".fields.data");
        bytes memory framedOnly = abi.decode(_bytes(ej, last), (bytes));
        _acceptComplaintBatch(framedOnly, _bytes(ej, last));
    }

    function _acceptComplaintBatch(bytes memory b, bytes memory data) internal {
        Vm.Log[] memory logs = _accept(_complaintBatchCall(b));
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics[0], COMPLAINT_BATCH_SUBMITTED, "topic 0");
        assertEq(logs[0].topics[1], h, "definition topic");
        assertEq(uint256(logs[0].topics[2]), uint8(b[35]), "seat topic");
        assertEq(keccak256(logs[0].data), keccak256(abi.encode(b)), "data");
        assertEq(keccak256(data), keccak256(logs[0].data), "the event file's data");
        assertEq(_accept(_complaintBatchCall(b)).length, 0, "a repeat emits nothing");
    }

    /// Each complaint-batch decode rejection of delivery-batch.json with its
    /// code at its offset, but the `D` that frames and isn't a point, which
    /// the file's decoding refuses and the board, framing only, accepts.
    function test_ComplaintBatchDecodeRejections() public {
        string memory bj = vm.readFile(BATCHES);
        for (uint256 i; vm.keyExistsJson(bj, _at(".complaintDecode", i, "")); i++) {
            // A D that frames but isn't a point: the board frames, never
            // decodes, so it accepts the record the decoder refuses (T-53).
            if (_eq(_str(bj, _at(".complaintDecode", i, ".id")), "d-not-a-point")) {
                bytes memory b = _bytes(bj, _at(".complaintDecode", i, ".encoding"));
                assertEq(_accept(_complaintBatchCall(b)).length, 1, "a framed D is accepted");
                continue;
            }
            _refuse(
                _complaintBatchCall(_bytes(bj, _at(".complaintDecode", i, ".encoding"))),
                _malformed(
                    0,
                    _decodeError(_str(bj, _at(".complaintDecode", i, ".error"))),
                    vm.parseJsonUint(bj, _at(".complaintDecode", i, ".offset"))
                ),
                _str(bj, _at(".complaintDecode", i, ".id"))
            );
        }
    }

    /// A complaint batch for no registered definition, for a seat outside the
    /// key set, or signed by another seat's key or under the single
    /// complaint's tag is refused, in that order.
    function test_ComplaintBatchRefusals() public {
        bytes memory entries = _complaintEntries(3, "refusals");
        _refuse(
            _complaintBatchCall(
                _signedComplaintBatch(
                    keccak256("no such definition"), 1, entries, signingSecrets[1]
                )
            ),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "stray"
        );
        _refuse(
            _complaintBatchCall(_signedComplaintBatch(h, 4, entries, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 4"
        );
        _refuse(
            _complaintBatchCall(_signedComplaintBatch(h, 1, entries, signingSecrets[2])),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat's key"
        );
        bytes memory body = abi.encodePacked(h, uint8(1), uint32(3), entries);
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(signingSecrets[1], sha256(bytes.concat(complaintDs, body)));
        _refuse(
            _complaintBatchCall(abi.encodePacked(uint16(0x0017), uint8(1), body, r, s)),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "the complaint's tag"
        );
        assertEq(
            _accept(_complaintBatchCall(_signedComplaintBatch(h, 1, entries, signingSecrets[1])))
            .length,
            1,
            "the honest batch"
        );
    }

    function testFuzz_ArbitraryComplaintBatchesRefused(bytes calldata r) public {
        _refuseFuzzed(_complaintBatchCall(r));
    }

    /// No one-byte change to an honest complaint batch is accepted: it
    /// changes an entry or the seat under the signature, or breaks the
    /// framing.
    function testFuzz_ComplaintBatchByteChangesRefused(uint256 at, uint8 delta) public {
        vm.assume(delta != 0);
        bytes memory b =
            _signedComplaintBatch(h, 1, _complaintEntries(2, "fuzz"), signingSecrets[1]);
        at %= b.length;
        b[at] = bytes1(uint8(b[at]) ^ delta);
        _refuseFuzzed(_complaintBatchCall(b));
    }

    /// No arbitrary record is accepted as a batch, and every refusal is one of
    /// the delivery check's two errors.
    function testFuzz_ArbitraryBatchesRefused(bytes calldata r) public {
        _refuseFuzzed(_batchCall(r));
    }

    /// No one-byte change to an honest batch is accepted: it changes a pair
    /// or the seat under the signature, or breaks the framing.
    function testFuzz_BatchByteChangesRefused(uint256 at, uint8 delta) public {
        vm.assume(delta != 0);
        bytes memory b = _signedBatch(h, 1, _batchPairs(2, "fuzz"), signingSecrets[1]);
        at %= b.length;
        b[at] = bytes1(uint8(b[at]) ^ delta);
        _refuseFuzzed(_batchCall(b));
    }

    // --- fuzz ------------------------------------------------------------------

    /// Arbitrary input to any call is refused with the board's own errors.
    function testFuzz_ArbitraryReceiptsRefused(bytes calldata r) public {
        vm.assume(keccak256(r) != keccak256(receipt));
        _refuseFuzzed(_receiptsCall(r));
    }

    /// A receipt naming the honest election, with any fields after its header.
    function testFuzz_ArbitraryReceiptBodyRefused(
        bytes32 ballotHash,
        uint8 seat,
        bytes32 shareHash,
        uint256 r,
        uint256 s
    ) public {
        bytes memory c = abi.encodePacked(
            uint16(0x000c), uint8(1), h, ballotHash, seat, shareHash, r, s
        );
        vm.assume(keccak256(c) != keccak256(receipt));
        _refuseFuzzed(_receiptsCall(c));
    }

    function testFuzz_ArbitraryComplaintRefused(bytes calldata c) public {
        vm.assume(keccak256(c) != keccak256(complaint));
        _refuseFuzzed(_complaintCall(c));
    }

    function testFuzz_ArbitraryComplaintBodyRefused(bytes calldata body) public {
        bytes memory c = bytes.concat(_slice(complaint, 0, SEAT_AT + 1), body);
        vm.assume(keccak256(c) != keccak256(complaint));
        _refuseFuzzed(_complaintCall(c));
    }

    function testFuzz_ArbitraryPostingRefused(bytes calldata p, bytes calldata b) public {
        vm.assume(keccak256(p) != keccak256(posting));
        _refuseFuzzed(_postingCall(p, b));
    }

    /// The honest posting with anything but a ballot record of its ballot.
    function testFuzz_ArbitraryBallotForAPostingRefused(bytes calldata b) public {
        _mockPairing();
        _refuseFuzzed(_postingCall(posting, b));
    }

    function testFuzz_ArbitraryBallotRefused(bytes calldata b) public {
        _refuseFuzzed(_ballotCall(b));
    }

    /// No one-byte change to an honest receipt or complaint is accepted: the
    /// header, the election and the seat are checked, and every other byte
    /// is signed or is the signature (T-17, T-31).
    function testFuzz_NoOneByteChangeToAReceiptAccepted(uint256 position, uint8 delta) public {
        vm.assume(delta != 0);
        position %= receipt.length;
        _refuseFuzzed(_receiptsCall(_withByte(receipt, position, uint8(receipt[position]) ^ delta)));
    }

    function testFuzz_NoOneByteChangeToAComplaintAccepted(uint256 position, uint8 delta) public {
        vm.assume(delta != 0);
        position %= complaint.length;
        _refuseFuzzed(
            _complaintCall(_withByte(complaint, position, uint8(complaint[position]) ^ delta))
        );
    }

    /// No one-byte change to a posting outside `m` is accepted: the header,
    /// the election, the ballot hash and the seat are checked against the
    /// ballot, and the ciphertext is the ballot's share hash's preimage.
    function testFuzz_NoOneByteChangeToAPostingOutsideMAccepted(uint256 position, uint8 delta)
        public
    {
        _mockPairing();
        vm.assume(delta != 0);
        position %= posting.length - 32;
        if (position >= M_AT) position += 32;
        _refuseFuzzed(
            _postingCall(_withByte(posting, position, uint8(posting[position]) ^ delta), alice)
        );
    }

    /// Any `m` is accepted: the board can't check it (Known-weak below).
    function testFuzz_AnyMIsAccepted(bytes32 m) public {
        _mockPairing();
        vm.assume(m != bytes32(_word(posting, M_AT)));
        assertEq(_accept(_postingCall(_withWord(posting, M_AT, uint256(m)), alice)).length, 1, "m");
    }

    // --- personal data -----------------------------------------------------------

    /// The honest calls' calldata and events carry no text, and each event's
    /// data is exactly its record ABI-encoded (checked by `_assertEvent`).
    function test_NoPersonalDataInCalldataOrEvents() public {
        _mockPairing();
        bytes[5] memory calls = [
            _ballotCall(honestBallot),
            _receiptsCall(receipt),
            _postingCall(posting, alice),
            _complaintCall(complaint),
            _rootCall(_bytes(vm.readFile(ROOTS), ".records[0].encoding"))
        ];
        for (uint256 i; i < calls.length; i++) {
            assertTrue(!_looksLikeText(calls[i]), "calldata");
            Vm.Log[] memory logs = _accept(calls[i]);
            assertEq(logs.length, 1, "one event");
            assertTrue(!_looksLikeText(logs[0].data), "event data");
            for (uint256 t; t < logs[0].topics.length; t++) {
                assertTrue(!_looksLikeText(abi.encode(logs[0].topics[t])), "event topic");
            }
        }
    }

    /// Text in place of a signed record is refused: as the whole record, or
    /// in a receipt's ballot and share hashes signed by a key no seat
    /// registered, or in a complaint's or a ballot's body.
    ///
    /// Residual (contracts.md, Delivery records; delivery.md, Direct submit;
    /// T-17): a registered seat chooses its receipt's `ballot_hash` and
    /// `share_hash` and signs them, so it can put 64 chosen bytes on the
    /// board per receipt (and a complaint's `D` and proof nonce), and anyone
    /// who saw a ciphertext, in a pending transaction say, can post it with
    /// any 32-byte `m` (testFuzz_AnyMIsAccepted).
    function test_TextInPlaceOfASignedRecordIsRefused() public {
        bytes memory text = bytes(
            "Jane Doe, jane.doe@example.com, passport X1234567, 1 Main Street, Springfield. "
            "Voted for option 2. Jane Doe, jane.doe@example.com, passport X1234567, 1 Main St. "
            "Born 1 January 1970, phone +1 555 0100, Jane Doe, jane.doe@example.com, X1234567."
        );
        bytes memory asReceipt = _slice(text, 0, RECEIPT_LENGTH);
        assertTrue(_looksLikeText(asReceipt), "detector misses the text");
        _refuse(
            _receiptsCall(asReceipt),
            _malformed(0, ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "text as a receipt"
        );
        // Signed by share-receipt.json's panel-2 seat 1, which no seat of
        // this election registered.
        uint256 stranger = vm.parseUint(
            string.concat("0x", _str(vm.readFile(RECEIPTS), ".panels.panel-2[0].signingSecret"))
        );
        bytes memory body = abi.encodePacked(h, _slice(text, 0, 32), uint8(1), _slice(text, 32, 32));
        bytes memory signed = _signed(0x000c, body, stranger);
        assertTrue(_looksLikeText(signed), "detector misses the signed text");
        _refuse(
            _receiptsCall(signed),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "text signed by an unregistered key"
        );
        _refuse(
            _receiptsCall(_signed(0x000c, _withByte(body, SEAT_AT - 3, 9), stranger)),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "text for an unregistered seat"
        );
        bytes memory complaintText = bytes.concat(
            _slice(complaint, 0, SEAT_AT + 1), _slice(text, 0, COMPLAINT_LENGTH - SEAT_AT - 1)
        );
        _refuseFuzzed(_complaintCall(complaintText));
        _refuseFuzzed(_ballotCall(bytes.concat(_slice(honestBallot, 0, 36), text)));
        _refuseFuzzed(_ballotCall(text));
        _refuseFuzzed(_postingCall(text, alice));
    }

    // --- obligation roots ------------------------------------------------------

    /// delivery-root.json is made from delivery.json's panel and definition,
    /// so the stubs set from delivery.json hold its seats' keys.
    function test_RootVectorsShareDeliveryJsonsElection() public view {
        string memory rj = vm.readFile(ROOTS);
        assertTrue(_eq(_str(rj, ".format"), "abolish-delivery-root-vectors/1"), "root format");
        assertEq(_b32(rj, ".definitionHash"), h, "the definition");
        for (uint256 i; i < 3; i++) {
            assertEq(
                keccak256(_bytes(rj, _at(".panel", i, ".signingKey"))),
                keccak256(_bytes(vm.readFile(DELIVERY), _at(".panel", i, ".signingKey"))),
                "the panel"
            );
        }
        assertTrue(_eq(_str(rj, ".tag"), "abolish/v1/sig/obligation-root"), "the tag");
    }

    /// Every root of delivery-root.json is accepted on its own and emitted
    /// whole, its topics its definition hash and seat, exactly as
    /// contract-event-v5.json's records carry it (contracts.md, Board,
    /// Events); a repeat emits nothing.
    function test_AcceptsEveryVectorRootWithItsEvent() public {
        string memory rj = vm.readFile(ROOTS);
        string memory ej = vm.readFile(EVENTS_V5);
        uint256 fresh = vm.snapshotState();
        uint256 i;
        for (; vm.keyExistsJson(rj, _at(".records", i, "")); i++) {
            bytes memory b = _bytes(rj, _at(".records", i, ".encoding"));
            Vm.Log[] memory logs = _accept(_rootCall(b));
            assertEq(logs.length, 1, "one event");
            assertEq(logs[0].topics.length, 3, "three topics");
            assertEq(logs[0].topics[0], ROOT_SUBMITTED, "topic 0");
            assertEq(logs[0].topics[1], h, "definition topic");
            assertEq(uint256(logs[0].topics[2]), uint8(b[35]), "seat topic");
            assertEq(keccak256(logs[0].data), keccak256(abi.encode(b)), "data");
            // contract-event-v5.json lists a ballot and a batch, then the roots
            // in delivery-root.json's order.
            string memory key = _at(".records", i + 2, ".fields");
            assertEq(
                keccak256(_bytes(ej, string.concat(key, ".data"))),
                keccak256(logs[0].data),
                "the event file's data"
            );
            assertEq(_b32(ej, string.concat(key, ".topics[2]")), logs[0].topics[2], "seat word");
            assertEq(_accept(_rootCall(b)).length, 0, "a repeat emits nothing");
            vm.revertToState(fresh);
        }
        assertEq(i, 5, "five roots");
    }

    /// Only the first root of each seat and kind whose signature verifies
    /// is accepted: another root of the same seat and kind is refused
    /// (`root-repeat`), while the seat's other kind and every other seat keep
    /// their own slots, and a byte-identical repeat is still the no-op
    /// (docs/spec/delivery.md, Obligation root, One per seat and kind; T-17,
    /// T-52).
    function test_OneRootPerSeatAndKind() public {
        string memory rj = vm.readFile(ROOTS);
        bytes memory receiptRoot = _rootVector(rj, 0, "receipt-root", 1, 1);
        bytes memory oneLeaf = _rootVector(rj, 1, "one-leaf", 1, 1);
        bytes memory complaintRoot = _rootVector(rj, 2, "complaint-root", 2, 2);
        bytes memory oneBlock = _rootVector(rj, 3, "one-block", 2, 1);
        bytes memory twoBlocks = _rootVector(rj, 4, "two-blocks", 2, 1);
        bytes memory repeat = _refused(0, DeliveryCheckLib.Code.RootRepeat);

        // A root whose signature fails fills no slot.
        bytes memory forged =
            _withByte(oneLeaf, ROOT_SIG_AT + 63, uint8(oneLeaf[ROOT_SIG_AT + 63]) ^ 1);
        _refuse(_rootCall(forged), _refused(0, DeliveryCheckLib.Code.DeliverySignature), "forged");
        assertEq(_accept(_rootCall(receiptRoot)).length, 1, "seat 1's receipt root");
        _refuse(_rootCall(oneLeaf), repeat, "seat 1's second receipt root");
        _refuse(
            _rootCall(forged), _refused(0, DeliveryCheckLib.Code.DeliverySignature), "forged, after"
        );
        assertEq(_accept(_rootCall(receiptRoot)).length, 0, "the first root's repeat is a no-op");
        assertEq(_accept(_rootCall(complaintRoot)).length, 1, "seat 2's complaint root");
        assertEq(_accept(_rootCall(oneBlock)).length, 1, "seat 2's receipt root, its own slot");
        _refuse(_rootCall(twoBlocks), repeat, "seat 2's second receipt root");
        // Seat 1's complaint slot is still empty: a complaint root over
        // Carol's ballot fills it.
        assertEq(
            _accept(_rootCall(_signedRoot(h, 1, 2, 1, keccak256("leaves"), signingSecrets[1])))
            .length,
            1,
            "seat 1's complaint root"
        );
        _refuse(
            _rootCall(_signedRoot(h, 1, 2, 2, keccak256("leaves"), signingSecrets[1])),
            repeat,
            "seat 1's second complaint root"
        );
        // Seat 3's slots are its own.
        assertEq(
            _accept(_rootCall(_signedRoot(h, 3, 1, 3, keccak256("seat 3"), signingSecrets[3])))
            .length,
            1,
            "seat 3's receipt root"
        );
    }

    /// Each decode rejection of delivery-root.json is refused with its code
    /// at its offset (contracts.md, Board, Delivery records, step 4), the
    /// record named as position 0.
    function test_RootDecodeRejections() public {
        string memory rj = vm.readFile(ROOTS);
        uint256 i;
        for (; vm.keyExistsJson(rj, _at(".decode", i, "")); i++) {
            _refuse(
                _rootCall(_bytes(rj, _at(".decode", i, ".encoding"))),
                _malformed(
                    0,
                    _decodeError(_str(rj, _at(".decode", i, ".error"))),
                    vm.parseJsonUint(rj, _at(".decode", i, ".offset"))
                ),
                _str(rj, _at(".decode", i, ".id"))
            );
        }
        assertEq(i, 27, "twenty-seven rejections");
    }

    /// A root for no registered definition, for a seat outside the key set,
    /// or signed by another seat's key or under a batch's tag is refused, in
    /// that order, and fills no slot; a ballot version the board can't read
    /// fixes no root version (contracts.md, Board, Delivery records, steps 2
    /// to 6).
    function test_RootRefusals() public {
        bytes32 leaves = keccak256("refusals");
        _refuse(
            _rootCall(
                _signedRoot(keccak256("no such definition"), 1, 1, 3, leaves, signingSecrets[1])
            ),
            _refused(0, DeliveryCheckLib.Code.DeliveryStray),
            "stray"
        );
        _refuse(
            _rootCall(_signedRoot(h, 4, 1, 3, leaves, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 4"
        );
        _refuse(
            _rootCall(_signedRoot(h, 0, 1, 3, leaves, signingSecrets[1])),
            _refused(0, DeliveryCheckLib.Code.DeliverySeat),
            "seat 0"
        );
        _refuse(
            _rootCall(_signedRoot(h, 1, 1, 3, leaves, signingSecrets[2])),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "another seat's key"
        );
        // A receipt batch's tag over the root's bytes never verifies as a root.
        bytes memory body = _rootBody(h, 1, 1, 3, leaves, RAW_PREFIX);
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(signingSecrets[1], sha256(bytes.concat(batchDs, body)));
        _refuse(
            _rootCall(abi.encodePacked(uint16(0x001a), uint8(1), body, r, s)),
            _refused(0, DeliveryCheckLib.Code.DeliverySignature),
            "a batch's tag"
        );
        // A root's bytes through the batch call, and a batch's through the root call.
        bytes memory honest = _signedRoot(h, 1, 1, 3, leaves, signingSecrets[1]);
        _refuse(
            _batchCall(honest),
            _malformed(0, ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0),
            "a root as a batch"
        );
        _refuse(
            _rootCall(_signedBatch(h, 1, _batchPairs(3, "refusals"), signingSecrets[1])),
            _malformed(0, ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0),
            "a batch as a root"
        );
        assertEq(_accept(_rootCall(honest)).length, 1, "the honest root, its slot still empty");
        // A ballot version above 3 fixes no root version the board reads.
        ElectionRegistry.Parameters memory p = elections.parameters(h);
        p.ballotVersion = 4;
        elections.set(h, p, new uint8[](0), new uint256[](0));
        _refuse(
            _rootCall(_signedRoot(h, 2, 1, 3, leaves, signingSecrets[2])),
            _malformed(0, ElectionDefinitionLib.DecodeError.UnknownVersion, 2),
            "ballot version 4"
        );
        // Canonical calldata only.
        _refuse(
            bytes.concat(_rootCall(_signedRoot(h, 3, 1, 3, leaves, signingSecrets[3])), hex"00"),
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector),
            "non-canonical calldata"
        );
    }

    /// The CID's framing follows from the signed kind and count: a raw
    /// block's CID exactly up to 1 MiB of leaves (16,384 receipts, 8,192
    /// complaints), a dag-pb root's above, each signed (delivery.md,
    /// Decoding).
    function test_RootCidFramingAtTheBlockBoundary() public {
        uint32[4] memory counts = [uint32(16_384), 16_385, 8192, 8193];
        uint8[4] memory kinds = [1, 1, 2, 2];
        for (uint256 i; i < 4; i++) {
            bool raw = i % 2 == 0;
            uint256 snap = vm.snapshotState();
            bytes memory wrong = _signedRootCid(
                h, 1, kinds[i], counts[i], raw ? DAG_PB_PREFIX : RAW_PREFIX, signingSecrets[1]
            );
            _refuse(
                _rootCall(wrong),
                _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, ROOT_CID_AT),
                "the other codec"
            );
            bytes memory right = _signedRootCid(
                h, 1, kinds[i], counts[i], raw ? RAW_PREFIX : DAG_PB_PREFIX, signingSecrets[1]
            );
            assertEq(_accept(_rootCall(right)).length, 1, "the codec its size gives");
            vm.revertToState(snap);
        }
        // The largest count: 2³² − 1 complaint leaves, a dag-pb root.
        assertEq(
            _accept(
                _rootCall(
                    _signedRootCid(h, 1, 2, type(uint32).max, DAG_PB_PREFIX, signingSecrets[1])
                )
            )
            .length,
            1,
            "the largest count"
        );
    }

    /// No arbitrary record is accepted as a root, and every refusal is one of
    /// the delivery check's errors.
    function testFuzz_ArbitraryRootsRefused(bytes calldata r) public {
        _refuseFuzzed(_rootCall(r));
    }

    /// No one-byte change to an honest root is accepted: it changes a field
    /// under the signature or the signature itself, or breaks the framing.
    function testFuzz_RootByteChangesRefused(uint256 at, uint8 delta) public {
        vm.assume(delta != 0);
        bytes memory b = _signedRoot(h, 1, 1, 3, keccak256("fuzz"), signingSecrets[1]);
        at %= b.length;
        b[at] = bytes1(uint8(b[at]) ^ delta);
        _refuseFuzzed(_rootCall(b));
    }

    /// Any fields a seat signs are accepted, once per seat and kind: the
    /// board judges the framing and the signature, never the root, the count
    /// or the leaves (contracts.md, Board, Known-weak).
    function testFuzz_AnySignedRootIsAcceptedOnce(uint8 kind, uint32 count, bytes32 root) public {
        kind = kind % 2 + 1;
        if (count == 0) count = 1;
        assertEq(
            _accept(_rootCall(_signedRoot(h, 2, kind, count, root, signingSecrets[2]))).length,
            1,
            "accepted"
        );
        _refuse(
            _rootCall(_signedRoot(h, 2, kind, 1, ~root, signingSecrets[2])),
            _refused(0, DeliveryCheckLib.Code.RootRepeat),
            "the slot is filled"
        );
    }

    // --- gas -------------------------------------------------------------------

    /// Loose bounds on each call's gas under the default profile (P-256 by
    /// OpenZeppelin's Solidity fallback), measured from the caller, so
    /// calldata copying and the cold storage write of each new record are
    /// included.
    function test_Gas() public {
        bytes[3] memory r = allReceipted;
        uint256 ballot = _gas(_ballotCall(honestBallot));
        uint256 one = _gas(_receiptsCall(r[0]));
        uint256 compl = _gas(_complaintCall(complaint));
        uint256 repeat = _gas(_complaintCall(complaint));
        board = new Board(address(elections), address(trustees), RELAY);
        uint256 three = _gas(_receiptsCall(bytes.concat(r[0], r[1], r[2])));
        // The posting's ballot passes only with the pairing mocked
        // (_mockPairing), so its real cost is the mocked one plus what the
        // mock saves on the honest ballot's check: the four-pair pairing.
        _mockPairing();
        uint256 post = _gas(_postingCall(posting, alice));
        board = new Board(address(elections), address(trustees), RELAY);
        uint256 pairing = ballot - _gas(_ballotCall(honestBallot));
        // Measured about 405,000 (ballot, the ballot check's call to
        // `BallotCheck` and the author key set's read included), 343,000 (one
        // receipt), 950,000 (three), 342,000 (complaint), 29,000 (a repeat),
        // and for a posting 251,000 with the pairing mocked and 183,000 more
        // for the pairing.
        assertTrue(ballot < 450_000, "ballot");
        assertTrue(one < 400_000, "one receipt");
        assertTrue(three < 1_100_000, "three receipts");
        assertTrue(compl < 400_000, "complaint");
        assertTrue(repeat < 35_000, "repeat");
        assertTrue(pairing > 150_000 && pairing < 250_000, "the pairing");
        assertTrue(post < 280_000, "posting, mocked");
        assertTrue(post + pairing < 480_000, "posting");
    }

    /// The forced path's call figures (docs/spec/delivery.md, Capacity), from
    /// delivery-obligation.json: a full batch call fits one deposit's data
    /// and gas, and, where P-256 goes through `P256VERIFY` as on Base, a
    /// `submitReceiptBatch` call of `receiptsPerCall` pairs and a complaint
    /// call each cost at most their pinned gas, intrinsic gas included, by the
    /// standard price or EIP-7623's floor, whichever is higher. Each is
    /// measured on its own and cold, as a forced deposit runs: every account
    /// and slot it reads (the board, both registries, the accumulator) is made
    /// cold first, since a deposit is its own transaction. The capacity check
    /// sizes every election's obligation by these figures, so a board that
    /// cost more would let a trustee node lend its keys to an election it
    /// can't serve through L1 (T-25, T-52, T-54). Under `cancun` P-256 runs in
    /// Solidity, several times the price, and only the framing bounds are
    /// checked; the package's test script sets `EXPECT_P256VERIFY` for the
    /// precompile run, so that run can't skip the gas bounds.
    function test_ForcedPathReceiptCallGas() public {
        string memory fj = vm.readFile(OBLIGATION);
        uint256 perCall = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.receiptsPerCall"));
        uint256 receiptGas = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.receiptCallGas"));
        uint256 maxGas = vm.parseUint(vm.parseJsonString(fj, ".portal.maxResourceLimit"));
        uint256 maxData = vm.parseJsonUint(fj, ".portal.maxDepositData");
        assertEq(perCall, DeliveryCheckLib.BATCH_MAX, "a call is one full batch");

        // One seat's receipts for distinct ballots and share hashes.
        bytes memory pairs = _batchPairs(perCall, "forced path");
        bytes memory batchCall = _batchCall(_signedBatch(h, 1, pairs, signingSecrets[1]));
        assertTrue(batchCall.length <= maxData, "a full batch call's data fits a deposit");
        assertTrue(receiptGas <= maxGas, "the batch call fits a deposit");
        if (!_expectPrecompile()) return;
        uint256 stubbed = _withIntrinsic(batchCall, _coldGas(batchCall));
        // The same seat's batch for a real registry's definition.
        bytes32 dh = _realRegistries();
        bytes memory realCall = _batchCall(_signedBatch(dh, 1, pairs, signingSecrets[1]));
        uint256 used = _withIntrinsic(realCall, _coldGas(realCall));
        assertTrue(used >= stubbed, "the real registries cost at least the stubs");
        assertTrue(used <= receiptGas, string.concat("a full batch call: ", vm.toString(used)));
        // Near what it bounds, so the check isn't far looser than the board.
        assertTrue(
            used > (receiptGas * 9) / 10,
            string.concat(
                "the batch figure is tight: ", vm.toString(stubbed), ", ", vm.toString(used)
            )
        );
        // The figure is the deposit's gas limit: the board takes another
        // full batch, every pair new, with exactly that limit, cold.
        _acceptsWithin(
            _batchCall(
                _signedBatch(dh, 1, _batchPairs(perCall, "forced path, next"), signingSecrets[1])
            ),
            receiptGas
        );
    }

    /// See `test_ForcedPathReceiptCallGas`: a full complaint-batch call,
    /// alone and cold, against the stubs and then real registries.
    function test_ForcedPathComplaintCallGas() public {
        string memory fj = vm.readFile(OBLIGATION);
        uint256 perCall = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.complaintsPerCall"));
        uint256 complaintGas = vm.parseUint(vm.parseJsonString(fj, ".forcedPath.complaintCallGas"));
        uint256 maxGas = vm.parseUint(vm.parseJsonString(fj, ".portal.maxResourceLimit"));
        uint256 maxData = vm.parseJsonUint(fj, ".portal.maxDepositData");
        assertEq(perCall, DeliveryCheckLib.COMPLAINT_BATCH_MAX, "a call is one full batch");
        bytes memory entries = _complaintEntries(perCall, "forced path");
        bytes memory batchCall =
            _complaintBatchCall(_signedComplaintBatch(h, 1, entries, signingSecrets[1]));
        assertTrue(batchCall.length <= maxData, "a full complaint batch's data fits a deposit");
        assertTrue(complaintGas <= maxGas, "the complaint call fits a deposit");
        if (!_expectPrecompile()) return;
        uint256 stubbed = _withIntrinsic(batchCall, _coldGas(batchCall));
        bytes32 dh = _realRegistries();
        bytes memory realCall =
            _complaintBatchCall(_signedComplaintBatch(dh, 1, entries, signingSecrets[1]));
        uint256 used = _withIntrinsic(realCall, _coldGas(realCall));
        assertTrue(used >= stubbed, "the real registries cost at least the stubs");
        assertTrue(
            used <= complaintGas, string.concat("a full complaint batch: ", vm.toString(used))
        );
        assertTrue(
            used > (complaintGas * 9) / 10,
            string.concat(
                "the complaint figure is tight: ", vm.toString(stubbed), ", ", vm.toString(used)
            )
        );
        _acceptsWithin(
            _complaintBatchCall(
                _signedComplaintBatch(
                    dh, 1, _complaintEntries(perCall, "forced path, next"), signingSecrets[1]
                )
            ),
            complaintGas
        );
    }

    /// See `test_ForcedPathReceiptCallGas`: one obligation-root call, alone
    /// and cold, against the stubs and then real registries, costs at most
    /// `ROOT_CALL_GAS` (delivery-root.json, `rootCallGas`) with its intrinsic
    /// gas, and more than 80% of it, so an election that commits roots is
    /// sized by what the board costs (delivery.md, Capacity; T-25, T-52). The
    /// first root of a seat is measured, which writes its slot's word from
    /// zero; the figure is then the gas limit of the seat's other root.
    function test_ForcedPathRootCallGas() public {
        string memory fj = vm.readFile(OBLIGATION);
        uint256 rootGas = vm.parseUint(vm.parseJsonString(vm.readFile(ROOTS), ".rootCallGas"));
        uint256 maxGas = vm.parseUint(vm.parseJsonString(fj, ".portal.maxResourceLimit"));
        uint256 maxData = vm.parseJsonUint(fj, ".portal.maxDepositData");
        // No zero byte in the count, the root or the CID's digest: the
        // calldata's dearest form.
        bytes32 dense = bytes32(type(uint256).max / 255);
        uint32 count = 0x01010101;
        bytes memory rootCall = _rootCall(_signedRoot(h, 1, 1, count, dense, signingSecrets[1]));
        assertTrue(rootCall.length <= maxData, "a root call's data fits a deposit");
        assertTrue(rootGas <= maxGas, "the root call fits a deposit");
        if (!_expectPrecompile()) return;
        uint256 stubbed = _withIntrinsic(rootCall, _coldGas(rootCall));
        bytes32 dh = _realRegistries();
        bytes memory realCall = _rootCall(_signedRoot(dh, 1, 1, count, dense, signingSecrets[1]));
        uint256 used = _withIntrinsic(realCall, _coldGas(realCall));
        assertTrue(used >= stubbed, "the real registries cost at least the stubs");
        assertTrue(used <= rootGas, string.concat("a root call: ", vm.toString(used)));
        assertTrue(
            used > (rootGas * 8) / 10,
            string.concat(
                "the root figure is tight: ", vm.toString(stubbed), ", ", vm.toString(used)
            )
        );
        _acceptsWithin(_rootCall(_signedRoot(dh, 1, 2, count, dense, signingSecrets[1])), rootGas);
    }

    /// The call succeeds, cold, with `gasLimit` as its transaction's limit:
    /// what is left of it after the intrinsic gas (EIP-2028's price) is what
    /// the call gets, and EIP-7623's floor fits the limit too.
    function _acceptsWithin(bytes memory data, uint256 gasLimit) internal {
        uint256 zeros;
        for (uint256 i; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 tokens = zeros + 4 * (data.length - zeros);
        assertTrue(21_000 + 10 * tokens <= gasLimit, "the floor fits the limit");
        vm.cool(address(board));
        vm.cool(realElections);
        vm.cool(realTrustees);
        vm.recordLogs();
        (bool ok,) = address(board).call{gas: gasLimit - 21_000 - 4 * tokens}(data);
        assertTrue(ok, "accepted within the deposit's gas limit");
        // Accepted, not a repeat: it emitted.
        assertTrue(vm.getRecordedLogs().length > 0, "the call emitted");
    }

    /// Whether P-256 goes through the precompile here, asserted where the
    /// test script expects it.
    function _expectPrecompile() internal view returns (bool precompile) {
        precompile = _p256Precompile();
        if (vm.envOr("EXPECT_P256VERIFY", false)) assertTrue(precompile, "no P256VERIFY");
    }

    /// `_gas` with the board and both registries cold, accounts and slots, as
    /// in a deposit of its own.
    function _coldGas(bytes memory data) internal returns (uint256) {
        vm.cool(address(board));
        vm.cool(address(elections));
        vm.cool(address(trustees));
        if (realElections != address(0)) vm.cool(realElections);
        if (realTrustees != address(0)) vm.cool(realTrustees);
        return _gas(data);
    }

    /// Whether the EVM answers P-256 verification at 0x100, with one of the
    /// vector's honest receipts.
    function _p256Precompile() internal view returns (bool) {
        bytes memory r = allReceipted[0];
        bytes32 digest = sha256(bytes.concat(receiptDs, _slice(r, 3, RECEIPT_SIG_AT - 3)));
        (bool ok, bytes memory ret) = address(0x100)
            .staticcall(
                abi.encodePacked(
                    digest, _slice(r, RECEIPT_SIG_AT, 64), signingKeys[1][0], signingKeys[1][1]
                )
            );
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    /// A transaction's gas for `data` that executed `used`: 21,000, then
    /// EIP-2028's 4 per zero byte and 16 per other, or EIP-7623's floor of 10
    /// per token (a zero byte one token, another four) when that is higher.
    function _withIntrinsic(bytes memory data, uint256 used) internal pure returns (uint256) {
        uint256 zeros;
        for (uint256 i; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 tokens = zeros + 4 * (data.length - zeros);
        uint256 standard = 21_000 + 4 * tokens + used;
        uint256 floor = 21_000 + 10 * tokens;
        return standard > floor ? standard : floor;
    }

    // --- helpers: calls and verdicts ----------------------------------------------

    function _ballotCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitBallot, (r));
    }

    function _receiptsCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitReceipts, (r));
    }

    function _postingCall(bytes memory p, bytes memory b) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitPosting, (p, b));
    }

    function _complaintCall(bytes memory c) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitComplaint, (c));
    }

    function _batchCall(bytes memory b) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitReceiptBatch, (b));
    }

    function _rootCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitObligationRoot, (r));
    }

    /// `m` of a root (delivery.md, Obligation root): its CID's digest made up
    /// from `root`, since the board never reads the leaves.
    function _rootBody(
        bytes32 dh,
        uint8 seat,
        uint8 kind,
        uint32 count,
        bytes32 root,
        bytes4 prefix
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(dh, seat, kind, count, root, prefix, keccak256(abi.encode(root)));
    }

    /// A root of `count` leaves of `kind`, its CID framed as its size gives,
    /// signed with `sk`.
    function _signedRoot(bytes32 dh, uint8 seat, uint8 kind, uint32 count, bytes32 root, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes4 prefix =
            (kind == 1 ? 64 : 128) * uint256(count) <= 1_048_576 ? RAW_PREFIX : DAG_PB_PREFIX;
        return _signRoot(_rootBody(dh, seat, kind, count, root, prefix), sk);
    }

    /// A root whose CID begins with `prefix`, whatever its size gives.
    function _signedRootCid(
        bytes32 dh,
        uint8 seat,
        uint8 kind,
        uint32 count,
        bytes4 prefix,
        uint256 sk
    ) internal view returns (bytes memory) {
        return _signRoot(_rootBody(dh, seat, kind, count, keccak256("root"), prefix), sk);
    }

    function _signRoot(bytes memory body, uint256 sk) internal view returns (bytes memory) {
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, sha256(bytes.concat(rootDs, body)));
        return abi.encodePacked(uint16(0x001a), uint8(1), body, r, s);
    }

    /// delivery-root.json's root `i`, checked to be the one the test names.
    function _rootVector(string memory rj, uint256 i, string memory id, uint8 seat, uint8 kind)
        internal
        pure
        returns (bytes memory b)
    {
        assertTrue(_eq(_str(rj, _at(".records", i, ".id")), id), id);
        b = _bytes(rj, _at(".records", i, ".encoding"));
        assertEq(uint8(b[35]), seat, string.concat(id, ": seat"));
        assertEq(uint8(b[36]), kind, string.concat(id, ": kind"));
    }

    function _complaintBatchCall(bytes memory b) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitComplaintBatch, (b));
    }

    /// `count` complaint entries ascending by ballot hash, each proof framed
    /// and dense: `D` an even value below `2²⁵⁵ − 19`, `c` and `z` below `ℓ`,
    /// all little-endian, none checked as points (the board frames only).
    function _complaintEntries(uint256 count, string memory label)
        internal
        pure
        returns (bytes memory entries)
    {
        entries = new bytes(128 * count);
        for (uint256 i; i < count; i++) {
            bytes32 ballot = bytes32(
                (i + 1) << 240 | (uint256(keccak256(abi.encode(label, "ballot", i))) >> 16)
            );
            // Little-endian: a word's last byte is the value's top byte and
            // its first byte the lowest. D's top byte 0x2a and its lowest bit
            // clear; c's and z's top byte below 0x10.
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

    function _signedComplaintBatch(bytes32 dh, uint8 seat, bytes memory entries, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(dh, seat, uint32(entries.length / 128), entries);
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(sk, sha256(bytes.concat(complaintBatchDs, body)));
        return abi.encodePacked(uint16(0x0017), uint8(1), body, r, s);
    }

    /// `count` pairs ascending by ballot hash, dense as honest hashes are:
    /// each ballot hash leads with its index's two bytes.
    function _batchPairs(uint256 count, string memory label)
        internal
        pure
        returns (bytes memory pairs)
    {
        // Written in place: concatenating a pair at a time is quadratic in memory.
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

    /// A share-receipt batch over `pairs` (64 bytes each), signed under the
    /// batch's tag by `sk`.
    function _signedBatch(bytes32 dh, uint8 seat, bytes memory pairs, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(dh, seat, uint32(pairs.length / 64), pairs);
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, sha256(bytes.concat(batchDs, body)));
        return abi.encodePacked(uint16(0x0016), uint8(1), body, r, s);
    }

    /// Runs `data` against the board, which must accept it, and returns the
    /// logs it emitted: each the board's, each folded into the accumulator
    /// in order, and nothing else changed in the accumulator.
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
        assertEq(countAfter, count + logs.length, "accumulator count");
        assertEq(after_, acc, "accumulator");
    }

    /// Runs `data`, which the board must refuse with exactly `expected`,
    /// emitting nothing and leaving the accumulator as it was.
    function _refuse(bytes memory data, bytes memory expected, string memory what) internal {
        bytes memory ret = _refusal(data, what);
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
    }

    /// As `_refuse`, for a `DeliveryMalformed` whose offset the file doesn't give.
    function _refuseAnyOffset(bytes memory data, bytes memory expected, string memory what)
        internal
    {
        bytes memory ret = _refusal(data, what);
        assertTrue(ret.length == 100, what);
        assertTrue(keccak256(_slice(ret, 0, 68)) == keccak256(_slice(expected, 0, 68)), what);
    }

    /// Refused with one of the board's own errors, never another revert.
    function _refuseFuzzed(bytes memory data) internal {
        bytes4 s = bytes4(_refusal(data, "fuzzed input"));
        assertTrue(
            s == DeliveryCheckLib.DeliveryMalformed.selector
                || s == DeliveryCheckLib.DeliveryRefused.selector
                || s == Board.ReceiptBatchLength.selector
                || s == BallotCheckLib.BallotMalformed.selector
                || s == BallotCheckLib.BallotRefused.selector
                || s == CanonicalCalldata.NonCanonicalCalldata.selector,
            "an unexpected revert"
        );
    }

    function _refusal(bytes memory data, string memory what) internal returns (bytes memory ret) {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        bool ok;
        (ok, ret) = address(board).call(data);
        assertTrue(!ok, string.concat(what, ": accepted"));
        // A reverted call's logs reach no chain, though Foundry records them;
        // the accumulator, which every log goes through, shows none stayed.
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(countAfter, count, what);
        assertEq(after_, acc, what);
    }

    /// The canonical encoding is accepted; a trailing word, dirty padding,
    /// a moved offset and a zero offset are refused.
    function _assertCanonicalOnly(bytes memory good) internal {
        uint256 len = _word(good, 36);
        assertTrue(len % 32 != 0, "the record needs padding");
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        bytes4 sel = bytes4(bytes32(_word(good, 0)));
        bytes[4] memory bad = [
            abi.encodePacked(good, bytes32(0)),
            _withByte(good, good.length - 1, 1),
            abi.encodePacked(sel, uint256(0x40), uint256(0), _slice(good, 36, good.length - 36)),
            abi.encodePacked(sel, uint256(0), bytes32("junk"))
        ];
        for (uint256 i; i < bad.length; i++) {
            _refuse(bad[i], refusal, string.concat("calldata ", vm.toString(i)));
        }
        assertEq(_accept(good).length, 1, "canonical calldata");
    }

    function _gas(bytes memory data) internal returns (uint256 used) {
        address target = address(board);
        uint256 before = gasleft();
        (bool ok,) = target.call(data);
        used = before - gasleft();
        assertTrue(ok, "gas call refused");
    }

    function _assertEvent(
        Vm.Log memory log,
        bytes32 signature,
        bytes32 definitionHash,
        bytes32 ballotHash,
        bytes memory record
    ) internal pure {
        assertEq(log.topics.length, 3, "three topics");
        assertEq(log.topics[0], signature, "event signature");
        assertEq(log.topics[1], definitionHash, "definition hash topic");
        assertEq(log.topics[2], ballotHash, "ballot hash topic");
        assertTrue(keccak256(log.data) == keccak256(abi.encode(record)), "data is the record");
    }

    /// Deploys with `create` itself, since forge may run a test's `new`
    /// through a cheatcode whose revert a `try` doesn't catch.
    function _refuseDeployment(address e, address t) internal {
        _refuseDeployment(e, t, RELAY);
    }

    function _refuseDeployment(address e, address t, address r) internal {
        bytes memory code = abi.encodePacked(type(Board).creationCode, abi.encode(e, t, r));
        address deployed;
        bytes memory reason;
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
            reason := mload(0x40)
            mstore(reason, returndatasize())
            returndatacopy(add(reason, 0x20), 0, returndatasize())
            mstore(0x40, add(add(reason, 0x20), returndatasize()))
        }
        assertTrue(deployed == address(0), "deployed");
        assertTrue(
            keccak256(reason)
                == keccak256(abi.encodeWithSelector(Board.InvalidDeployment.selector)),
            "InvalidDeployment"
        );
    }

    /// The address this contract's next creation gets.
    function _next() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    /// One ballot of a record file (ballot.json, ballot-v3-records.json) on a board of its own (two of the file's
    /// ballots share their bytes under different key sets, and a repeat
    /// checks nothing, Calls), under the key set the file lists for it.
    function _ballotVector(string memory bj, string memory b, string[2] memory names, uint8 version)
        internal
    {
        string memory id = _str(bj, string.concat(b, ".id"));
        board = new Board(address(elections), address(trustees), RELAY);
        // Only the ballot's own election is registered, so another's is stray.
        string memory named = _str(bj, string.concat(b, ".election"));
        for (uint256 k; k < 2; k++) {
            string memory e = string.concat(".elections.", names[k]);
            if (_eq(names[k], named)) {
                (ElectionRegistry.Parameters memory p, uint8[] memory t, uint256[] memory r) =
                    version == 1 ? _electionV1(bj, e) : _electionV3(bj, e);
                elections.set(_b32(bj, string.concat(e, ".definitionHash")), p, t, r);
            } else {
                ElectionRegistry.Parameters memory none;
                elections.set(
                    _b32(bj, string.concat(e, ".definitionHash")),
                    none,
                    new uint8[](0),
                    new uint256[](0)
                );
            }
        }
        (bytes32 stub,) = elections.ceremony(
            _b32(
                bj,
                string.concat(
                    ".elections.", _str(bj, string.concat(b, ".election")), ".definitionHash"
                )
            )
        );
        trustees.setKeySet(
            stub, PANEL, _mask(vm.parseJsonUintArray(bj, string.concat(b, ".registered")))
        );
        bytes memory record = _bytes(bj, string.concat(b, ".encoding"));
        string memory result = _str(bj, string.concat(b, ".result"));
        if (_eq(result, "ok") || _eq(result, "option-proof") || _eq(result, "sum-proof")) {
            Vm.Log[] memory logs = _accept(_ballotCall(record));
            assertEq(logs.length, 1, id);
            _assertEvent(
                logs[0],
                BALLOT_SUBMITTED,
                bytes32(_word(record, 3)),
                _b32(bj, string.concat(b, ".ballotHash")),
                record
            );
        } else {
            _refuse(_ballotCall(record), _ballotRefused(_ballotCode(result)), id);
        }
    }

    function _malformed(uint256 i, ElectionDefinitionLib.DecodeError code, uint256 offset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(DeliveryCheckLib.DeliveryMalformed.selector, i, code, offset);
    }

    function _refused(uint256 i, DeliveryCheckLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DeliveryCheckLib.DeliveryRefused.selector, i, code);
    }

    function _ballotMalformed(ElectionDefinitionLib.DecodeError code, uint256 offset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(BallotCheckLib.BallotMalformed.selector, code, offset);
    }

    function _ballotRefused(BallotCheckLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, code);
    }

    /// Where each decode vector fails, by the spec's layouts (delivery.md,
    /// Records; share-encryption.md, Ciphertext): the version at 2, a
    /// receipt's signature at 100, a posting's `ct_dh` at 1188, `pok_z` at
    /// 1252 and `sealed` at 1284, whose bytes after its count start at 1288
    /// (one short is `truncated` there, notation.md, Strict decoding: the
    /// length is checked against the input before the bytes are read), and
    /// a complaint's `D` at 68, `c` at 100 and signature at 164.
    function _decodeOffset(string memory id) internal view returns (uint256) {
        bytes32 k = keccak256(bytes(id));
        if (k == keccak256("receipt-as-posting")) return 0;
        if (k == keccak256("receipt-version-2")) return 2;
        if (k == keccak256("receipt-high-s")) return RECEIPT_SIG_AT;
        if (k == keccak256("posting-truncated")) return SEALED_AT + 4;
        if (k == keccak256("posting-trailing")) return posting.length;
        if (k == keccak256("posting-identity-dh")) return CT_DH_AT;
        if (k == keccak256("posting-pok-z-l")) return POK_Z_AT;
        if (k == keccak256("posting-sealed-over-max")) return SEALED_AT;
        if (k == keccak256("complaint-truncated")) return COMPLAINT_SIG_AT;
        if (k == keccak256("complaint-trailing")) return COMPLAINT_LENGTH;
        if (k == keccak256("complaint-c-l")) return COMPLAINT_C_AT;
        if (k == keccak256("complaint-identity-dh")) return COMPLAINT_D_AT;
        if (k == keccak256("complaint-as-receipt")) return 0;
        revert(string.concat("no offset for ", id));
    }

    /// What each invalid receipt check of share-receipt.json gets, from its
    /// description: a changed signed field, another key or another tag
    /// fails the signature; a seat outside the panel's key set fails the
    /// seat; an unregistered definition is stray; a high `s` isn't canonical;
    /// a record one byte short is no batch.
    function _receiptCheckVerdict(string memory id, uint256 length)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 k = keccak256(bytes(id));
        if (
            k == keccak256("other-seat") || k == keccak256("other-seat-key")
                || k == keccak256("identity-key") || k == keccak256("other-ballot")
                || k == keccak256("other-ciphertext") || k == keccak256("other-tag")
                || k == keccak256("altered") || k == keccak256("other-panel")
        ) return _refused(0, DeliveryCheckLib.Code.DeliverySignature);
        if (
            k == keccak256("unregistered-seat") || k == keccak256("seat-zero")
                || k == keccak256("seat-over-max")
        ) return _refused(0, DeliveryCheckLib.Code.DeliverySeat);
        if (k == keccak256("other-definition")) {
            return _refused(0, DeliveryCheckLib.Code.DeliveryStray);
        }
        if (k == keccak256("high-s")) {
            return _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, RECEIPT_SIG_AT);
        }
        if (k == keccak256("short")) {
            return abi.encodeWithSelector(Board.ReceiptBatchLength.selector, length);
        }
        revert(string.concat("no verdict for ", id));
    }

    /// The board's verdict on entry `j` of election `e`, from the file's
    /// delivery-check result: (refused, the expected revert, whether its
    /// offset is unknown).
    function _electionVerdict(
        string memory dj,
        string memory e,
        uint256 j,
        bytes memory payload,
        uint256 t
    ) internal view returns (bool, bytes memory, bool) {
        string memory res = string.concat(e, ".result");
        for (uint256 r; vm.keyExistsJson(dj, _at(string.concat(res, ".rejected"), r, "")); r++) {
            string memory x = _at(string.concat(res, ".rejected"), r, "");
            if (vm.parseJsonUint(dj, string.concat(x, ".at")) != j) continue;
            if (t == 0x000c && payload.length % RECEIPT_LENGTH != 0) {
                return (
                    true,
                    abi.encodeWithSelector(Board.ReceiptBatchLength.selector, payload.length),
                    false
                );
            }
            return
                (true, _malformed(0, _decodeError(_str(dj, string.concat(x, ".error"))), 0), true);
        }
        for (uint256 r; vm.keyExistsJson(dj, _at(string.concat(res, ".records"), r, "")); r++) {
            string memory x = _at(string.concat(res, ".records"), r, "");
            if (vm.parseJsonUint(dj, string.concat(x, ".at")) != j) continue;
            bytes32 code = keccak256(bytes(_str(dj, string.concat(x, ".code"))));
            if (code == keccak256("delivery-seat")) {
                return (true, _refused(0, DeliveryCheckLib.Code.DeliverySeat), false);
            }
            if (code == keccak256("delivery-stray")) {
                return (true, _refused(0, DeliveryCheckLib.Code.DeliveryStray), false);
            }
            if (code == keccak256("posting-hash")) {
                return (true, _refused(0, DeliveryCheckLib.Code.PostingHash), false);
            }
            if (code == keccak256("share-receipt") && _signer(dj, string.concat(x, ".signer")) == 0)
            {
                return (true, _refused(0, DeliveryCheckLib.Code.DeliverySignature), false);
            }
        }
        for (uint256 b; vm.keyExistsJson(dj, _at(string.concat(res, ".ballots"), b, "")); b++) {
            string memory ex = _at(string.concat(res, ".ballots"), b, ".excludedBy");
            for (uint256 c; vm.keyExistsJson(dj, _at(ex, c, "")); c++) {
                if (vm.parseJsonUint(dj, _at(ex, c, ".at")) != j) continue;
                if (_signer(dj, _at(ex, c, ".signer")) == 0) {
                    return (true, _refused(0, DeliveryCheckLib.Code.DeliverySignature), false);
                }
            }
        }
        return (false, "", false);
    }

    /// A `signer` field: the seat, or 0 for `null` (no seat is 0).
    function _signer(string memory dj, string memory key) internal view returns (uint256) {
        if (!vm.keyExistsJson(dj, key)) return type(uint256).max;
        return abi.decode(vm.parseJson(dj, key), (uint256));
    }

    // --- helpers: vectors ----------------------------------------------------------

    function _election(string memory dj, string memory id) internal view returns (string memory) {
        return _find(dj, ".elections", id);
    }

    function _ballot(string memory dj, string memory e, string memory id)
        internal
        view
        returns (string memory)
    {
        return _find(dj, string.concat(e, ".ballots"), id);
    }

    /// The record of `.records` with this id, checked to be of its type.
    function _vectorRecord(string memory dj, string memory id, string memory t)
        internal
        view
        returns (bytes memory)
    {
        string memory r = _find(dj, ".records", id);
        assertTrue(_eq(_str(dj, string.concat(r, ".type")), t), id);
        return _bytes(dj, string.concat(r, ".encoding"));
    }

    function _decodeVector(string memory dj, string memory id)
        internal
        view
        returns (bytes memory)
    {
        return _bytes(dj, string.concat(_find(dj, ".decode", id), ".encoding"));
    }

    /// The key of the entry of `list` whose `id` is `id`.
    function _find(string memory json, string memory list, string memory id)
        internal
        view
        returns (string memory at)
    {
        for (uint256 i;; i++) {
            at = _at(list, i, "");
            require(vm.keyExistsJson(json, at), string.concat("no vector ", id));
            if (_eq(_str(json, string.concat(at, ".id")), id)) return at;
        }
    }

    /// A version-1 ballot record around a delivery.json ballot's tier,
    /// nullifier and committed vote (ballot-validity.md, Ballot record), with
    /// ballot.json's honest proof points and any L1 reference (the ballot
    /// hash binds neither), checked against the file's ballot hash.
    function _ballotRecord(string memory dj, string memory b)
        internal
        view
        returns (bytes memory record)
    {
        record = abi.encodePacked(
            uint16(0x0002),
            uint8(1),
            h,
            uint8(vm.parseJsonUint(dj, string.concat(b, ".tier"))),
            vm.parseUint(_str(dj, string.concat(b, ".nullifier"))),
            L1_NUMBER,
            L1_HASH,
            proof,
            _bytes(dj, string.concat(b, ".committedVote"))
        );
        assertEq(
            ballots.ballotHash(record), _b32(dj, string.concat(b, ".ballotHash")), "ballot hash"
        );
    }

    /// The record of election `e`'s ballot whose hash the posting names, or
    /// Alice's if none is (a posting that fails before its ballot is read).
    function _ballotFor(string memory dj, string memory e, bytes memory p)
        internal
        view
        returns (bytes memory)
    {
        if (p.length >= SEAT_AT) {
            bytes32 named = bytes32(_word(p, BALLOT_HASH_AT));
            for (uint256 i; vm.keyExistsJson(dj, _at(string.concat(e, ".ballots"), i, "")); i++) {
                string memory b = _at(string.concat(e, ".ballots"), i, "");
                if (_b32(dj, string.concat(b, ".ballotHash")) == named) {
                    return _ballotRecord(dj, b);
                }
            }
        }
        return alice;
    }

    /// The parameters under which a delivery.json committed vote has its
    /// shape (ballot-validity.md, Committed vote): ballot version 1, `k` the
    /// first option's commitment count, `n` the share count, `T` the option
    /// count, and one question of `T` options whose `max − min + 1` is the
    /// sum proof's branch count, from a minimum of 0.
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
        uint256 branches = _u32(vote, o);
        p.ballotVersion = 1;
        p.threshold = uint8(k);
        p.panelSize = uint8(n);
        p.optionCount = uint16(options);
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] = ElectionRegistry.Question(1, uint16(options), 0, uint16(branches - 1));
    }

    /// The seats whose share hash in a ballot record is non-zero, as a mask.
    function _nonZeroShareHashes(bytes memory record) internal pure returns (uint256 m) {
        uint256 o = BallotCheckLib.VOTE_AT;
        uint256 options = _u32(record, o);
        o += 4;
        for (uint256 j; j < options; j++) {
            o += 4 + 32 * _u32(record, o);
        }
        uint256 n = _u32(record, o);
        for (uint256 i; i < n; i++) {
            if (_word(record, o + 4 + 32 * i) != 0) m |= 1 << (i + 1);
        }
    }

    /// Makes the pairing precompile answer "valid", so a posting's ballot
    /// passes its membership check. No vector pairs a real membership proof
    /// with ciphertexts a posting can deliver: delivery.json's ballots carry
    /// ballot.json's honest proof points here, which fail against their own
    /// signals. The membership check itself is covered unmocked by
    /// BallotCheck.t.sol and the ballot tests above, and
    /// test_AFabricatedBallotCannotCarryAPosting shows a posting refused
    /// without the mock.
    function _mockPairing() internal {
        vm.mockCall(address(8), "", abi.encode(uint256(1)));
    }

    /// `x` as 32 bytes little-endian, read back as a big-endian word.
    function _le(uint256 x) internal pure returns (uint256 w) {
        for (uint256 i; i < 32; i++) {
            w = (w << 8) | ((x >> (8 * i)) & 0xff);
        }
    }

    /// ballot.json's election `e`: its definition's panel, question and pin,
    /// and its tiers' roots (as BallotCheck.t.sol reads them).
    function _electionV1(string memory bj, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(bj, string.concat(e, ".definition")));
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.optionCount = d.optionCount;
        p.opensAt = d.opensAt;
        p.closesAt = d.closesAt;
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] =
            ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        for (uint256 i; i < d.pinTypes.length; i++) {
            if (d.pinTypes[i] == 2) p.ballotVersion = d.pinVersions[i];
        }
        assertEq(p.ballotVersion, 1, "ballot version 1");
        uint256 n;
        while (vm.keyExistsJson(bj, _at(string.concat(e, ".tiers"), n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            string memory t = _at(string.concat(e, ".tiers"), i, "");
            tiers[i] = uint8(vm.parseJsonUint(bj, string.concat(t, ".tier")));
            roots[i] = vm.parseUint(_str(bj, string.concat(t, ".root")));
        }
    }

    /// ballot-v3-records.json's election `e`: its version-5 definition's panel,
    /// questions and pin, and its cells' tiers and roots.
    function _electionV3(string memory bj, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(bj, string.concat(e, ".definition")));
        assertEq(d.version, 5, "definition version 5");
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.opensAt = d.opensAt;
        p.closesAt = d.closesAt;
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
        assertEq(p.ballotVersion, 3, "ballot version 3");
        uint256 n;
        while (vm.keyExistsJson(bj, _at(string.concat(e, ".cells"), n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            string memory c = _at(string.concat(e, ".cells"), i, "");
            assertEq(vm.parseJsonUint(bj, string.concat(c, ".cell")), i, "cells in order");
            tiers[i] = uint8(vm.parseJsonUint(bj, string.concat(c, ".tier")));
            roots[i] = vm.parseUint(_str(bj, string.concat(c, ".root")));
        }
    }

    /// The largest version-3 record for `dh` (see its test): cell 0,
    /// nullifier 1, an honest ballot's proof, every element 32 bytes of 0x22
    /// (even and below `p`, so framed) and every scalar 32 bytes of 0x01
    /// (below `ℓ`): dense bytes, so calldata is priced as an honest
    /// ballot's, whose bytes are uniformly random, would be.
    function _largestV3(bytes32 dh) internal view returns (bytes memory) {
        ByteWriter.Writer memory w = ByteWriter.create();
        w.put(0x0002, 2);
        w.put(3, 1);
        w.put(uint256(dh), 32);
        w.put(0, 1);
        w.put(1, 32);
        w.put(L1_NUMBER, 8);
        w.put(uint256(L1_HASH), 32);
        for (uint256 i; i < 256; i += 32) {
            w.put(_word(proof, i), 32);
        }
        w.put(64, 4);
        for (uint256 j; j < 64; j++) {
            w.put(16, 4);
            for (uint256 t; t < 16; t++) {
                w.put(DENSE_ELEMENT, 32);
            }
        }
        w.put(16, 4);
        for (uint256 i; i < 16; i++) {
            w.put(uint256(keccak256(abi.encode("share", i))), 32);
        }
        w.put(64, 4);
        for (uint256 i; i < 64 * 4; i++) {
            w.put(DENSE_SCALAR, 32);
        }
        w.put(32, 4);
        for (uint256 q; q < 32; q++) {
            w.put(3, 4);
            for (uint256 i; i < 3 * 2; i++) {
                w.put(DENSE_SCALAR, 32);
            }
        }
        return w.finish();
    }

    /// Sets the share-receipt stub's key set and signing keys to `panel`'s.
    function _setPanel(string memory sr, string memory panel) internal {
        uint256 mask;
        for (uint256 i; vm.keyExistsJson(sr, _at(panel, i, "")); i++) {
            uint256 seat = vm.parseJsonUint(sr, _at(panel, i, ".seat"));
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(sr, _at(panel, i, ".signingKey")));
            assertTrue(onCurve, "signing key");
            trustees.setKey(STUB_RECEIPTS, PANEL, seat, x, y);
            mask |= 1 << seat;
        }
        trustees.setKeySet(STUB_RECEIPTS, PANEL, mask);
    }

    /// delivery.json's receipt's statement under definition `dh` and seat
    /// `seat`, signed by `sk`.
    function _receiptFor(bytes32 dh, uint8 seat, uint256 sk) internal view returns (bytes memory) {
        return _signed(
            0x000c, abi.encodePacked(dh, aliceHash, seat, _slice(receipt, SEAT_AT + 1, 32)), sk
        );
    }

    /// A receipt or complaint: its header, then `body` (every field from the
    /// definition hash to the signature), then a low-s P-256 signature by
    /// `sk` over `H(DS(tag, body))` (trustee-identity.md, Signatures), with
    /// the tags delivery.json names.
    function _signed(uint16 t, bytes memory body, uint256 sk) internal view returns (bytes memory) {
        (uint256 r, uint256 s) = TrusteeFixture.sign(
            sk, sha256(bytes.concat(t == 0x000c ? receiptDs : complaintDs, body))
        );
        return abi.encodePacked(t, uint8(1), body, r, s);
    }

    function _ds(string memory tag) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(tag).length), tag);
    }

    function _registered(string memory dj, string memory e) internal pure returns (uint256) {
        return _mask(vm.parseJsonUintArray(dj, string.concat(e, ".registered")));
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    /// Parameters for `dh` with one cell, of tier 0 (every delivery.json
    /// ballot's tier) and root 1, non-zero and below `r`, so a posting's
    /// ballot reaches its membership proof.
    function _setParameters(bytes32 dh, ElectionRegistry.Parameters memory p) internal {
        uint8[] memory tiers = new uint8[](1);
        uint256[] memory roots = new uint256[](1);
        roots[0] = 1;
        elections.set(dh, p, tiers, roots);
    }

    function _ballotCode(string memory s) internal pure returns (BallotCheckLib.Code) {
        bytes32 c = keccak256(bytes(s));
        if (c == keccak256("ballot-stray")) return BallotCheckLib.Code.BallotStray;
        if (c == keccak256("ballot-tier")) return BallotCheckLib.Code.BallotTier;
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
        if (c == keccak256("unexpected-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
        }
        if (c == keccak256("unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        if (c == keccak256("non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (c == keccak256("invalid-enum")) return ElectionDefinitionLib.DecodeError.InvalidEnum;
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", s));
    }

    // --- helpers: bytes ------------------------------------------------------------

    function _type(bytes memory r) internal pure returns (uint256) {
        return (uint256(uint8(r[0])) << 8) | uint8(r[1]);
    }

    function _u32(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 4; i++) {
            v = (v << 8) | uint8(r[o + i]);
        }
    }

    /// The 32 bytes at `o`, big-endian, zero-padded past the end.
    function _word(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 32; i++) {
            v = (v << 8) | (o + i < r.length ? uint8(r[o + i]) : 0);
        }
    }

    function _withWord(bytes memory r, uint256 at, uint256 word)
        internal
        pure
        returns (bytes memory c)
    {
        c = bytes.concat(r);
        for (uint256 i; i < 32; i++) {
            c[at + i] = bytes1(uint8(word >> (8 * (31 - i))));
        }
    }

    function _withByte(bytes memory r, uint256 at, uint8 b) internal pure returns (bytes memory c) {
        c = bytes.concat(r);
        c[at] = bytes1(b);
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

    /// A run of 12 printable bytes, or an at sign flanked by printable bytes:
    /// what a name, address or document number would show.
    function _looksLikeText(bytes memory b) internal pure returns (bool) {
        uint256 run;
        for (uint256 i; i < b.length; i++) {
            bool printable = uint8(b[i]) >= 0x20 && uint8(b[i]) < 0x7f;
            run = printable ? run + 1 : 0;
            if (run >= 12) return true;
            if (b[i] == 0x40 && i >= 2 && i + 2 < b.length) {
                bool flanked = true;
                for (uint256 k = i - 2; k <= i + 2; k++) {
                    if (uint8(b[k]) < 0x20 || uint8(b[k]) >= 0x7f) flanked = false;
                }
                if (flanked) return true;
            }
        }
        return false;
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(_str(json, key));
    }

    function _b32(string memory json, string memory key) internal pure returns (bytes32) {
        bytes memory b = _bytes(json, key);
        require(b.length == 32, string.concat("not 32 bytes: ", key));
        return bytes32(b);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
