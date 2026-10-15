// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotRelay, IOptimismPortal, RelayCallLib} from "../src/BallotRelay.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The portal as the relay calls it: records each deposit, and can be set to
/// refuse one or to re-enter the relay from inside it.
contract MockPortal is IOptimismPortal {
    struct Deposit {
        address to;
        uint256 value;
        uint64 gasLimit;
        bool isCreation;
        bytes data;
    }

    Deposit[] internal _deposits;
    bool public refuse;
    /// A record to relay again from inside the next deposit, if non-empty.
    bytes public reenter;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function setReenter(bytes calldata record) external {
        reenter = record;
    }

    function depositTransaction(
        address to,
        uint256 value,
        uint64 gasLimit,
        bool isCreation,
        bytes memory data
    ) external payable {
        require(!refuse, "deposit refused");
        _deposits.push(Deposit(to, value, gasLimit, isCreation, data));
        if (reenter.length != 0) {
            bytes memory r = reenter;
            delete reenter;
            BallotRelay(msg.sender).relayBallot(gasLimit, r);
        }
    }

    function depositCount() external view returns (uint256) {
        return _deposits.length;
    }

    function deposit(uint256 i) external view returns (Deposit memory) {
        return _deposits[i];
    }
}

/// Exposes the call hash to tests.
contract RelayHarness {
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
}

/// The L1 relay (docs/spec/contracts.md, L1 relay) against relay.json: its
/// selectors and event, its storage slots, every call's hash, event and
/// deposit data, recorded at the vector's own address, chain, block and
/// time, the framing and calldata verdicts, and the event accumulator over
/// three calls. Every expected value comes from the file or the spec, never
/// from the code under test. Threats: T-50 (censorship of direct
/// submission), T-71 (a forged deposit), T-35 and T-45 (the stamp), T-17
/// (chosen bytes) and T-52 (oversized input).
contract BallotRelayTest is TestBase {
    string internal constant RELAY_VECTORS = "../../docs/spec/vectors/relay.json";
    address internal constant BOARD = address(0xB0A4D);

    /// The spec's values (contracts.md, L1 relay).
    bytes32 internal constant BALLOT_RELAYED = keccak256("BallotRelayed(bytes32,uint64,bytes32)");
    bytes32 internal constant SLOT =
        0xeddbfcaa40c756990a5dda7c565d5921d82a1a88a4b83bd8b0415aeae8667900;
    bytes32 internal constant ACCUMULATOR_SLOT =
        0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;

    MockPortal internal portal;
    BallotRelay internal relay;
    RelayHarness internal harness;
    string internal json;

    function setUp() public {
        json = vm.readFile(RELAY_VECTORS);
        portal = new MockPortal();
        relay = new BallotRelay(address(portal), BOARD);
        harness = new RelayHarness();
    }

    function test_VectorFileFormat() public view {
        assertTrue(_eq(_str(".format"), "abolish-relay-vectors/1"), "format");
        assertEq(vm.parseJsonUint(json, ".maxRelayRecord"), relay.MAX_RELAY_RECORD(), "max");
        // The largest record's deposit data, 196 bytes and the record padded
        // to whole words, fits the portal's cap, and one more word wouldn't.
        uint256 max = relay.MAX_RELAY_RECORD();
        uint256 cap = vm.parseJsonUint(json, ".portalMaxData");
        assertEq(max % 32, 0, "a whole number of words");
        assertTrue(196 + max <= cap && 196 + max + 32 > cap, "the longest that fits");
    }

    /// The selectors, the event's topic 0 and the storage slots are the
    /// file's: the relay's call, the board's relayed-ballot call, and the
    /// ERC-7201 namespace's count and call words.
    function test_SignaturesAndSlotsAreTheFiles() public view {
        assertTrue(
            bytes4(_bytes(".signatures.relay.selector")) == BallotRelay.relayBallot.selector,
            "relay selector"
        );
        assertTrue(
            bytes4(_bytes(".signatures.deposit.selector"))
                == bytes4(keccak256("submitRelayedBallot(uint64,uint64,uint64,uint64,bytes)")),
            "deposit selector"
        );
        assertEq(_b32(".signatures.event.topic0"), BALLOT_RELAYED, "topic 0");
        assertEq(BallotRelay.BallotRelayed.selector, BALLOT_RELAYED, "the contract's event");
        assertEq(_b32(".storage.base"), SLOT, "namespace");
        assertEq(
            keccak256(abi.encode(uint256(keccak256(bytes(_str(".storage.namespace")))) - 1))
                & ~bytes32(uint256(0xff)),
            SLOT,
            "ERC-7201 slot"
        );
        assertEq(_b32(".storage.countSlot"), SLOT, "count slot");
        assertEq(_b32(".storage.callsSlot"), bytes32(uint256(SLOT) + 1), "calls slot");
        for (uint256 i; vm.keyExistsJson(json, _at(".storage.callSlots", i, "")); i++) {
            uint256 index = vm.parseUint(_str(_at(".storage.callSlots", i, ".index")));
            assertEq(
                keccak256(abi.encode(index, uint256(SLOT) + 1)),
                _b32(_at(".storage.callSlots", i, ".slot")),
                "call slot"
            );
        }
    }

    // --- deployment ------------------------------------------------------------

    function test_DeploymentRefusesAPortalWithoutCodeOrAZeroBoard() public {
        vm.expectRevert(abi.encodeWithSelector(BallotRelay.InvalidDeployment.selector));
        new BallotRelay(address(0x1234), BOARD);
        vm.expectRevert(abi.encodeWithSelector(BallotRelay.InvalidDeployment.selector));
        new BallotRelay(address(0), BOARD);
        vm.expectRevert(abi.encodeWithSelector(BallotRelay.InvalidDeployment.selector));
        new BallotRelay(address(portal), address(0));
    }

    function test_DeploymentPinsThePortalAndTheBoard() public view {
        assertTrue(address(relay.portal()) == address(portal), "portal");
        assertTrue(relay.board() == BOARD, "board");
        assertEq(relay.callCount(), 0, "no call");
        (bytes32 acc, uint64 count) = relay.eventAccumulator();
        assertEq(count, 0, "no log");
        assertEq(acc, EventAccumulatorLib.genesis(uint64(block.chainid), address(relay)), "genesis");
    }

    // --- calls -------------------------------------------------------------------

    /// Every call of the file at its own relay address, L1 chain, index,
    /// block and stamp: the returned index, the word stored for it, the
    /// count, the event's topics and data, and the deposit's target, value,
    /// gas limit and data are the file's.
    function test_CallVectors() public {
        uint256 n;
        for (; vm.keyExistsJson(json, _at(".calls", n, "")); n++) {
            string memory c = _at(".calls", n, "");
            uint64 index = uint64(vm.parseUint(_str(string.concat(c, ".index"))));
            bytes memory record = _record(c);
            // Call 2⁶⁴ − 1 can't be recorded (its count would be 2⁶⁴), so
            // only its hash is checked; the refusal has its own test.
            if (index == type(uint64).max) {
                assertEq(_hashOf(c, record), _b32(string.concat(c, ".callHash")), "call hash");
                continue;
            }
            BallotRelay r = _relayAt(c, index);
            uint256 deposits = portal.depositCount();
            vm.recordLogs();
            uint64 got = r.relayBallot(_gasLimit(c), record);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(got, index, "index");
            assertEq(r.callHash(index), _b32(string.concat(c, ".callHash")), "stored call hash");
            assertEq(_hashOf(c, record), _b32(string.concat(c, ".callHash")), "the library's");
            assertEq(r.callCount(), uint256(index) + 1, "count");
            assertEq(
                vm.load(address(r), keccak256(abi.encode(uint256(index), uint256(SLOT) + 1))),
                _b32(string.concat(c, ".callHash")),
                "the word at the call's slot"
            );
            assertEq(vm.load(address(r), SLOT), bytes32(uint256(index) + 1), "the count word");
            assertEq(logs.length, 1, "one log");
            assertTrue(logs[0].emitter == address(r), "emitter");
            string[] memory topics = vm.parseJsonStringArray(json, string.concat(c, ".topics"));
            assertEq(logs[0].topics.length, topics.length, "topic count");
            for (uint256 t; t < topics.length; t++) {
                assertEq(logs[0].topics[t], bytes32(vm.parseBytes(topics[t])), "topic");
            }
            assertTrue(
                keccak256(logs[0].data) == keccak256(_bytes(string.concat(c, ".data"))), "data"
            );
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
        assertTrue(n >= 10, "every call");
    }

    /// The relay's accumulator over the file's three calls, from its genesis
    /// at the file's address and chain.
    function test_AccumulatorVectors() public {
        vm.chainId(vm.parseUint(_str(".accumulator.chainId")));
        address at = address(bytes20(_bytes(".accumulator.address")));
        vm.etch(at, address(relay).code);
        BallotRelay r = BallotRelay(at);
        bytes32 genesis = _b32(".accumulator.genesis");
        assertEq(EventAccumulatorLib.genesis(uint64(block.chainid), at), genesis, "genesis");
        vm.store(at, ACCUMULATOR_SLOT, genesis);
        for (uint256 i; vm.keyExistsJson(json, _at(".accumulator.steps", i, "")); i++) {
            string memory step = _at(".accumulator.steps", i, "");
            assertEq(vm.parseJsonUint(json, string.concat(step, ".n")), i, "steps in order");
            string memory c = _call(_str(string.concat(step, ".call")));
            assertEq(vm.parseUint(_str(string.concat(c, ".index"))), i, "the call's index");
            vm.roll(vm.parseUint(_str(string.concat(c, ".l1Block"))));
            vm.warp(vm.parseUint(_str(string.concat(c, ".l1Timestamp"))));
            r.relayBallot(_gasLimit(c), _record(c));
            (bytes32 acc, uint64 count) = r.eventAccumulator();
            assertEq(count, i + 1, "count");
            assertEq(acc, _b32(string.concat(step, ".accumulator")), "accumulator");
        }
    }

    /// Call 2⁶⁴ − 1 is refused (checked arithmetic), recording nothing.
    function test_TheLastIndexIsNeverRecorded() public {
        vm.store(address(relay), SLOT, bytes32(uint256(type(uint64).max)));
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        relay.relayBallot(5_000_000, _framed());
        assertEq(relay.callHash(type(uint64).max), bytes32(0), "nothing recorded");
        assertEq(portal.depositCount(), 0, "no deposit");
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
                relay.relayBallot(5_000_000, record);
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
            _refuse(abi.encodeCall(BallotRelay.relayBallot, (5_000_000, record)), expected, v);
        }
        assertTrue(i >= 12, "every framing vector");
    }

    /// Each calldata vector: canonical calldata reaches the framing (which
    /// refuses the empty record); the rest are refused, by the relay's
    /// calldata check or, where Solidity's decoder finds the fault first (a
    /// word above 2⁶⁴, a length past the end, another selector), by the
    /// decoder's empty revert.
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
                                BallotRelay.relayBallot,
                                (uint64(vm.parseUint(_str(string.concat(v, ".gasLimit")))), record)
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
        _refusal(abi.encodeCall(BallotRelay.relayBallot, (5_000_000, _framed())), "refused deposit");
        assertEq(relay.callCount(), 0, "no call");
        assertEq(relay.callHash(0), bytes32(0), "no word");
    }

    /// A call re-entering through the portal records a call of its own after
    /// this one: the outer call's word and event were written first.
    function test_ReentryRecordsTheNextCall() public {
        bytes memory inner = bytes.concat(_framed(), hex"01");
        portal.setReenter(inner);
        vm.recordLogs();
        uint64 index = relay.relayBallot(5_000_000, _framed());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(index, 0, "the outer call is call 0");
        assertEq(relay.callCount(), 2, "two calls");
        assertEq(logs.length, 2, "two events");
        assertEq(logs[0].topics[2], bytes32(0), "call 0's event first");
        assertEq(logs[1].topics[2], bytes32(uint256(1)), "then call 1's");
        assertEq(
            relay.callHash(1),
            harness.callHash(
                uint64(block.chainid),
                address(relay),
                1,
                uint64(block.number),
                uint64(block.timestamp),
                5_000_000,
                inner
            ),
            "call 1 is the inner record"
        );
        assertEq(portal.depositCount(), 2, "two deposits");
    }

    /// The deposit data is exactly the board's canonical encoding of the call.
    function testFuzz_DepositIsTheBoardsCall(uint64 gasLimit, bytes calldata body) public {
        vm.assume(body.length <= 2000);
        bytes memory record = bytes.concat(hex"000201", keccak256(body), body);
        uint64 index = relay.relayBallot(gasLimit, record);
        MockPortal.Deposit memory d = portal.deposit(0);
        assertTrue(
            keccak256(d.data)
                == keccak256(
                    abi.encodeWithSignature(
                        "submitRelayedBallot(uint64,uint64,uint64,uint64,bytes)",
                        index,
                        uint64(block.number),
                        uint64(block.timestamp),
                        gasLimit,
                        record
                    )
                ),
            "deposit data"
        );
        assertEq(d.data.length, 196 + (record.length + 31) / 32 * 32, "length");
        assertEq(d.gasLimit, gasLimit, "gas limit");
    }

    /// A record is recorded exactly when it is a ballot record's header or
    /// longer: no other type, and nothing shorter, reaches the portal.
    function testFuzz_OnlyBallotHeadersAreRecorded(bytes calldata record) public {
        vm.assume(record.length <= 4000);
        (bool ok,) =
            address(relay).call(abi.encodeCall(BallotRelay.relayBallot, (5_000_000, record)));
        bool framed = record.length >= 35 && record[0] == 0x00 && record[1] == 0x02;
        assertTrue(ok == framed, "recorded exactly when framed");
        assertEq(relay.callCount(), framed ? 1 : 0, "count");
        assertEq(portal.depositCount(), framed ? 1 : 0, "deposits");
    }

    /// No calldata carries bytes its arguments don't define: a trailing
    /// word, dirty padding or a moved offset is refused.
    function test_RefusesNonCanonicalCalldata() public {
        bytes memory good =
            abi.encodeCall(BallotRelay.relayBallot, (5_000_000, bytes.concat(_framed(), hex"01")));
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _refuse(abi.encodePacked(good, bytes32(0)), refusal, "trailing word");
        bytes memory dirty = bytes.concat(good);
        dirty[dirty.length - 1] = 0x01;
        _refuse(dirty, refusal, "dirty padding");
        (bool ok,) = address(relay).call(good);
        assertTrue(ok, "canonical");
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

    function _hashOf(string memory c, bytes memory record) internal view returns (bytes32) {
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

    function _gasLimit(string memory c) internal view returns (uint64) {
        return uint64(vm.parseUint(_str(string.concat(c, ".gasLimit"))));
    }

    /// A framed record: a ballot header and nothing else.
    function _framed() internal pure returns (bytes memory) {
        return bytes.concat(hex"000201", keccak256("definition"));
    }

    /// The vector's record: `record`, or `recordPrefix` followed by the first
    /// `recordLength − 35` bytes of `SHA-256(recordFill ‖ "/0") ‖
    /// SHA-256(recordFill ‖ "/1") ‖ …` (vectors README).
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

    function _call(string memory id) internal view returns (string memory) {
        for (uint256 i; vm.keyExistsJson(json, _at(".calls", i, "")); i++) {
            if (_eq(_str(_at(".calls", i, ".id")), id)) return _at(".calls", i, "");
        }
        revert(string.concat("no call ", id));
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
