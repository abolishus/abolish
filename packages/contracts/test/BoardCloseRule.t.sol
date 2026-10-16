// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "../src/BallotCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {CloseStatementLib} from "../src/CloseStatement.sol";
import {DeliveryCheckLib} from "../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TrusteeIdentityLib} from "../src/TrusteeRegistry.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {TrusteeFixture} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's close-rule paths (docs/spec/contracts.md, Board, Relayed
/// ballots, Close statements and Calls; docs/spec/close.md, Window): the
/// ordinary path's window, ballots forced through the L1 relay, and the
/// close statements' contract path. Against the vectors: contract-event-v3.json
/// (the board's whole event sequence, replayed at the file's board address
/// and chain, each log and accumulator the file's), close-statement.json (its
/// statements, decode rejections and window verdicts), relay.json (the L2
/// aliases) and ballot.json and ballot-v2.json (records with real membership
/// proofs). Every expected value comes from the files or from the spec, never
/// from the code under test; the registries are stubs set from the files.
/// Threats: T-35 and T-45 (a ballot made after close), T-50 (censorship of
/// direct submission), T-71 (a forged deposit), T-25 (a ballot kept off the
/// board), T-17 (chosen bytes) and T-31.
contract BoardCloseRuleTest is TestBase {
    string internal constant V1 = "../../docs/spec/vectors/ballot.json";
    string internal constant V2 = "../../docs/spec/vectors/ballot-v2.json";
    string internal constant CLOSE = "../../docs/spec/vectors/close-statement.json";
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v3.json";
    string internal constant RELAY_VECTORS = "../../docs/spec/vectors/relay.json";

    bytes32 internal constant STUB_V1 = keccak256("ballot stub");
    bytes32 internal constant STUB_V2 = keccak256("regional stub");
    bytes32 internal constant STUB_CLOSE = keccak256("close stub");
    bytes32 internal constant PANEL = keccak256("panel");
    bytes32 internal constant ACCUMULATOR_SLOT =
        0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;

    /// The spec's event signatures (contracts.md, Board, Events).
    bytes32 internal constant BALLOT_SUBMITTED =
        keccak256("BallotSubmitted(bytes32,bytes32,bytes)");
    bytes32 internal constant RELAYED_BALLOT_SUBMITTED =
        keccak256("RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)");
    bytes32 internal constant CLOSE_STATEMENT_SUBMITTED =
        keccak256("CloseStatementSubmitted(bytes32,uint8,bytes)");

    /// A close statement's layout (close.md, Close statement) and P-256's
    /// group order `n` (SEC 2).
    uint256 internal constant SIGNATURE_AT = 116;
    uint256 internal constant L1_HASH_AT = 44;
    uint256 internal constant L2_NUMBER_AT = 76;
    uint256 internal constant P256_N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    ElectionsStub internal elections;
    TrusteesStub internal trustees;
    DefinitionHarness internal defs;
    Board internal board;

    /// relay.json's first alias: the relay on L1, and its alias on L2.
    address internal relayL1;
    address internal relayAlias;

    /// ballot.json's plurality election, its window, and its first
    /// (admitted) ballot and the ballot the verifier rejects at a validity proof.
    bytes32 internal hV1;
    uint64 internal opensAt;
    uint64 internal closesAt;
    bytes internal honest;
    bytes32 internal honestHash;
    bytes internal optionProof;

    /// close-statement.json's election and statements, each seat's signing secret.
    bytes32 internal hClose;
    bytes[4] internal statements;
    mapping(uint8 seat => uint256) internal secrets;

    function setUp() public {
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        defs = new DefinitionHarness();
        string memory rj = vm.readFile(RELAY_VECTORS);
        relayL1 = _address(rj, ".aliases[0].l1");
        relayAlias = _address(rj, ".aliases[0].l2");
        board = new Board(address(elections), address(trustees), relayL1);

        string memory bj = vm.readFile(V1);
        hV1 = _b32(bj, ".elections.plurality.definitionHash");
        ElectionRegistry.Parameters memory p = _electionV1(bj);
        (opensAt, closesAt) = (p.opensAt, p.closesAt);
        honest = _ballotById(bj, "ok-tier-0");
        honestHash = _b32(bj, string.concat(_find(bj, ".ballots", "ok-tier-0"), ".ballotHash"));
        optionProof = _ballotById(bj, "option-proof");
        vm.warp(opensAt);

        string memory cj = vm.readFile(CLOSE);
        hClose = _b32(cj, ".election.definitionHash");
        ElectionRegistry.Parameters memory pc;
        // Any registered election: the statement check reads only that
        // the definition is registered, and its ceremony.
        pc.ballotVersion = 1;
        elections.set(hClose, pc, new uint8[](0), new uint256[](0));
        elections.setCeremony(hClose, STUB_CLOSE, PANEL);
        uint256 seats;
        for (uint256 i; vm.keyExistsJson(cj, _at(".election.registered", i, "")); i++) {
            string memory s = _at(".election.registered", i, "");
            uint256 seat = vm.parseJsonUint(cj, string.concat(s, ".index"));
            seats |= 1 << seat;
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(cj, string.concat(s, ".signingKey")));
            assertTrue(onCurve, "signing key");
            trustees.setKey(STUB_CLOSE, PANEL, seat, x, y);
        }
        trustees.setKeySet(STUB_CLOSE, PANEL, seats);
        for (uint256 i; i < 4; i++) {
            string memory s = _at(".statements", i, "");
            statements[i] = _bytes(cj, string.concat(s, ".encoding"));
            secrets[uint8(vm.parseJsonUint(cj, string.concat(s, ".signer")))] =
                vm.parseUint(string.concat("0x", _str(cj, string.concat(s, ".signingSecret"))));
        }
    }

    function test_VectorFileFormats() public view {
        assertTrue(
            _eq(_str(vm.readFile(EVENTS), ".format"), "abolish-contract-event-vectors/3"), "events"
        );
        assertTrue(
            _eq(_str(vm.readFile(CLOSE), ".format"), "abolish-close-statement-vectors/1"), "close"
        );
        assertTrue(_eq(_str(vm.readFile(V2), ".format"), "abolish-ballot-vectors/1"), "ballot v2");
    }

    // --- deployment and events ---------------------------------------------------

    /// The relay is the third immutable, non-zero (contracts.md, Board,
    /// Deployment); verifier 1.2 compares it with the definition's `l1_relay`.
    function test_DeploymentPinsANonZeroRelay() public {
        assertTrue(board.relay() == relayL1, "relay");
        bytes memory code = abi.encodePacked(
            type(Board).creationCode, abi.encode(address(elections), address(trustees), address(0))
        );
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        assertTrue(deployed == address(0), "a zero relay refused");
    }

    /// The two events' topic 0 is the spec's signature and contract-event
    /// version 3's: the ABI the archive reads is the one the board emits.
    function test_EventSignaturesAreTheSpecsAndVersion3s() public view {
        string memory ej = vm.readFile(EVENTS);
        assertEq(Board.RelayedBallotSubmitted.selector, RELAYED_BALLOT_SUBMITTED, "relayed");
        assertEq(Board.CloseStatementSubmitted.selector, CLOSE_STATEMENT_SUBMITTED, "close");
        uint256 found;
        for (uint256 i; vm.keyExistsJson(ej, _at(".events", i, "")); i++) {
            string memory e = _at(".events", i, "");
            if (!_eq(_str(ej, string.concat(e, ".role")), "board")) continue;
            bytes32 topic0 = _b32(ej, string.concat(e, ".topic0"));
            assertEq(keccak256(bytes(_str(ej, string.concat(e, ".signature")))), topic0, "topic 0");
            if (topic0 == RELAYED_BALLOT_SUBMITTED || topic0 == CLOSE_STATEMENT_SUBMITTED) found++;
        }
        assertEq(found, 2, "both events in version 3's table");
    }

    /// contract-event-v3.json's board sequence, replayed through the board at
    /// the file's address and chain, each record at its own L2 block and
    /// time: the ordinary ballot, the relayed ballots (one relayed twice
    /// after its ordinary submission, each emitting) and the close
    /// statements. Each call's input is the record's own event data; each
    /// log's topics and data, and the accumulator after it, are the file's,
    /// so the board emits exactly what version 3 archives.
    function test_ContractEventV3Sequence() public {
        string memory ej = vm.readFile(EVENTS);
        vm.chainId(vm.parseUint(_str(ej, ".chainId")));
        address at = _address(ej, ".contracts.board");
        vm.etch(at, address(board).code);
        vm.store(at, ACCUMULATOR_SLOT, EventAccumulatorLib.genesis(uint64(block.chainid), at));
        board = Board(at);
        _openEveryWindow();
        string memory seq = ".sequences[0]";
        assertTrue(_eq(_str(ej, string.concat(seq, ".role")), "board"), "the board's sequence");
        string[] memory ids = vm.parseJsonStringArray(ej, string.concat(seq, ".records"));
        string[] memory accs = vm.parseJsonStringArray(ej, string.concat(seq, ".accumulators"));
        assertTrue(ids.length >= 11, "every record");
        for (uint256 i; i < ids.length; i++) {
            string memory f = string.concat(_find(ej, ".records", ids[i]), ".fields");
            assertEq(vm.parseUint(_str(ej, string.concat(f, ".n"))), i, "in order");
            vm.roll(vm.parseUint(_str(ej, string.concat(f, ".l2Block"))));
            vm.warp(vm.parseUint(_str(ej, string.concat(f, ".l2Timestamp"))));
            string[] memory topics = vm.parseJsonStringArray(ej, string.concat(f, ".topics"));
            bytes memory data = _bytes(ej, string.concat(f, ".data"));
            bytes32 signature = bytes32(vm.parseBytes(topics[0]));
            vm.recordLogs();
            if (signature == BALLOT_SUBMITTED) {
                board.submitBallot(abi.decode(data, (bytes)));
            } else if (signature == RELAYED_BALLOT_SUBMITTED) {
                (uint64 index, uint64 l1Block, uint64 stamp, uint64 gasLimit, bytes memory r) =
                    abi.decode(data, (uint64, uint64, uint64, uint64, bytes));
                vm.prank(relayAlias);
                board.submitRelayedBallot(index, l1Block, stamp, gasLimit, r);
            } else {
                assertEq(signature, CLOSE_STATEMENT_SUBMITTED, "a known event");
                board.submitCloseStatement(abi.decode(data, (bytes)));
            }
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 1, "one log");
            assertTrue(logs[0].emitter == at, "the board's");
            assertEq(logs[0].topics.length, topics.length, "topic count");
            for (uint256 t; t < topics.length; t++) {
                assertEq(logs[0].topics[t], bytes32(vm.parseBytes(topics[t])), "topic");
            }
            assertTrue(keccak256(logs[0].data) == keccak256(data), "data");
            (bytes32 acc, uint64 count) = board.eventAccumulator();
            assertEq(count, i + 1, "count");
            assertEq(acc, bytes32(vm.parseBytes(accs[i])), "accumulator");
        }
    }

    // --- the ordinary path's window (close.md, Window) -------------------------

    /// close-statement.json's window verdicts for the ordinary and relayed
    /// paths, against its window: an ordinary ballot by the block's time, a
    /// relayed one by its stamp alone, its block hours after close. The board
    /// path's are the operator's, not the contract's.
    function test_WindowVectors() public {
        string memory cj = vm.readFile(CLOSE);
        uint64 open = uint64(vm.parseUint(_str(cj, ".window.opensAt")));
        uint64 close = uint64(vm.parseUint(_str(cj, ".window.closesAt")));
        _setWindow(open, close);
        uint256 checked;
        for (uint256 i; vm.keyExistsJson(cj, _at(".windows", i, "")); i++) {
            string memory w = _at(".windows", i, "");
            string memory path = _str(cj, string.concat(w, ".path"));
            if (_eq(path, "board")) continue;
            uint64 value = uint64(vm.parseUint(_str(cj, string.concat(w, ".value"))));
            bool admitted = _eq(_str(cj, string.concat(w, ".result")), "admitted");
            board = new Board(address(elections), address(trustees), relayL1);
            bytes memory data;
            bytes memory refusal;
            if (_eq(path, "ordinary")) {
                vm.warp(value);
                data = abi.encodeCall(Board.submitBallot, (honest));
                refusal = abi.encodeWithSelector(Board.BallotWindow.selector, value, open, close);
            } else {
                vm.warp(close + 12 hours);
                data = _relayedCall(7, 6_000_000, value, 5_000_000, honest);
                refusal = abi.encodeWithSelector(Board.RelayWindow.selector, value, open, close);
            }
            if (admitted) {
                assertEq(_accept(data).length, 1, w);
            } else {
                _refuse(data, refusal, w);
            }
            checked++;
        }
        assertEq(checked, 7, "every ordinary and relayed verdict");
    }

    /// Any block time: an ordinary ballot is accepted exactly inside
    /// `[opens_at, closes_at]`.
    function testFuzz_OrdinaryWindow(uint64 t) public {
        vm.warp(t);
        bytes memory data = abi.encodeCall(Board.submitBallot, (honest));
        if (t >= opensAt && t <= closesAt) {
            assertEq(_accept(data).length, 1, "inside");
        } else {
            _refuse(
                data,
                abi.encodeWithSelector(Board.BallotWindow.selector, t, opensAt, closesAt),
                "outside"
            );
        }
    }

    /// The window is checked after the ballot check: a stray or malformed
    /// record after close is refused for what it is.
    function test_WindowAfterTheBallotCheck() public {
        vm.warp(closesAt + 1);
        bytes memory stray = bytes.concat(honest);
        stray[3] ^= 0x01;
        _refuse(
            abi.encodeCall(Board.submitBallot, (stray)),
            abi.encodeWithSelector(
                BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.BallotStray
            ),
            "stray"
        );
    }

    /// A ballot refused after close isn't remembered: the same bytes inside
    /// the window are accepted. And an accepted ballot's repeat after close
    /// is the no-op of Calls, Repeats: it succeeds and emits nothing.
    function test_RefusalsAreNotRememberedAndRepeatsStayNoOps() public {
        bytes memory data = abi.encodeCall(Board.submitBallot, (honest));
        vm.warp(closesAt + 1);
        _refuse(
            data,
            abi.encodeWithSelector(Board.BallotWindow.selector, closesAt + 1, opensAt, closesAt),
            "after close"
        );
        vm.warp(closesAt);
        assertEq(_accept(data).length, 1, "at close");
        vm.warp(closesAt + 1 days);
        assertEq(_accept(data).length, 0, "a repeat emits nothing");
    }

    // --- relayed ballots (contracts.md, Board, Relayed ballots) -------------------

    function test_AcceptsARelayedBallotWithItsEvent() public {
        Vm.Log[] memory logs = _accept(_relayedCall(3, 6_000_100, opensAt, 5_000_000, honest));
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics.length, 3, "three topics");
        assertEq(logs[0].topics[0], RELAYED_BALLOT_SUBMITTED, "signature");
        assertEq(logs[0].topics[1], hV1, "definition hash");
        assertEq(logs[0].topics[2], honestHash, "ballot hash");
        assertTrue(
            keccak256(logs[0].data)
                == keccak256(
                    abi.encode(uint64(3), uint64(6_000_100), opensAt, uint64(5_000_000), honest)
                ),
            "the call's fields, then the record"
        );
    }

    /// Only the relay's alias may call, checked before anything is read: the
    /// relay's own L1 address, an alias of another contract and anyone else
    /// are refused, whatever their calldata.
    function test_RelayedBallotOnlyFromTheRelaysAlias() public {
        address[4] memory callers = [relayL1, address(this), address(0), _alias(address(this))];
        bytes memory good = _calldata(1, 2, opensAt, 4, honest);
        bytes memory bad = abi.encodePacked(good, bytes32(0));
        for (uint256 i; i < callers.length; i++) {
            bytes memory expected = abi.encodeWithSelector(Board.RelaySender.selector, callers[i]);
            _refuseFrom(callers[i], good, expected, "another sender");
            _refuseFrom(callers[i], bad, expected, "another sender, non-canonical calldata");
        }
    }

    /// relay.json's aliases, one wrapping modulo 2¹⁶⁰: a board pinning each
    /// non-zero L1 address accepts from its alias and refuses the address.
    function test_AliasVectors() public {
        string memory rj = vm.readFile(RELAY_VECTORS);
        uint256 checked;
        for (uint256 i; vm.keyExistsJson(rj, _at(".aliases", i, "")); i++) {
            address l1 = _address(rj, _at(".aliases", i, ".l1"));
            address l2 = _address(rj, _at(".aliases", i, ".l2"));
            if (l1 == address(0)) continue;
            board = new Board(address(elections), address(trustees), l1);
            bytes memory data = _calldata(i, 1, opensAt, 1, honest);
            _refuseFrom(
                l1, data, abi.encodeWithSelector(Board.RelaySender.selector, l1), "the L1 address"
            );
            vm.prank(l2);
            (bool ok, bytes memory ret) = address(board).call(data);
            assertTrue(ok, string.concat("the alias refused: ", vm.toString(ret)));
            checked++;
        }
        assertEq(checked, 4, "every non-zero alias");
    }

    /// The relayed call's calldata is canonical: four words, the offset
    /// 0xa0, the record padded, nothing after. A trailing word, dirty
    /// padding or another offset is refused; a word above 2⁶⁴ is refused by
    /// Solidity's decoder, with no data.
    function test_RelayedCalldataMustBeCanonical() public {
        bytes memory good = _calldata(1, 2, opensAt, 4, honest);
        assertTrue(honest.length % 32 != 0, "the record needs padding");
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        bytes memory dirty = bytes.concat(good);
        dirty[dirty.length - 1] = 0x01;
        bytes memory moved = abi.encodePacked(
            _slice(good, 0, 132), uint256(0xc0), bytes32(0), _slice(good, 164, good.length - 164)
        );
        _refuseFrom(relayAlias, abi.encodePacked(good, bytes32(0)), refusal, "trailing word");
        _refuseFrom(relayAlias, dirty, refusal, "dirty padding");
        _refuseFrom(relayAlias, moved, refusal, "moved offset");
        bytes memory high = bytes.concat(good);
        high[4 + 3 * 32 + 23] = 0x01;
        _refuseFrom(relayAlias, high, "", "a gas limit above 2^64");
        vm.prank(relayAlias);
        (bool ok,) = address(board).call(good);
        assertTrue(ok, "canonical");
    }

    /// A relayed ballot is checked exactly as an ordinary one: a stray record
    /// gets the ballot check's code, and a ballot the verifier rejects only at
    /// a validity proof is accepted. The window is checked after the ballot.
    function test_RelayedBallotsTakeTheBallotCheck() public {
        bytes memory stray = bytes.concat(honest);
        stray[3] ^= 0x01;
        bytes memory strayRefusal = abi.encodeWithSelector(
            BallotCheckLib.BallotRefused.selector, BallotCheckLib.Code.BallotStray
        );
        _refuseFrom(relayAlias, _calldata(0, 0, opensAt, 0, stray), strayRefusal, "stray");
        _refuseFrom(relayAlias, _calldata(0, 0, closesAt + 1, 0, stray), strayRefusal, "late stray");
        assertEq(_accept(_relayedCall(0, 0, opensAt, 0, optionProof)).length, 1, "option proof");
    }

    /// Any stamp: a relayed ballot is accepted exactly when its stamp is
    /// inside `[opens_at, closes_at]`, whatever the L2 block's time.
    function testFuzz_RelayedWindow(uint64 stamp, uint64 blockTime) public {
        vm.warp(blockTime);
        bytes memory data = _relayedCall(1, 1, stamp, 1, honest);
        if (stamp >= opensAt && stamp <= closesAt) {
            assertEq(_accept(data).length, 1, "inside");
        } else {
            _refuseFrom(
                relayAlias,
                _calldata(1, 1, stamp, 1, honest),
                abi.encodeWithSelector(Board.RelayWindow.selector, stamp, opensAt, closesAt),
                "outside"
            );
        }
    }

    /// No repeats on the relayed path: every accepted deposit emits, a byte-
    /// identical record already accepted on the ordinary path included. The
    /// relayed record is remembered, so a later ordinary copy is a no-op.
    function test_RelayedPathKeepsNoRepeats() public {
        assertEq(_accept(abi.encodeCall(Board.submitBallot, (honest))).length, 1, "ordinary");
        assertEq(_accept(_relayedCall(0, 1, opensAt, 1, honest)).length, 1, "relayed after it");
        assertEq(_accept(_relayedCall(0, 1, opensAt, 1, honest)).length, 1, "the same deposit");
        board = new Board(address(elections), address(trustees), relayL1);
        assertEq(_accept(_relayedCall(0, 1, opensAt, 1, honest)).length, 1, "relayed first");
        assertEq(_accept(abi.encodeCall(Board.submitBallot, (honest))).length, 0, "then a no-op");
    }

    /// A relayed ballot refused for its stamp isn't remembered: the same
    /// bytes are then accepted on the ordinary path.
    function test_ARefusedRelayedBallotIsNotRemembered() public {
        _refuseFrom(
            relayAlias,
            _calldata(0, 0, closesAt + 1, 0, honest),
            abi.encodeWithSelector(Board.RelayWindow.selector, closesAt + 1, opensAt, closesAt),
            "late"
        );
        assertEq(_accept(abi.encodeCall(Board.submitBallot, (honest))).length, 1, "ordinary");
    }

    function testFuzz_ArbitrarySenderRefused(address caller) public {
        vm.assume(caller != relayAlias);
        _refuseFrom(
            caller,
            _calldata(0, 0, opensAt, 0, honest),
            abi.encodeWithSelector(Board.RelaySender.selector, caller),
            "sender"
        );
    }

    // --- close statements (contracts.md, Board, Close statements) ----------------

    /// Each statement of close-statement.json is accepted with its event:
    /// its definition hash and signer as topics, the record as data.
    function test_AcceptsEachStatementWithItsEvent() public {
        for (uint256 i; i < 4; i++) {
            Vm.Log[] memory logs = _accept(_statementCall(statements[i]));
            assertEq(logs.length, 1, "one event");
            assertEq(logs[0].topics.length, 3, "three topics");
            assertEq(logs[0].topics[0], CLOSE_STATEMENT_SUBMITTED, "signature");
            assertEq(logs[0].topics[1], hClose, "definition hash");
            assertEq(logs[0].topics[2], bytes32(uint256(uint8(statements[i][35]))), "signer");
            assertTrue(
                keccak256(logs[0].data) == keccak256(abi.encode(statements[i])), "the record"
            );
        }
    }

    /// close-statement.json's decode rejections, with the board's codes: a
    /// type [[versioning]] lists is `unexpected-record-type`, and any version
    /// but 1 is `unknown-version` (contracts.md, Close statements, step 1),
    /// where the file, decoding against a pinned version, says
    /// `profile-mismatch`.
    function test_StatementDecodeVectors() public {
        string memory cj = vm.readFile(CLOSE);
        uint256 i;
        for (; vm.keyExistsJson(cj, _at(".decodeErrors", i, "")); i++) {
            string memory v = _at(".decodeErrors", i, "");
            bytes memory encoding = _bytes(cj, string.concat(v, ".encoding"));
            ElectionDefinitionLib.DecodeError code =
                _decodeError(_str(cj, string.concat(v, ".error")));
            if (code == ElectionDefinitionLib.DecodeError.ProfileMismatch) {
                code = ElectionDefinitionLib.DecodeError.UnknownVersion;
            }
            if (code == ElectionDefinitionLib.DecodeError.UnknownRecordType) {
                uint256 t = (uint256(uint8(encoding[0])) << 8) | uint8(encoding[1]);
                if (t != 0 && t <= BallotCheckLib.LAST_KNOWN_TYPE) {
                    code = ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
                }
            }
            _refuse(
                _statementCall(encoding),
                _malformed(code, vm.parseJsonUint(cj, string.concat(v, ".offset"))),
                v
            );
        }
        assertEq(i, 9, "every decode rejection");
    }

    /// The signature's framing (trustee-identity.md, Signatures), each
    /// re-signed so only the framing differs: `r` at 0 and `n`, `s` at 0 and
    /// just above the low half are `non-canonical` at 116; `s` at the low
    /// half's top frames and fails the signature. An unlisted type and type 0
    /// are `unknown-record-type`, and a type the board knows another.
    function test_StatementFraming() public {
        bytes memory s = statements[0];
        uint256 half = TrusteeIdentityLib.HALF_N;
        uint256[4] memory rs = [uint256(0), P256_N, 1, 1];
        uint256[4] memory ss = [uint256(1), 1, 0, half + 1];
        for (uint256 i; i < 4; i++) {
            _refuse(
                _statementCall(_withSignature(s, rs[i], ss[i])),
                _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, SIGNATURE_AT),
                "signature out of range"
            );
        }
        _refuse(
            _statementCall(_withSignature(s, P256_N - 1, half)),
            _refused(CloseStatementLib.Code.StatementSignature),
            "the top of the low half frames"
        );
        _refuse(
            _statementCall(_withType(s, 0x001a)),
            _malformed(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0),
            "the last listed type"
        );
        _refuse(
            _statementCall(_withType(s, 0x001b)),
            _malformed(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "an unlisted type"
        );
        _refuse(
            _statementCall(_withType(s, 0)),
            _malformed(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "type 0"
        );
        _refuse(
            _statementCall(_withType(s, 0x0002)),
            _malformed(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0),
            "a ballot's type"
        );
        bytes memory one = new bytes(1);
        _refuse(
            _statementCall(one),
            _malformed(ElectionDefinitionLib.DecodeError.Truncated, 0),
            "one byte"
        );
    }

    /// `statement-stray`, `statement-seat` and `statement-signature`, each
    /// signed by a registered seat's key so only the named check fails.
    function test_StatementRefusals() public {
        bytes memory s = statements[0];
        // Another definition, signed by seat 1: nothing registered there.
        _refuse(
            _statementCall(_signed(_withWord(s, 3, uint256(keccak256("other"))), 1)),
            _refused(CloseStatementLib.Code.StatementStray),
            "stray"
        );
        // Seats outside the key set {1, 2, 3, 5}, signed by seat 1.
        uint8[5] memory outside = [0, 4, 6, 16, 255];
        for (uint256 i; i < outside.length; i++) {
            _refuse(
                _statementCall(_signed(_withByte(s, 35, outside[i]), 1)),
                _refused(CloseStatementLib.Code.StatementSeat),
                "a seat outside the key set"
            );
        }
        // Seat 2 named, seat 1's signature: another seat's key.
        _refuse(
            _statementCall(_signed(_withByte(s, 35, 2), 1)),
            _refused(CloseStatementLib.Code.StatementSignature),
            "another seat's key"
        );
        // Each signed field changed under the original signature.
        uint256[5] memory at = [uint256(36), 44, 76, 84, 115];
        for (uint256 i; i < at.length; i++) {
            _refuse(
                _statementCall(_withByte(s, at[i], uint8(s[at[i]]) ^ 1)),
                _refused(CloseStatementLib.Code.StatementSignature),
                "a signed field changed"
            );
        }
    }

    /// Seat 0 never exists, whatever a key set's bit 0 says (contracts.md,
    /// Close statements, `statement-seat`): here bit 0 is set and seat 0 has
    /// seat 1's signing key, so only that rule refuses a statement seat 1's
    /// key signs as seat 0.
    function test_SeatZeroNeverStates() public {
        (, uint256 seats) = trustees.keySetOf(STUB_CLOSE, PANEL);
        trustees.setKeySet(STUB_CLOSE, PANEL, seats | 1);
        (uint256 x, uint256 y) = trustees.signingKeyOf(STUB_CLOSE, PANEL, 1);
        trustees.setKey(STUB_CLOSE, PANEL, 0, x, y);
        _refuse(
            _statementCall(_signed(_withByte(statements[0], 35, 0), 1)),
            _refused(CloseStatementLib.Code.StatementSeat),
            "seat 0"
        );
    }

    /// The checks run in the spec's order: decoding before the election, the
    /// election before the seat, the seat before the signature.
    function test_StatementCheckOrder() public {
        bytes memory s = statements[0];
        bytes memory strayOutside = _withByte(_withWord(s, 3, 1), 35, 4);
        _refuse(
            _statementCall(_withSignature(strayOutside, 0, 1)),
            _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, SIGNATURE_AT),
            "decoding first"
        );
        _refuse(
            _statementCall(strayOutside),
            _refused(CloseStatementLib.Code.StatementStray),
            "the election before the seat"
        );
        _refuse(
            _statementCall(_withByte(s, 35, 4)),
            _refused(CloseStatementLib.Code.StatementSeat),
            "the seat before the signature"
        );
    }

    /// At most two statements per seat and election, the second only with
    /// another claim (`statement-limit`): a same-claim statement with other
    /// bytes is refused, a second claim accepted, a third refused; a
    /// byte-identical repeat is a no-op before and after the limit; other
    /// seats and other elections keep their own two.
    function test_StatementLimit() public {
        bytes memory first = statements[0];
        assertEq(_accept(_statementCall(first)).length, 1, "first");
        bytes memory limit = _refused(CloseStatementLib.Code.StatementLimit);
        // The same claim against another L1 block: other bytes, same claim.
        bytes memory sameClaim = _signed(_withWord(first, L1_HASH_AT, 7), 1);
        _refuse(_statementCall(sameClaim), limit, "the same claim again");
        assertEq(_accept(_statementCall(first)).length, 0, "a repeat is a no-op");
        bytes memory second = _signed(_withWord(first, L2_NUMBER_AT + 8, 9), 1);
        assertEq(_accept(_statementCall(second)).length, 1, "another claim");
        bytes memory third = _signed(_withWord(first, L2_NUMBER_AT + 8, 10), 1);
        _refuse(_statementCall(third), limit, "a third");
        _refuse(_statementCall(sameClaim), limit, "the first claim again");
        assertEq(_accept(_statementCall(second)).length, 0, "a repeat after the limit");
        assertEq(_accept(_statementCall(statements[1])).length, 1, "another seat");
        // Another election under the same key set: its own two.
        bytes32 other = keccak256("another election");
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 1;
        elections.set(other, p, new uint8[](0), new uint256[](0));
        elections.setCeremony(other, STUB_CLOSE, PANEL);
        assertEq(
            _accept(_statementCall(_signed(_withWord(third, 3, uint256(other)), 1))).length,
            1,
            "another election"
        );
    }

    /// No one-byte change to an honest statement is accepted.
    function testFuzz_NoOneByteChangeToAStatementAccepted(uint256 position, uint8 delta) public {
        vm.assume(delta != 0);
        bytes memory s = statements[0];
        uint256 at = _bound(position, 0, s.length - 1);
        _refuseFuzzed(_statementCall(_withByte(s, at, uint8(s[at]) ^ delta)));
    }

    /// No arbitrary record is accepted, and every refusal is the board's.
    function testFuzz_ArbitraryStatementRefused(bytes calldata r) public {
        _refuseFuzzed(_statementCall(r));
    }

    /// An arbitrary body behind an honest header and definition is refused.
    function testFuzz_ArbitraryStatementBodyRefused(bytes calldata body) public {
        _refuseFuzzed(_statementCall(bytes.concat(_slice(statements[0], 0, 36), body)));
    }

    /// The statement call's calldata is canonical, as every call's.
    function test_StatementCalldataMustBeCanonical() public {
        bytes memory good = _statementCall(statements[0]);
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _refuse(abi.encodePacked(good, bytes32(0)), refusal, "trailing word");
        bytes memory dirty = bytes.concat(good);
        dirty[dirty.length - 1] = 0x01;
        _refuse(dirty, refusal, "dirty padding");
        assertEq(_accept(good).length, 1, "canonical");
    }

    // --- personal data and gas -----------------------------------------------------

    /// The two calls' calldata and events carry no text.
    function test_NoPersonalDataInCalldataOrEvents() public {
        bytes[2] memory calls =
            [_relayedCall(5, 6_000_000, opensAt, 5_000_000, honest), _statementCall(statements[0])];
        for (uint256 i; i < calls.length; i++) {
            assertTrue(!_looksLikeText(calls[i]), "calldata");
            Vm.Log[] memory logs = _accept(calls[i]);
            assertTrue(!_looksLikeText(logs[0].data), "event data");
            for (uint256 t; t < logs[0].topics.length; t++) {
                assertTrue(!_looksLikeText(abi.encode(logs[0].topics[t])), "event topic");
            }
        }
    }

    /// Measured from the caller under `cancun` (OpenZeppelin's P256 in
    /// Solidity): a relayed ballot of three options at `k = 2` and `n = 3`
    /// costs about what an ordinary one does, and a close statement about
    /// what a share receipt does (contracts.md, Board, Gas).
    function test_Gas() public {
        uint256 ordinary = _gas(abi.encodeCall(Board.submitBallot, (honest)), address(this));
        board = new Board(address(elections), address(trustees), relayL1);
        uint256 relayed = _gas(_calldata(0, 1, opensAt, 1, honest), relayAlias);
        uint256 statement = _gas(_statementCall(statements[0]), address(this));
        assertTrue(relayed < ordinary + 20_000, "relayed");
        assertTrue(statement < 400_000, "statement");
    }

    // --- helpers: calls --------------------------------------------------------------

    function _calldata(uint256 index, uint256 l1Block, uint256 stamp, uint256 gas, bytes memory r)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            Board.submitRelayedBallot,
            (uint64(index), uint64(l1Block), uint64(stamp), uint64(gas), r)
        );
    }

    /// A relayed-ballot call, which `_accept` and `_refuse` then run from the
    /// relay's alias: the calldata tagged with a leading marker byte.
    function _relayedCall(
        uint256 index,
        uint256 l1Block,
        uint256 stamp,
        uint256 gas,
        bytes memory r
    ) internal pure returns (bytes memory) {
        return bytes.concat(hex"a1", _calldata(index, l1Block, stamp, gas, r));
    }

    function _statementCall(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitCloseStatement, (r));
    }

    /// Runs `data` (from the relay's alias if `_relayedCall` tagged it),
    /// which the board must accept, and returns the logs it emitted, each
    /// the board's and folded into the accumulator in order.
    function _accept(bytes memory data) internal returns (Vm.Log[] memory logs) {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        (address from, bytes memory call) = _untag(data);
        vm.recordLogs();
        vm.prank(from);
        (bool ok, bytes memory ret) = address(board).call(call);
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

    function _refuse(bytes memory data, bytes memory expected, string memory what) internal {
        (address from, bytes memory call) = _untag(data);
        _refuseFrom(from, call, expected, what);
    }

    /// Runs `call` from `from`, which the board must refuse with exactly
    /// `expected`, leaving the accumulator as it was.
    function _refuseFrom(address from, bytes memory call, bytes memory expected, string memory what)
        internal
    {
        bytes memory ret = _refusal(from, call, what);
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
    }

    /// Refused with one of the board's own errors, never another revert.
    function _refuseFuzzed(bytes memory data) internal {
        (address from, bytes memory call) = _untag(data);
        bytes4 s = bytes4(_refusal(from, call, "fuzzed input"));
        assertTrue(
            s == CloseStatementLib.StatementMalformed.selector
                || s == CloseStatementLib.StatementRefused.selector
                || s == CanonicalCalldata.NonCanonicalCalldata.selector,
            "an unexpected revert"
        );
    }

    function _refusal(address from, bytes memory call, string memory what)
        internal
        returns (bytes memory ret)
    {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.prank(from);
        bool ok;
        (ok, ret) = address(board).call(call);
        assertTrue(!ok, string.concat(what, ": accepted"));
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(countAfter, count, what);
        assertEq(after_, acc, what);
    }

    function _untag(bytes memory data) internal view returns (address from, bytes memory call) {
        if (data.length % 32 == 5 && data[0] == 0xa1) {
            return (relayAlias, _slice(data, 1, data.length - 1));
        }
        return (address(this), data);
    }

    function _gas(bytes memory data, address from) internal returns (uint256 used) {
        address target = address(board);
        vm.prank(from);
        uint256 before = gasleft();
        (bool ok,) = target.call(data);
        used = before - gasleft();
        assertTrue(ok, "gas call refused");
    }

    function _malformed(ElectionDefinitionLib.DecodeError code, uint256 offset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(CloseStatementLib.StatementMalformed.selector, code, offset);
    }

    function _refused(CloseStatementLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(CloseStatementLib.StatementRefused.selector, code);
    }

    // --- helpers: elections ------------------------------------------------------------

    /// ballot.json's plurality election, with its definition's window, and
    /// ballot-v2.json's regional election, both under their first ballot's
    /// key set.
    function _electionV1(string memory bj) internal returns (ElectionRegistry.Parameters memory p) {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(bj, ".elections.plurality.definition"));
        p.ballotVersion = 1;
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.optionCount = d.optionCount;
        p.opensAt = d.opensAt;
        p.closesAt = d.closesAt;
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] =
            ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        (uint8[] memory tiers, uint256[] memory roots) = _cells(bj, ".elections.plurality.tiers");
        elections.set(hV1, p, tiers, roots);
        elections.setCeremony(hV1, STUB_V1, PANEL);
        trustees.setKeySet(
            STUB_V1,
            PANEL,
            _mask(
                vm.parseJsonUintArray(
                    bj, string.concat(_find(bj, ".ballots", "ok-tier-0"), ".registered")
                )
            )
        );
    }

    /// Every election the event sequence names, with a window holding every
    /// time and stamp it uses (0 to 2⁶⁴ − 1): the sequence's times are its
    /// own, not the definitions'.
    function _openEveryWindow() internal {
        _setWindow(0, type(uint64).max);
        string memory vj = vm.readFile(V2);
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(vj, ".elections.regional.definition"));
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 2;
        p.threshold = d.threshold;
        p.panelSize = d.panelSize;
        p.optionCount = d.optionCount;
        p.closesAt = type(uint64).max;
        p.questions = new ElectionRegistry.Question[](1);
        p.questions[0] =
            ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        bytes32 h = _b32(vj, ".elections.regional.definitionHash");
        (uint8[] memory tiers, uint256[] memory roots) = _cells(vj, ".elections.regional.cells");
        elections.set(h, p, tiers, roots);
        elections.setCeremony(h, STUB_V2, PANEL);
        trustees.setKeySet(
            STUB_V2,
            PANEL,
            _mask(
                vm.parseJsonUintArray(
                    vj, string.concat(_find(vj, ".ballots", "ok-cell-0"), ".registered")
                )
            )
        );
    }

    /// The plurality election's parameters with another window.
    function _setWindow(uint64 open, uint64 close) internal {
        ElectionRegistry.Parameters memory p = elections.parameters(hV1);
        (p.opensAt, p.closesAt) = (open, close);
        uint8[] memory tiers = elections.cellTiers(hV1);
        uint256[] memory roots = new uint256[](tiers.length);
        for (uint256 i; i < tiers.length; i++) {
            (, roots[i]) = elections.cell(hV1, i);
        }
        elections.set(hV1, p, tiers, roots);
    }

    function _cells(string memory j, string memory list)
        internal
        view
        returns (uint8[] memory tiers, uint256[] memory roots)
    {
        uint256 n;
        while (vm.keyExistsJson(j, _at(list, n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            tiers[i] = uint8(vm.parseJsonUint(j, _at(list, i, ".tier")));
            roots[i] = vm.parseUint(_str(j, _at(list, i, ".root")));
        }
    }

    function _ballotById(string memory j, string memory id) internal view returns (bytes memory) {
        return _bytes(j, string.concat(_find(j, ".ballots", id), ".encoding"));
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    /// `a + 0x1111…1111 mod 2¹⁶⁰` (contracts.md, L1 relay, Relaying).
    function _alias(address a) internal pure returns (address) {
        unchecked {
            return address(uint160(a) + uint160(0x1111000000000000000000000000000000001111));
        }
    }

    // --- helpers: statements -------------------------------------------------------------

    /// `s` re-signed by `seat`'s signing secret over its first 116 bytes
    /// under `abolish/v1/sig/close-statement`, as close.md defines it.
    function _signed(bytes memory s, uint8 seat) internal view returns (bytes memory) {
        bytes32 digest =
            sha256(bytes.concat("\x1eabolish/v1/sig/close-statement", _slice(s, 0, SIGNATURE_AT)));
        (uint256 r, uint256 sig) = TrusteeFixture.sign(secrets[seat], digest);
        return _withSignature(s, r, sig);
    }

    function _withSignature(bytes memory s, uint256 r, uint256 sig)
        internal
        pure
        returns (bytes memory)
    {
        return _withWord(_withWord(s, SIGNATURE_AT, r), SIGNATURE_AT + 32, sig);
    }

    function _withType(bytes memory s, uint16 t) internal pure returns (bytes memory c) {
        c = _withByte(s, 0, uint8(t >> 8));
        c[1] = bytes1(uint8(t));
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
        if (c == keccak256("unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        if (c == keccak256("non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", s));
    }

    // --- helpers: bytes and JSON -----------------------------------------------------------

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

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + x % (hi - lo + 1);
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

    function _find(string memory json, string memory list, string memory id)
        internal
        view
        returns (string memory)
    {
        for (uint256 i; vm.keyExistsJson(json, _at(list, i, "")); i++) {
            if (_eq(_str(json, _at(list, i, ".id")), id)) return _at(list, i, "");
        }
        revert(string.concat("no ", id, " in ", list));
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _address(string memory json, string memory key) internal pure returns (address) {
        return address(bytes20(_bytes(json, key)));
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        string memory hexString = _str(json, key);
        // Foundry won't parse an empty string as bytes.
        return bytes(hexString).length == 0 ? bytes("") : vm.parseBytes(hexString);
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
