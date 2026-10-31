// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotRelay, RelayCallLib} from "../src/BallotRelay.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {MockPortal} from "./BallotRelay.t.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// Exposes both call hashes to tests.
contract RollingRelayHarness {
    function callHash(
        uint64 l1ChainId,
        address relay,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes calldata record
    ) external pure returns (bytes32) {
        return RelayCallLib.callHash(l1ChainId, relay, index, l1Block, stamp, gasLimit, record);
    }

    function rollingCallHash(
        uint64 l1ChainId,
        address relay,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes32 root,
        bytes calldata record
    ) external pure returns (bytes32) {
        return RelayCallLib.rollingCallHash(
            l1ChainId, relay, index, l1Block, stamp, gasLimit, root, record
        );
    }
}

/// The L1 relay's rolling call (docs/spec/contracts.md, L1 relay, Rolling
/// ballots) against relay-rolling.json: its selectors, every call's hash,
/// stored word, event and deposit data at the vector's own address, chain,
/// block and time, the framing and calldata verdicts, and the relay's one
/// sequence of both calls with its event accumulator. Every expected value
/// comes from the file or the spec, never from the code under test.
/// Threats: T-50 (censorship of direct submission), T-71 (a forged deposit,
/// here one carrying another root), T-25 (a forced ballot kept off the
/// board), T-17 (chosen bytes) and T-52 (oversized input).
contract BallotRelayRollingTest is TestBase {
    string internal constant VECTORS = "../../docs/spec/vectors/relay-rolling.json";
    address internal constant BOARD = address(0xB0A4D);

    /// The spec's values (contracts.md, L1 relay).
    bytes32 internal constant BALLOT_RELAYED = keccak256("BallotRelayed(bytes32,uint64,bytes32)");
    bytes32 internal constant SLOT =
        0xeddbfcaa40c756990a5dda7c565d5921d82a1a88a4b83bd8b0415aeae8667900;
    bytes32 internal constant ACCUMULATOR_SLOT =
        0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;
    string internal constant DEPOSIT =
        "submitRelayedRollingBallot(uint64,uint64,uint64,uint64,bytes32,bytes)";
    bytes32 internal constant ROOT = keccak256("a step root");

    MockPortal internal portal;
    BallotRelay internal relay;
    RollingRelayHarness internal harness;
    string internal json;

    function setUp() public {
        json = vm.readFile(VECTORS);
        portal = new MockPortal();
        relay = new BallotRelay(address(portal), BOARD);
        harness = new RollingRelayHarness();
    }

    function test_VectorFileFormat() public view {
        assertTrue(_eq(_str(".format"), "abolish-relay-rolling-vectors/1"), "format");
        assertTrue(_eq(_str(".tag"), "abolish/v1/relay-rolling-call"), "tag");
        assertTrue(
            keccak256(RelayCallLib.DS_RELAY_ROLLING_CALL)
                == keccak256(
                    bytes.concat(bytes1(uint8(bytes(_str(".tag")).length)), bytes(_str(".tag")))
                ),
            "the tag's length prefix"
        );
        uint256 max = relay.MAX_ROLLING_RELAY_RECORD();
        assertEq(vm.parseJsonUint(json, ".maxRollingRelayRecord"), max, "max");
        assertEq(vm.parseJsonUint(json, ".maxRelayRecord"), relay.MAX_RELAY_RECORD(), "fixed max");
        // The largest record's deposit data, 228 bytes and the record padded
        // to whole words, fits the portal's cap, and one more word wouldn't.
        uint256 cap = vm.parseJsonUint(json, ".portalMaxData");
        assertEq(max % 32, 0, "a whole number of words");
        assertTrue(228 + max <= cap && 228 + max + 32 > cap, "the longest that fits");
        assertEq(relay.MAX_RELAY_RECORD() - max, 32, "one word below the fixed call's");
    }

    /// The relay's rolling call, the board's relayed rolling call and the
    /// event's topic 0 are the file's.
    function test_SignaturesAreTheFiles() public view {
        assertTrue(
            bytes4(_bytes(".signatures.relay.selector")) == BallotRelay.relayRollingBallot.selector,
            "relay selector"
        );
        assertTrue(
            _eq(_str(".signatures.relay.signature"), "relayRollingBallot(uint64,bytes32,bytes)"),
            "relay signature"
        );
        assertTrue(_eq(_str(".signatures.deposit.signature"), DEPOSIT), "deposit signature");
        assertTrue(
            bytes4(_bytes(".signatures.deposit.selector")) == bytes4(keccak256(bytes(DEPOSIT))),
            "deposit selector"
        );
        assertEq(_b32(".signatures.event.topic0"), BALLOT_RELAYED, "topic 0");
    }

    // --- calls -------------------------------------------------------------------

    /// Every call of the file at its own relay address, L1 chain, index,
    /// block and stamp: the returned index, the word stored for it, the
    /// count, the event's topics and data, and the deposit's target, value,
    /// gas limit and data are the file's; and the fixed call's hash over the
    /// same fields, without the root, is the file's other hash.
    function test_CallVectors() public {
        uint256 n;
        for (; vm.keyExistsJson(json, _at(".calls", n, "")); n++) {
            string memory c = _at(".calls", n, "");
            uint64 index = uint64(vm.parseUint(_str(string.concat(c, ".index"))));
            bytes memory record = _record(c);
            bytes32 expected = _b32(string.concat(c, ".callHash"));
            assertEq(_rollingHashOf(c, record), expected, "the library's call hash");
            assertEq(
                _fixedHashOf(c, record), _b32(string.concat(c, ".fixedCallHash")), "fixed hash"
            );
            assertTrue(expected != _b32(string.concat(c, ".fixedCallHash")), "the tags differ");
            // Call 2⁶⁴ − 1 can't be recorded (its count would be 2⁶⁴), so
            // only its hashes are checked; the refusal has its own test.
            if (index == type(uint64).max) continue;
            BallotRelay r = _relayAt(c, index);
            uint256 deposits = portal.depositCount();
            vm.recordLogs();
            uint64 got = r.relayRollingBallot(_gasLimit(c), _b32(string.concat(c, ".root")), record);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(got, index, "index");
            assertEq(r.callHash(index), expected, "stored call hash");
            assertEq(r.callCount(), uint256(index) + 1, "count");
            assertEq(
                vm.load(address(r), keccak256(abi.encode(uint256(index), uint256(SLOT) + 1))),
                expected,
                "the word at the call's slot"
            );
            assertEq(logs.length, 1, "one log");
            assertTrue(logs[0].emitter == address(r), "emitter");
            _assertLog(logs[0], c);
            assertEq(portal.depositCount(), deposits + 1, "one deposit");
            MockPortal.Deposit memory d = portal.deposit(deposits);
            assertTrue(d.to == BOARD, "to the board");
            assertEq(d.value, 0, "no value");
            assertEq(d.gasLimit, _gasLimit(c), "the caller's gas limit");
            assertTrue(!d.isCreation, "a call");
            assertEq(
                d.data.length,
                vm.parseJsonUint(json, string.concat(c, ".depositDataLength")),
                "length"
            );
            assertEq(sha256(d.data), _b32(string.concat(c, ".depositDataSha256")), "deposit data");
            if (vm.keyExistsJson(json, string.concat(c, ".depositData"))) {
                assertTrue(
                    keccak256(d.data) == keccak256(_bytes(string.concat(c, ".depositData"))),
                    "deposit data bytes"
                );
            }
        }
        assertTrue(n >= 11, "every call");
    }

    /// The relay's one sequence, fixed and rolling calls interleaved from one
    /// count: each call's slot, word, event and accumulator are the file's.
    function test_SequenceVectors() public {
        vm.chainId(vm.parseUint(_str(".sequence.l1ChainId")));
        address at = address(bytes20(_bytes(".sequence.relay")));
        vm.etch(at, address(relay).code);
        BallotRelay r = BallotRelay(at);
        bytes32 genesis = _b32(".sequence.genesis");
        assertEq(EventAccumulatorLib.genesis(uint64(block.chainid), at), genesis, "genesis");
        vm.store(at, ACCUMULATOR_SLOT, genesis);
        uint256 i;
        bool fixedSeen;
        bool rollingSeen;
        for (; vm.keyExistsJson(json, _at(".sequence.calls", i, "")); i++) {
            string memory c = _at(".sequence.calls", i, "");
            assertEq(vm.parseUint(_str(string.concat(c, ".index"))), i, "calls in order");
            vm.roll(vm.parseUint(_str(string.concat(c, ".l1Block"))));
            vm.warp(vm.parseUint(_str(string.concat(c, ".l1Timestamp"))));
            bytes memory record = _bytes(string.concat(c, ".record"));
            vm.recordLogs();
            uint64 got;
            if (_eq(_str(string.concat(c, ".call")), "rolling")) {
                rollingSeen = true;
                got = r.relayRollingBallot(_gasLimit(c), _b32(string.concat(c, ".root")), record);
            } else {
                assertTrue(_eq(_str(string.concat(c, ".call")), "fixed"), "a known call");
                fixedSeen = true;
                got = r.relayBallot(_gasLimit(c), record);
            }
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(got, i, "index");
            bytes32 slot = _b32(string.concat(c, ".slot"));
            assertEq(slot, keccak256(abi.encode(i, uint256(SLOT) + 1)), "the call's slot");
            assertEq(vm.load(at, slot), _b32(string.concat(c, ".callHash")), "the word");
            assertEq(r.callHash(uint64(i)), _b32(string.concat(c, ".callHash")), "callHash");
            assertEq(logs.length, 1, "one log");
            _assertLog(logs[0], c);
            (bytes32 acc, uint64 count) = r.eventAccumulator();
            assertEq(count, i + 1, "log count");
            assertEq(acc, _b32(string.concat(c, ".accumulator")), "accumulator");
        }
        assertEq(i, vm.parseUint(_str(".sequence.count")), "every call");
        assertEq(r.callCount(), i, "count");
        assertTrue(fixedSeen && rollingSeen, "both calls");
    }

    /// Call 2⁶⁴ − 1 is refused (checked arithmetic), recording nothing.
    function test_TheLastIndexIsNeverRecorded() public {
        vm.store(address(relay), SLOT, bytes32(uint256(type(uint64).max)));
        _refusal(
            abi.encodeCall(BallotRelay.relayRollingBallot, (5_000_000, ROOT, _framed())),
            "the last index"
        );
        assertEq(relay.callHash(type(uint64).max), bytes32(0), "nothing recorded");
    }

    // --- framing and calldata ------------------------------------------------------

    /// Each framing vector: a framed record is recorded and deposited; the
    /// rest are refused with the file's code before anything is recorded.
    function test_FramingVectors() public {
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".framing", i, "")); i++) {
            string memory v = _at(".framing", i, "");
            bytes memory record = _record(v);
            string memory result = _str(string.concat(v, ".result"));
            if (_eq(result, "framed")) {
                vm.recordLogs();
                relay.relayRollingBallot(5_000_000, ROOT, record);
                Vm.Log[] memory logs = vm.getRecordedLogs();
                assertEq(logs[0].topics[1], _b32(string.concat(v, ".definitionHash")), "definition");
                continue;
            }
            bytes memory expected;
            if (_eq(result, "relay-truncated")) {
                expected =
                    abi.encodeWithSelector(BallotRelay.RelayTruncated.selector, record.length);
            } else if (_eq(result, "relay-record-type")) {
                expected = abi.encodeWithSelector(
                    BallotRelay.RelayRecordType.selector, uint16(bytes2(record))
                );
            } else if (_eq(result, "relay-too-large")) {
                expected = abi.encodeWithSelector(BallotRelay.RelayTooLarge.selector, record.length);
            } else {
                revert(string.concat("unknown result ", result));
            }
            _refuse(
                abi.encodeCall(BallotRelay.relayRollingBallot, (5_000_000, ROOT, record)),
                expected,
                v
            );
        }
        assertTrue(i >= 11, "every framing vector");
    }

    /// The fixed call keeps its own bound: a record the rolling call refuses
    /// for its root's word, but within `MAX_RELAY_RECORD`, still relays as a
    /// fixed call.
    function test_TheFixedCallKeepsItsBound() public {
        string memory v = _framingVector("max-relay-record");
        bytes memory record = _record(v);
        assertEq(record.length, relay.MAX_RELAY_RECORD(), "the fixed call's longest");
        relay.relayBallot(5_000_000, record);
        assertEq(relay.callCount(), 1, "recorded");
    }

    /// Each calldata vector: canonical calldata reaches the framing (which
    /// refuses the empty record); the rest are refused, by the relay's
    /// calldata check or, where Solidity's decoder finds the fault first (a
    /// word above 2⁶⁴, a length past the end, another selector), by the
    /// decoder's empty revert, recording nothing.
    function test_CalldataVectors() public {
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".calldata", i, "")); i++) {
            string memory v = _at(".calldata", i, "");
            bytes memory data = _bytes(string.concat(v, ".calldata"));
            if (_eq(_str(string.concat(v, ".result")), "canonical")) {
                bytes memory record = _bytes(string.concat(v, ".record"));
                assertTrue(
                    keccak256(data)
                        == keccak256(
                            abi.encodeCall(
                                BallotRelay.relayRollingBallot,
                                (
                                    uint64(vm.parseUint(_str(string.concat(v, ".gasLimit")))),
                                    _b32(string.concat(v, ".root")),
                                    record
                                )
                            )
                        ),
                    "the ABI encoding"
                );
                (bool ok, bytes memory refusal) = address(relay).call(data);
                if (record.length == 0) {
                    assertTrue(!ok, "the empty record");
                    assertTrue(
                        keccak256(refusal)
                            == keccak256(
                                abi.encodeWithSelector(BallotRelay.RelayTruncated.selector, 0)
                            ),
                        "refused by the framing"
                    );
                } else {
                    assertTrue(ok, string.concat(v, ": canonical calldata refused"));
                }
                continue;
            }
            bytes memory ret = _refusal(data, v);
            assertTrue(
                ret.length == 0
                    || keccak256(ret)
                        == keccak256(
                            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector)
                        ),
                string.concat(v, ": refused with ", vm.toString(ret))
            );
        }
        assertTrue(i >= 18, "every calldata vector");
    }

    // --- the deposit ---------------------------------------------------------------

    /// A refused deposit reverts the whole call: nothing is recorded, so
    /// every recorded call made a deposit.
    function test_ARefusedDepositRecordsNothing() public {
        portal.setRefuse(true);
        _refusal(
            abi.encodeCall(BallotRelay.relayRollingBallot, (5_000_000, ROOT, _framed())),
            "refused deposit"
        );
        assertEq(relay.callHash(0), bytes32(0), "no word");
    }

    /// A call re-entering through the portal records a call of its own after
    /// this one: the outer call's word and event were written first.
    function test_ReentryRecordsTheNextCall() public {
        bytes memory inner = bytes.concat(_framed(), hex"01");
        portal.setReenter(inner);
        vm.recordLogs();
        uint64 index = relay.relayRollingBallot(5_000_000, ROOT, _framed());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(index, 0, "the outer call is call 0");
        assertEq(relay.callCount(), 2, "two calls");
        assertEq(logs.length, 2, "two events");
        assertEq(logs[0].topics[2], bytes32(0), "call 0's event first");
        assertEq(logs[1].topics[2], bytes32(uint256(1)), "then call 1's");
        assertEq(relay.callHash(0), _hashNow(0, 5_000_000, ROOT, _framed()), "call 0 rolling");
        assertEq(portal.depositCount(), 2, "two deposits");
    }

    /// The deposit data is exactly the board's canonical encoding of the
    /// relayed rolling call, the root carried unread whatever it is, and the
    /// word stored is the hash over every field, the root included.
    function testFuzz_DepositIsTheBoardsCall(uint64 gasLimit, bytes32 root, bytes calldata body)
        public
    {
        vm.assume(body.length <= 2000);
        bytes memory record = bytes.concat(hex"000205", keccak256(body), body);
        uint64 index = relay.relayRollingBallot(gasLimit, root, record);
        MockPortal.Deposit memory d = portal.deposit(0);
        assertTrue(
            keccak256(d.data)
                == keccak256(
                    abi.encodeWithSignature(
                        DEPOSIT,
                        index,
                        uint64(block.number),
                        uint64(block.timestamp),
                        gasLimit,
                        root,
                        record
                    )
                ),
            "deposit data"
        );
        assertEq(d.data.length, 228 + (record.length + 31) / 32 * 32, "length");
        assertEq(d.gasLimit, gasLimit, "gas limit");
        assertEq(relay.callHash(index), _hashNow(index, gasLimit, root, record), "the word");
    }

    /// The root is bound: the same record relayed with two different roots
    /// stores two different words, and neither is the fixed call's over the
    /// same fields, so a deposit carrying another root, or one made as a
    /// fixed call, matches no call (T-71).
    function testFuzz_TheRootIsBound(bytes32 a, bytes32 b) public {
        vm.assume(a != b);
        relay.relayRollingBallot(5_000_000, a, _framed());
        relay.relayRollingBallot(5_000_000, b, _framed());
        assertEq(relay.callHash(0), _hashNow(0, 5_000_000, a, _framed()), "call 0");
        assertEq(relay.callHash(1), _hashNow(1, 5_000_000, b, _framed()), "call 1");
        assertTrue(
            relay.callHash(1) != _hashNow(1, 5_000_000, a, _framed()), "call 1 binds its root"
        );
        assertTrue(
            relay.callHash(0)
                != harness.callHash(
                    uint64(block.chainid),
                    address(relay),
                    0,
                    uint64(block.number),
                    uint64(block.timestamp),
                    5_000_000,
                    _framed()
                ),
            "not the fixed call's"
        );
    }

    /// A record is recorded exactly when it is a ballot record's header or
    /// longer: no other type, and nothing shorter, reaches the portal.
    function testFuzz_OnlyBallotHeadersAreRecorded(bytes32 root, bytes calldata record) public {
        vm.assume(record.length <= 4000);
        (bool ok,) = address(relay)
            .call(abi.encodeCall(BallotRelay.relayRollingBallot, (5_000_000, root, record)));
        bool framed = record.length >= 35 && record[0] == 0x00 && record[1] == 0x02;
        assertTrue(ok == framed, "recorded exactly when framed");
        assertEq(relay.callCount(), framed ? 1 : 0, "count");
        assertEq(portal.depositCount(), framed ? 1 : 0, "deposits");
    }

    /// No calldata carries bytes its arguments don't define: a trailing
    /// word, dirty padding or the fixed call's offset is refused.
    function test_RefusesNonCanonicalCalldata() public {
        bytes memory good = abi.encodeCall(
            BallotRelay.relayRollingBallot, (5_000_000, ROOT, bytes.concat(_framed(), hex"01"))
        );
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _refuse(abi.encodePacked(good, bytes32(0)), refusal, "trailing word");
        bytes memory dirty = bytes.concat(good);
        dirty[dirty.length - 1] = 0x01;
        _refuse(dirty, refusal, "dirty padding");
        (bool ok,) = address(relay).call(good);
        assertTrue(ok, "canonical");
    }

    // --- personal data ------------------------------------------------------------

    /// The honest call carries no personal data: the v5-ballot vector's
    /// calldata, deposit data, event data and topics are fixed-size typed
    /// fields and a framed record, with no run of text. The relay reads no
    /// more of the record than its header, so text inside a record reaches
    /// the deposit, for the board to refuse (Board, Relayed rolling ballots;
    /// T-17), but never the relay's event, which holds the call's hash: the
    /// detector's positive control (contracts skill, No PII on-chain).
    function test_NoPersonalDataInCalldataOrEvents() public {
        string memory c = _at(".calls", 0, "");
        assertTrue(_eq(_str(string.concat(c, ".id")), "v5-ballot"), "the honest call");
        bytes32 root = _b32(string.concat(c, ".root"));
        bytes memory record = _record(c);
        bytes memory call =
            abi.encodeCall(BallotRelay.relayRollingBallot, (6_000_000, root, record));
        assertTrue(!_looksLikeText(call), "calldata");
        vm.recordLogs();
        (bool ok,) = address(relay).call(call);
        assertTrue(ok, "relayed");
        _assertNoText(vm.getRecordedLogs()[0]);
        assertTrue(!_looksLikeText(portal.deposit(0).data), "deposit data");

        bytes memory text = bytes.concat(
            bytes2(0x0002), bytes1(0x05), keccak256("definition"), "Jane Doe, jane.doe@example.com"
        );
        assertTrue(_looksLikeText(text), "detector misses the text");
        vm.recordLogs();
        relay.relayRollingBallot(6_000_000, bytes32("Jane Doe, jane.doe@example"), text);
        _assertNoText(vm.getRecordedLogs()[0]);
    }

    function _assertNoText(Vm.Log memory log) internal pure {
        assertTrue(!_looksLikeText(log.data), "event data");
        for (uint256 t; t < log.topics.length; t++) {
            assertTrue(!_looksLikeText(abi.encode(log.topics[t])), "event topic");
        }
    }

    /// As Board.t.sol's: a run of 12 printable bytes, or an at sign flanked by
    /// two printable bytes on each side (an e-mail address).
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

    // --- helpers -----------------------------------------------------------------

    /// A fresh relay's code at the call's relay address, on its L1 chain, at
    /// its block and time, with `index` calls recorded before and its
    /// accumulator at its genesis there.
    function _relayAt(string memory c, uint64 index) internal returns (BallotRelay r) {
        vm.chainId(vm.parseUint(_str(string.concat(c, ".l1ChainId"))));
        address at = address(bytes20(_bytes(string.concat(c, ".relay"))));
        vm.etch(at, address(relay).code);
        r = BallotRelay(at);
        vm.store(at, SLOT, bytes32(uint256(index)));
        vm.store(at, ACCUMULATOR_SLOT, EventAccumulatorLib.genesis(uint64(block.chainid), at));
        vm.roll(vm.parseUint(_str(string.concat(c, ".l1Block"))));
        vm.warp(vm.parseUint(_str(string.concat(c, ".l1Timestamp"))));
    }

    function _assertLog(Vm.Log memory log, string memory c) internal view {
        string[] memory topics = vm.parseJsonStringArray(json, string.concat(c, ".topics"));
        assertEq(log.topics.length, topics.length, "topic count");
        for (uint256 t; t < topics.length; t++) {
            assertEq(log.topics[t], bytes32(vm.parseBytes(topics[t])), "topic");
        }
        assertTrue(keccak256(log.data) == keccak256(_bytes(string.concat(c, ".data"))), "data");
    }

    function _rollingHashOf(string memory c, bytes memory record) internal view returns (bytes32) {
        return harness.rollingCallHash(
            uint64(vm.parseUint(_str(string.concat(c, ".l1ChainId")))),
            address(bytes20(_bytes(string.concat(c, ".relay")))),
            uint64(vm.parseUint(_str(string.concat(c, ".index")))),
            uint64(vm.parseUint(_str(string.concat(c, ".l1Block")))),
            uint64(vm.parseUint(_str(string.concat(c, ".l1Timestamp")))),
            _gasLimit(c),
            _b32(string.concat(c, ".root")),
            record
        );
    }

    function _fixedHashOf(string memory c, bytes memory record) internal view returns (bytes32) {
        return harness.callHash(
            uint64(vm.parseUint(_str(string.concat(c, ".l1ChainId")))),
            address(bytes20(_bytes(string.concat(c, ".relay")))),
            uint64(vm.parseUint(_str(string.concat(c, ".index")))),
            uint64(vm.parseUint(_str(string.concat(c, ".l1Block")))),
            uint64(vm.parseUint(_str(string.concat(c, ".l1Timestamp")))),
            _gasLimit(c),
            record
        );
    }

    /// The rolling call hash of call `index` made by `relay` now.
    function _hashNow(uint64 index, uint64 gasLimit, bytes32 root, bytes memory record)
        internal
        view
        returns (bytes32)
    {
        return harness.rollingCallHash(
            uint64(block.chainid),
            address(relay),
            index,
            uint64(block.number),
            uint64(block.timestamp),
            gasLimit,
            root,
            record
        );
    }

    function _gasLimit(string memory c) internal view returns (uint64) {
        return uint64(vm.parseUint(_str(string.concat(c, ".gasLimit"))));
    }

    /// A framed record: a version-5 ballot header and nothing else.
    function _framed() internal pure returns (bytes memory) {
        return bytes.concat(hex"000205", keccak256("definition"));
    }

    /// The vector's record: `record`, or `recordPrefix` followed by the first
    /// `recordLength − len(recordPrefix)` bytes of `SHA-256(recordFill ‖
    /// "/0") ‖ SHA-256(recordFill ‖ "/1") ‖ …` (vectors README).
    function _record(string memory v) internal view returns (bytes memory out) {
        if (vm.keyExistsJson(json, string.concat(v, ".record"))) {
            return _bytes(string.concat(v, ".record"));
        }
        bytes memory prefix = _bytes(string.concat(v, ".recordPrefix"));
        uint256 len = vm.parseJsonUint(json, string.concat(v, ".recordLength"));
        bytes memory label = bytes(_str(string.concat(v, ".recordFill")));
        out = new bytes(len);
        for (uint256 i; i < prefix.length; i++) {
            out[i] = prefix[i];
        }
        bytes32 block_;
        for (uint256 i = prefix.length; i < len; i++) {
            uint256 k = i - prefix.length;
            if (k % 32 == 0) {
                block_ = sha256(bytes.concat(label, "/", bytes(vm.toString(k / 32))));
            }
            out[i] = block_[k % 32];
        }
    }

    function _framingVector(string memory id) internal view returns (string memory) {
        for (uint256 i; vm.keyExistsJson(json, _at(".framing", i, "")); i++) {
            if (_eq(_str(_at(".framing", i, ".id")), id)) return _at(".framing", i, "");
        }
        revert(string.concat("no framing vector ", id));
    }

    function _refuse(bytes memory data, bytes memory expected, string memory what) internal {
        bytes memory ret = _refusal(data, what);
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
    }

    /// Runs `data`, which the relay must refuse, recording and depositing
    /// nothing.
    function _refusal(bytes memory data, string memory what) internal returns (bytes memory ret) {
        uint64 count = relay.callCount();
        uint256 deposits = portal.depositCount();
        bool ok;
        (ok, ret) = address(relay).call(data);
        assertTrue(!ok, string.concat(what, ": accepted"));
        assertEq(relay.callCount(), count, what);
        assertEq(portal.depositCount(), deposits, what);
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory key) internal view returns (bytes memory) {
        string memory hexString = _str(key);
        // Foundry won't parse an empty string as bytes.
        return bytes(hexString).length == 0 ? bytes("") : vm.parseBytes(hexString);
    }

    function _b32(string memory key) internal view returns (bytes32) {
        bytes memory b = _bytes(key);
        require(b.length == 32, string.concat("not 32 bytes: ", key));
        return bytes32(b);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
