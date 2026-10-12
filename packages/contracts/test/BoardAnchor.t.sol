// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BoardAnchor, CheckpointLib} from "../src/BoardAnchor.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// Stands in for the anchoring authority's Safe: the anchor only needs the
/// authority to have code, and the tests act as it with `prank`.
contract AuthorityStub {}

/// Exposes the checkpoint hash for the vector tests.
contract CheckpointHarness {
    function hash(bytes32 electionId, uint32 segment, uint64 size, bytes32 head, bytes32 root)
        external
        pure
        returns (bytes32)
    {
        return CheckpointLib.hash(electionId, segment, size, head, root);
    }
}

/// The board anchor of docs/spec/contracts.md (Board anchor): the checkpoint
/// hash against docs/spec/vectors/board.json, which an independent Python
/// implementation produced, and each refusal with a test that a checkpoint
/// breaking only that rule is refused (T-23, T-24, T-52, T-53).
contract BoardAnchorTest is TestBase {
    string internal constant VECTORS = "../../docs/spec/vectors/board.json";
    string internal constant DEFINITION_V4_VECTORS =
        "../../docs/spec/vectors/election-definition-v4.json";
    /// The clock of board.json, so its anchors' times mean the same here.
    uint64 internal constant EPOCH = 1_800_000_000;
    uint64 internal constant PERIOD = 3600;
    uint64 internal constant DEADLINE = 7200;
    bytes32 internal constant ID = keccak256("election");

    address internal authority;
    BoardAnchor internal anchor;
    CheckpointHarness internal lib;

    function setUp() public {
        authority = address(new AuthorityStub());
        anchor = new BoardAnchor(BoardAnchor.Clock(EPOCH, PERIOD, DEADLINE), authority);
        lib = new CheckpointHarness();
    }

    // --- vectors -------------------------------------------------------------

    function test_VectorClockIsTheTestClock() public view {
        string memory json = vm.readFile(VECTORS);
        assertEq(vm.parseUint(vm.parseJsonString(json, ".clock.epoch")), EPOCH, "epoch");
        assertEq(vm.parseUint(vm.parseJsonString(json, ".clock.period")), PERIOD, "period");
        assertEq(vm.parseUint(vm.parseJsonString(json, ".clock.deadline")), DEADLINE, "deadline");
    }

    /// Every checkpoint in board.json hashes to its published `hash`.
    function test_CheckpointHashVectors() public view {
        string memory json = vm.readFile(VECTORS);
        uint256 seen;
        for (uint256 i; vm.keyExistsJson(json, _board(i)); i++) {
            for (uint256 j; vm.keyExistsJson(json, _checkpoint(i, j)); j++) {
                string memory c = _checkpoint(i, j);
                (bytes32 id, uint32 s, uint64 size, bytes32 head, bytes32 root) =
                    _parseCheckpoint(json, c);
                assertEq(
                    lib.hash(id, s, size, head, root), _bytes32(json, string.concat(c, ".hash")), c
                );
                seen++;
            }
        }
        assertTrue(seen > 50, "too few checkpoint vectors");
    }

    /// The "valid" board's anchors, each sent at its vector time, are all
    /// accepted, and the anchor then holds exactly their hashes.
    function test_AnchorsTheValidBoardAtItsVectorTimes() public {
        string memory json = vm.readFile(VECTORS);
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".boards[0].id"))) == keccak256("valid"),
            "board 0 is not the valid board"
        );
        uint256 j;
        for (; vm.keyExistsJson(json, _checkpoint(0, j)); j++) {
            string memory c = _checkpoint(0, j);
            (bytes32 id, uint32 s, uint64 size, bytes32 head, bytes32 root) =
                _parseCheckpoint(json, c);
            vm.warp(vm.parseUint(vm.parseJsonString(json, string.concat(c, ".anchoredAt"))));
            vm.prank(authority);
            anchor.anchor(abi.encodePacked(id, s, size, head, root), "");
            assertEq(anchor.checkpointHashOf(id, s), _bytes32(json, string.concat(c, ".hash")), c);
        }
        assertTrue(j >= 4, "valid board has too few anchors");
    }

    // --- deployment ----------------------------------------------------------

    function test_DeploymentKeepsTheClockAndAuthority() public view {
        assertEq(anchor.epoch(), EPOCH, "epoch");
        assertEq(anchor.period(), PERIOD, "period");
        assertEq(anchor.deadline(), DEADLINE, "deadline");
        assertTrue(anchor.authority() == authority, "authority");
        assertEq(anchor.periodEnd(0), EPOCH + PERIOD, "period 0 end");
        assertEq(anchor.periodEnd(type(uint32).max), EPOCH + (uint256(1) << 32) * PERIOD, "last");
    }

    function test_DeploymentRefusesAZeroPeriod() public {
        try new BoardAnchor(BoardAnchor.Clock(EPOCH, 0, DEADLINE), authority) {
            revert("deployed");
        } catch (bytes memory ret) {
            _assertData(ret, abi.encodeWithSelector(BoardAnchor.InvalidDeployment.selector));
        }
    }

    /// T-53, T-69: a single key as the authority is refused outright.
    function test_DeploymentRefusesAnAuthorityWithoutCode() public {
        address[2] memory keys = [address(0), address(0xA11CE)];
        for (uint256 i; i < 2; i++) {
            try new BoardAnchor(BoardAnchor.Clock(EPOCH, PERIOD, DEADLINE), keys[i]) {
                revert("deployed");
            } catch (bytes memory ret) {
                _assertData(ret, abi.encodeWithSelector(BoardAnchor.InvalidDeployment.selector));
            }
        }
    }

    /// An EOA with an EIP-7702 delegation has code, but it is still one key.
    function test_DeploymentRefusesADelegatedEoa() public {
        address eoa = address(0x7702);
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(authority)));
        try new BoardAnchor(BoardAnchor.Clock(EPOCH, PERIOD, DEADLINE), eoa) {
            revert("deployed");
        } catch (bytes memory ret) {
            _assertData(ret, abi.encodeWithSelector(BoardAnchor.InvalidDeployment.selector));
        }
        // Code of the same length that isn't a delegation is a contract.
        vm.etch(eoa, abi.encodePacked(hex"5f0100", address(authority)));
        new BoardAnchor(BoardAnchor.Clock(EPOCH, PERIOD, DEADLINE), eoa);
    }

    // --- anchoring -----------------------------------------------------------

    function test_AnchorStoresTheHashAndLogsTheFullCheckpoint() public {
        vm.warp(EPOCH + 3 * PERIOD);
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor(_encode(ID, 2, 5, bytes32("head"), bytes32("root")), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 h = lib.hash(ID, 2, 5, bytes32("head"), bytes32("root"));
        assertEq(anchor.checkpointHashOf(ID, 2), h, "stored hash");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 4, "topics");
        assertEq(logs[0].topics[0], BoardAnchor.CheckpointAnchored.selector, "topic 0");
        assertEq(logs[0].topics[1], ID, "election topic");
        assertEq(logs[0].topics[2], bytes32(uint256(2)), "segment topic");
        assertEq(logs[0].topics[3], h, "hash topic");
        assertTrue(
            keccak256(logs[0].data)
                == keccak256(abi.encode(uint64(5), bytes32("head"), bytes32("root"))),
            "data"
        );
        _assertAccumulated(logs);
    }

    /// The hash sits at the documented slot, so a verifier can prove it with
    /// `eth_getProof` and never trust a call (docs/spec/contracts.md).
    function test_HashIsAtTheDocumentedSlot() public {
        assertEq(
            bytes32(
                uint256(keccak256(abi.encode(uint256(keccak256("abolish.board-anchor")) - 1)))
                    & ~uint256(0xff)
            ),
            0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00,
            "namespace"
        );
        vm.warp(EPOCH + 8 * PERIOD);
        vm.prank(authority);
        anchor.anchor(_encode(ID, 6, 1, bytes32("h"), bytes32("r")), "");
        assertEq(vm.load(address(anchor), _slot(ID, 6)), anchor.checkpointHashOf(ID, 6), "slot");
        assertTrue(vm.load(address(anchor), _slot(ID, 6)) != bytes32(0), "unset");
    }

    function test_AnchorsSeveralElectionsInOneCall() public {
        bytes32 other = keccak256("other");
        vm.warp(EPOCH + 2 * PERIOD);
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor(
            bytes.concat(
                _encode(ID, 0, 1, bytes32("a"), bytes32("b")),
                _encode(other, 0, 9, bytes32("c"), bytes32("d")),
                _encode(ID, 1, 3, bytes32("e"), bytes32("f"))
            ),
            ""
        );
        assertEq(vm.getRecordedLogs().length, 3, "logs");
        assertEq(anchor.checkpointHashOf(ID, 0), lib.hash(ID, 0, 1, "a", "b"), "first");
        assertEq(anchor.checkpointHashOf(other, 0), lib.hash(other, 0, 9, "c", "d"), "second");
        assertEq(anchor.checkpointHashOf(ID, 1), lib.hash(ID, 1, 3, "e", "f"), "third");
    }

    /// T-52: no one but the authority can anchor, so no one can front-run an
    /// election's checkpoint with a bogus one.
    function test_RefusesAnyoneButTheAuthority() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory cp = _encode(ID, 0, 1, "h", "r");
        address[3] memory callers = [address(this), address(0xA11CE), address(anchor)];
        for (uint256 i; i < 3; i++) {
            vm.prank(callers[i]);
            (bool ok, bytes memory ret) =
                address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (cp, bytes(""))));
            _assertRefused(
                ok, ret, abi.encodeWithSelector(BoardAnchor.NotAuthority.selector, callers[i])
            );
        }
        assertEq(anchor.checkpointHashOf(ID, 0), bytes32(0), "stored");
    }

    /// `checkpoint-size`: an empty board's checkpoint fails the election, so
    /// it is never stored.
    function test_RefusesAnEmptyBoard() public {
        vm.warp(EPOCH + PERIOD);
        _expectRefused(
            _encode(ID, 0, 0, bytes32(0), bytes32(0)),
            abi.encodeWithSelector(BoardAnchor.EmptyBoard.selector, ID, uint32(0))
        );
    }

    /// docs/spec/board.md, Timing: from the period's end to `deadline` after
    /// it, both ends included.
    function test_WindowBoundaries() public {
        uint256 end = EPOCH + 5 * PERIOD; // period 4
        vm.warp(end - 1);
        _expectRefused(
            _encode(ID, 4, 1, "h", "r"),
            abi.encodeWithSelector(BoardAnchor.PeriodNotOver.selector, uint32(4), end, end - 1)
        );
        vm.warp(end + DEADLINE + 1);
        _expectRefused(
            _encode(ID, 4, 1, "h", "r"),
            abi.encodeWithSelector(
                BoardAnchor.PastDeadline.selector, uint32(4), end, end + DEADLINE + 1
            )
        );
        vm.warp(end);
        vm.prank(authority);
        anchor.anchor(_encode(ID, 4, 1, "h", "r"), "");
        vm.warp(end + PERIOD + DEADLINE); // period 5's last second
        vm.prank(authority);
        anchor.anchor(_encode(ID, 5, 1, "h", "r"), "");
    }

    /// A segment before the epoch doesn't exist: any time before the epoch
    /// is before period 0's end.
    function test_RefusesEverythingBeforeTheEpochEnds() public {
        vm.warp(EPOCH);
        _expectRefused(
            _encode(ID, 0, 1, "h", "r"),
            abi.encodeWithSelector(
                BoardAnchor.PeriodNotOver.selector, uint32(0), EPOCH + PERIOD, EPOCH
            )
        );
    }

    /// T-24: a second checkpoint for an election and segment is refused,
    /// equal or not, and the first stays.
    function test_RefusesASecondCheckpointForASegment() public {
        vm.warp(EPOCH + PERIOD);
        vm.prank(authority);
        anchor.anchor(_encode(ID, 0, 2, "h", "r"), "");
        bytes32 first = anchor.checkpointHashOf(ID, 0);
        bytes memory refusal =
            abi.encodeWithSelector(BoardAnchor.AlreadyAnchored.selector, ID, uint32(0));
        _expectRefused(_encode(ID, 0, 2, "h", "r"), refusal);
        _expectRefused(_encode(ID, 0, 3, "h2", "r2"), refusal);
        // Twice in one call too.
        vm.warp(EPOCH + 2 * PERIOD);
        _expectRefused(
            bytes.concat(_encode(ID, 1, 1, "h", "r"), _encode(ID, 1, 2, "h", "r")),
            abi.encodeWithSelector(BoardAnchor.AlreadyAnchored.selector, ID, uint32(1))
        );
        assertEq(anchor.checkpointHashOf(ID, 0), first, "first changed");
        assertEq(anchor.checkpointHashOf(ID, 1), bytes32(0), "a refused call stored");
    }

    /// The lowest anchored segment is kept per election and only ever
    /// lowered, so a verifier knows where its slots start (T-24).
    function test_TracksTheLowestAnchoredSegment() public {
        assertEq(anchor.lowestSegmentPlusOne(ID), 0, "none yet");
        vm.warp(EPOCH + 3 * PERIOD); // periods 0 to 2 have ended, all in their windows
        vm.prank(authority);
        anchor.anchor(_encode(ID, 2, 1, "h", "r"), "");
        assertEq(anchor.lowestSegmentPlusOne(ID), 3, "first");
        vm.prank(authority);
        anchor.anchor(
            bytes.concat(_encode(keccak256("x"), 0, 2, "h", "r"), _encode(ID, 1, 1, "h", "r")), ""
        );
        assertEq(anchor.lowestSegmentPlusOne(ID), 2, "lowered");
        vm.prank(authority);
        anchor.anchor(_encode(ID, 0, 1, "h", "r"), "");
        assertEq(anchor.lowestSegmentPlusOne(ID), 1, "segment 0");
        assertEq(anchor.lowestSegmentPlusOne(keccak256("x")), 1, "another election");
        assertEq(anchor.lowestSegmentPlusOne(keccak256("y")), 0, "none");
        // At the documented slot: the second mapping of the namespace.
        bytes32 slot = keccak256(
            abi.encode(
                ID, uint256(0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00) + 1
            )
        );
        assertEq(uint256(vm.load(address(anchor), slot)), 1, "slot");
    }

    /// A call is all or nothing: one bad checkpoint anchors none of them.
    function test_OneBadCheckpointAnchorsNone() public {
        vm.warp(EPOCH + PERIOD);
        _expectRefused(
            bytes.concat(_encode(ID, 0, 1, "h", "r"), _encode(keccak256("x"), 0, 0, "", "")),
            abi.encodeWithSelector(BoardAnchor.EmptyBoard.selector, keccak256("x"), uint32(0))
        );
        assertEq(anchor.checkpointHashOf(ID, 0), bytes32(0), "stored");
        (, uint64 count) = anchor.eventAccumulator();
        assertEq(count, 0, "logged");
    }

    function test_RefusesLengthsThatAreNotWholeCheckpoints() public {
        vm.warp(EPOCH + PERIOD);
        uint256[4] memory lengths = [uint256(1), 107, 109, 215];
        for (uint256 i; i < 4; i++) {
            _expectRefused(
                new bytes(lengths[i]),
                abi.encodeWithSelector(BoardAnchor.MalformedCheckpoints.selector, lengths[i])
            );
        }
        _expectRefused("", abi.encodeWithSelector(BoardAnchor.EmptyCall.selector));
    }

    /// T-17: the calldata is exactly the ABI encoding of the two arguments,
    /// so no transaction to the anchor carries bytes no checkpoint or
    /// locator defines.
    function test_RefusesNonCanonicalCalldata() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory cp = _encode(ID, 0, 1, "h", "r");
        bytes memory loc = _locator(1, 32);
        bytes memory good = abi.encodeCall(BoardAnchor.anchor, (cp, loc));
        // Offsets in the head: 0x40, then 0x40 + 32 + 128 (108 bytes padded).
        assertEq(_word(good, 4), 0x40, "first offset");
        assertEq(_word(good, 36), 0x40 + 32 + 128, "second offset");
        bytes[] memory bad = new bytes[](6);
        bad[0] = bytes.concat(good, bytes32(0)); // a trailing word
        bad[1] = bytes.concat(good, hex"00"); // a trailing byte
        bad[2] = bytes.concat(good); // a copy: `good` must stay canonical
        bad[2][4 + 64 + 32 + 108] = 0x01; // dirty padding after the checkpoints
        bad[3] = bytes.concat(good);
        bad[3][good.length - 1] = 0x01; // dirty padding after the locator (34 bytes)
        // The tails swapped: the second offset points before the first.
        bad[4] = abi.encodePacked(
            BoardAnchor.anchor.selector,
            uint256(0x40 + 32 + 64),
            uint256(0x40),
            uint256(loc.length),
            loc,
            bytes30(0),
            uint256(cp.length),
            cp,
            bytes20(0)
        );
        // A junk word between the head and the first tail.
        bad[5] = abi.encodePacked(
            BoardAnchor.anchor.selector,
            uint256(0x60),
            uint256(0x60 + 32 + 128),
            uint256(0),
            uint256(cp.length),
            cp,
            bytes20(0),
            uint256(loc.length),
            loc,
            bytes30(0)
        );
        for (uint256 i; i < bad.length; i++) {
            vm.prank(authority);
            (bool ok, bytes memory ret) = address(anchor).call(bad[i]);
            _assertRefused(ok, ret, abi.encodeWithSelector(_nonCanonical()));
        }
        vm.prank(authority);
        (bool success,) = address(anchor).call(good);
        assertTrue(success, "canonical calldata refused");
    }

    /// The second offset can't point back into the first argument's data:
    /// here it points at the last word of eight checkpoints (whose last root
    /// is 34), so the locator's "length" is read from a root and 32 junk bytes
    /// trail the call at the canonical total length.
    function test_RefusesASecondArgumentInsideTheFirst() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory cps;
        for (uint256 i; i < 7; i++) {
            cps = bytes.concat(cps, _encode(bytes32(i), 0, 1, "h", "r"));
        }
        cps = bytes.concat(cps, _encode(bytes32(uint256(7)), 0, 1, "h", bytes32(uint256(34))));
        assertEq(cps.length, 864, "a whole number of words");
        bytes memory loc = _locator(1, 32);
        bytes memory call = abi.encodePacked(
            BoardAnchor.anchor.selector,
            uint256(0x40),
            uint256(0x40 + 32 + 864 - 32),
            uint256(cps.length),
            cps,
            loc,
            bytes30(0),
            bytes32("junk")
        );
        assertEq(call.length, 4 + 128 + 864 + 64, "the canonical total length");
        vm.prank(authority);
        (bool ok, bytes memory ret) = address(anchor).call(call);
        _assertRefused(ok, ret, abi.encodeWithSelector(_nonCanonical()));
    }

    // --- archive locator -------------------------------------------------------

    /// ADR 0005: each call can carry the locator of the latest confirmed
    /// archive manifest, logged after the checkpoints through the accumulator,
    /// so the archive is found from L1 alone (T-49, T-51).
    function test_LogsTheLocatorAfterTheCheckpoints() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory loc = _locator(1, 32);
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor(_encode(ID, 0, 1, "h", "r"), loc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "two logs");
        assertEq(logs[0].topics[0], BoardAnchor.CheckpointAnchored.selector, "checkpoint first");
        assertEq(logs[1].topics.length, 2, "locator topics");
        assertEq(logs[1].topics[0], BoardAnchor.ArchiveLocated.selector, "locator topic 0");
        assertEq(logs[1].topics[1], bytes32(uint256(1)), "version topic");
        assertTrue(keccak256(logs[1].data) == keccak256(abi.encode(loc)), "locator data");
        _assertAccumulated(logs);
    }

    /// A locator alone, with no checkpoint, at any time: the closing locator
    /// ADR 0005 asks for can wait for the archive to confirm without holding
    /// up the seal's checkpoint, whose deadline it doesn't share.
    function test_ALocatorAloneNeedsNoWindow() public {
        vm.warp(EPOCH + 1000 * PERIOD);
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor("", _locator(7, 3));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[1], bytes32(uint256(7)), "version");
        _assertAccumulated(logs);
    }

    /// The locator is framed but not interpreted: a version other than 0 and
    /// 1 to 126 body bytes, so the anchor fixes no storage scheme and the
    /// authority's chosen bytes on L1 stay bounded (T-17).
    function test_LocatorFraming() public {
        vm.warp(EPOCH + PERIOD);
        uint256[3] memory lengths = [uint256(1), 2, 129];
        for (uint256 i; i < 3; i++) {
            bytes memory loc = new bytes(lengths[i]);
            if (loc.length > 1) loc[1] = 0x01; // version 1
            _expectRefusedWith(
                "", loc, abi.encodeWithSelector(BoardAnchor.MalformedLocator.selector, lengths[i])
            );
        }
        _expectRefusedWith(
            "",
            _locator(0, 32),
            abi.encodeWithSelector(BoardAnchor.MalformedLocator.selector, uint256(34))
        );
        // A bad locator anchors no checkpoint either.
        _expectRefusedWith(
            _encode(ID, 0, 1, "h", "r"),
            _locator(0, 32),
            abi.encodeWithSelector(BoardAnchor.MalformedLocator.selector, uint256(34))
        );
        assertEq(anchor.checkpointHashOf(ID, 0), bytes32(0), "stored");
        vm.prank(authority);
        anchor.anchor("", _locator(1, 1));
        vm.prank(authority);
        anchor.anchor("", _locator(0xffff, 126));
    }

    /// The last locator and the count stay in state at the documented slots,
    /// so the archive is found from a storage proof after L1 history expiry.
    function test_KeepsTheLatestLocatorInState() public {
        (bytes memory none, uint256 zero) = anchor.latestLocator();
        assertEq(none.length + zero, 0, "nothing yet");
        vm.warp(EPOCH + PERIOD);
        vm.prank(authority);
        anchor.anchor(_encode(ID, 0, 1, "h", "r"), "");
        (none, zero) = anchor.latestLocator();
        assertEq(none.length + zero, 0, "a call without a locator keeps none");
        vm.prank(authority);
        anchor.anchor("", _locator(1, 32));
        bytes memory last = _locator(2, 100);
        vm.prank(authority);
        anchor.anchor("", last);
        (bytes memory got, uint256 count) = anchor.latestLocator();
        assertTrue(keccak256(got) == keccak256(last), "latest");
        assertEq(count, 2, "count");
        // Solidity's layout for a long `bytes` at slot A + 2: the slot holds
        // 2·len + 1, the data starts at keccak256(A + 2); the count is A + 3.
        uint256 base = uint256(0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00);
        assertEq(uint256(vm.load(address(anchor), bytes32(base + 2))), 2 * 102 + 1, "length");
        assertEq(uint256(vm.load(address(anchor), bytes32(base + 3))), 2, "count slot");
        bytes32 data = keccak256(abi.encode(base + 2));
        bytes memory fromSlots;
        for (uint256 i; i < 4; i++) {
            fromSlots =
                bytes.concat(fromSlots, vm.load(address(anchor), bytes32(uint256(data) + i)));
        }
        for (uint256 i; i < last.length; i++) {
            assertTrue(fromSlots[i] == last[i], "data");
        }
    }

    /// Any calldata the authority sends is accepted only if it is exactly
    /// the canonical encoding of the arguments it decodes to (T-17).
    function testFuzz_AcceptedCalldataIsCanonical(bytes calldata tail, uint8 cut, bool dirty)
        public
    {
        vm.warp(EPOCH + 2 * PERIOD);
        bytes memory good = abi.encodeCall(
            BoardAnchor.anchor, (_encode(keccak256(tail), 0, 1, "h", "r"), _locator(1, 32))
        );
        // Mutate a canonical call: truncate, append, or flip one byte.
        bytes memory call;
        if (dirty && good.length > 4) {
            call = bytes.concat(good);
            uint256 at = 4 + uint256(keccak256(tail)) % (good.length - 4);
            call[at] = bytes1(uint8(call[at]) ^ (1 + cut % 255));
        } else if (cut % 2 == 0) {
            call = bytes.concat(good, tail);
        } else {
            uint256 keep = good.length - cut % (good.length - 3);
            call = new bytes(keep);
            for (uint256 i; i < keep; i++) {
                call[i] = good[i];
            }
        }
        vm.prank(authority);
        (bool ok,) = address(anchor).call(call);
        if (!ok) return;
        (bytes memory a, bytes memory b) = this.decodeAnchorCall(call);
        assertTrue(
            keccak256(call) == keccak256(abi.encodeCall(BoardAnchor.anchor, (a, b))),
            "accepted a non-canonical call"
        );
    }

    function decodeAnchorCall(bytes calldata call)
        external
        pure
        returns (bytes memory, bytes memory)
    {
        return abi.decode(call[4:], (bytes, bytes));
    }

    /// Only the authority can post a locator, so no one can point verifiers
    /// at a fake archive (T-52).
    function test_RefusesALocatorFromAnyoneElse() public {
        vm.prank(address(0xA11CE));
        (bool ok, bytes memory ret) =
            address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (bytes(""), _locator(1, 32))));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(BoardAnchor.NotAuthority.selector, address(0xA11CE))
        );
    }

    /// No personal data on-chain (contracts skill, Rules): the calldata and
    /// the log of a real board's anchors are fixed-width numbers and hashes,
    /// and text appended to a checkpoint is refused. The authority choosing
    /// the bytes of a whole checkpoint is T-17's stated residual.
    function test_AnchorsCarryNoText() public {
        string memory json = vm.readFile(VECTORS);
        string memory c = _checkpoint(0, 0);
        (bytes32 id, uint32 s, uint64 size, bytes32 head, bytes32 root) = _parseCheckpoint(json, c);
        bytes memory cp = _encode(id, s, size, head, root);
        vm.warp(EPOCH + PERIOD);
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor(cp, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(!_looksLikeText(abi.encodeCall(BoardAnchor.anchor, (cp, bytes("")))), "calldata");
        assertEq(logs.length, 1, "one log");
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        for (uint256 t; t < logs[0].topics.length; t++) {
            assertTrue(!_looksLikeText(abi.encode(logs[0].topics[t])), "event topic");
        }

        bytes memory withText =
            bytes.concat(_encode(ID, 0, 1, "h", "r"), "Alice Smith, alice@example.com, P1234567");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        _expectRefused(
            withText,
            abi.encodeWithSelector(BoardAnchor.MalformedCheckpoints.selector, withText.length)
        );
    }

    /// A representative version-1 locator (a 32-byte Arweave transaction ID)
    /// passes the detector in calldata, log and storage. The body isn't
    /// interpreted, so text in it is accepted: the authority's chosen bytes
    /// are T-17's stated residual, and this test keeps that residual honest.
    function test_LocatorCarriesNoTextButCould() public {
        bytes memory loc = abi.encodePacked(uint16(1), sha256("arweave transaction"));
        vm.recordLogs();
        vm.prank(authority);
        anchor.anchor("", loc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(
            !_looksLikeText(abi.encodeCall(BoardAnchor.anchor, (bytes(""), loc))), "calldata"
        );
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        uint256 base = uint256(0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00);
        bytes32 data = keccak256(abi.encode(base + 2));
        bytes memory stored = bytes.concat(
            vm.load(address(anchor), bytes32(uint256(data))),
            vm.load(address(anchor), bytes32(uint256(data) + 1))
        );
        assertTrue(!_looksLikeText(stored), "storage");

        bytes memory text = abi.encodePacked(uint16(1), "Alice Smith, alice@example.com");
        assertTrue(_looksLikeText(text), "detector misses the text");
        vm.prank(authority);
        anchor.anchor("", text);
        (bytes memory got,) = anchor.latestLocator();
        assertTrue(keccak256(got) == keccak256(text), "text accepted (T-17 residual)");
    }

    // --- receipt keys --------------------------------------------------------

    /// Every writable record of the version-4 judging vectors (which an
    /// independent Python implementation produced) is what the anchor writes
    /// when the authority registers and retires a key at the vectors' times,
    /// read from the documented slot as a verifier proves it (T-26).
    function test_ReceiptKeyRecordsReplayTheJudgingVectors() public {
        string memory json = vm.readFile(DEFINITION_V4_VECTORS);
        uint256 replayed;
        uint256 impossible;
        for (uint256 i; vm.keyExistsJson(json, _judging(i)); i++) {
            string memory c = _judging(i);
            uint64 registeredAt = uint64(_uintString(json, string.concat(c, ".registeredAt")));
            uint64 retiredAt = uint64(_uintString(json, string.concat(c, ".retiredAt")));
            if (vm.keyExistsJson(json, string.concat(c, ".error"))) {
                // A retirement without a registration, or before it: at the
                // retirement's time the key isn't registered, so the anchor
                // refuses it. The other impossible records are writes after
                // the block they were read at, which only a false proof gives.
                if (retiredAt != 0 && (registeredAt == 0 || retiredAt < registeredAt)) {
                    setUp();
                    bytes memory never = _receiptKey(0x02, keccak256(bytes(c)));
                    vm.warp(retiredAt);
                    _expectReceiptKeyRefused(
                        BoardAnchor.retireReceiptKey.selector,
                        never,
                        abi.encodeWithSelector(
                            BoardAnchor.ReceiptKeyNotActive.selector, uint8(2), _x(never)
                        )
                    );
                    impossible++;
                }
                continue;
            }
            if (registeredAt == 0) continue;
            // A fresh anchor per case: block times only move forward.
            setUp();
            bytes memory key = _receiptKey(0x02, keccak256(bytes(c)));
            vm.warp(registeredAt);
            vm.prank(authority);
            anchor.registerReceiptKey(key);
            if (retiredAt != 0) {
                vm.warp(retiredAt);
                vm.prank(authority);
                anchor.retireReceiptKey(key);
            }
            assertEq(
                uint256(vm.load(address(anchor), _receiptKeySlot(key))),
                (uint256(retiredAt) << 64) | registeredAt,
                c
            );
            replayed++;
        }
        assertEq(replayed, 12, "writable judging vectors");
        assertEq(impossible, 2, "unwritable judging vectors");
    }

    /// Registration writes `registered_at` in the low 64 bits of the
    /// documented word, nothing else, and logs `x` and the prefix through the
    /// accumulator; the listed keys of the typical version-4 definition are
    /// accepted as they are encoded there.
    function test_RegisterStoresTheTimeAndLogs() public {
        string memory json = vm.readFile(DEFINITION_V4_VECTORS);
        bytes memory key =
            vm.parseBytes(vm.parseJsonString(json, ".vectors[0].value.receipt_keys[0]"));
        assertEq(key.length, 33, "vector key");
        vm.warp(EPOCH + 17);
        vm.recordLogs();
        vm.prank(authority);
        anchor.registerReceiptKey(key);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 2, "topics");
        assertEq(logs[0].topics[0], BoardAnchor.ReceiptKeyRegistered.selector, "topic 0");
        assertEq(logs[0].topics[1], _x(key), "x");
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(uint8(key[0]))), "prefix");
        _assertAccumulated(logs);
        assertEq(uint256(vm.load(address(anchor), _receiptKeySlot(key))), EPOCH + 17, "word");
        (uint64 registeredAt, uint64 retiredAt) = anchor.receiptKeyRecord(uint8(key[0]), _x(key));
        assertEq(registeredAt, EPOCH + 17, "registeredAt");
        assertEq(retiredAt, 0, "retiredAt");
    }

    /// Retirement writes `retired_at` in the next 64 bits, keeps
    /// `registered_at`, and logs through the accumulator.
    function test_RetireStoresTheTimeAndLogs() public {
        bytes memory key = _receiptKey(0x03, "k");
        vm.recordLogs();
        vm.warp(EPOCH);
        vm.prank(authority);
        anchor.registerReceiptKey(key);
        vm.warp(EPOCH + 3600);
        vm.prank(authority);
        anchor.retireReceiptKey(key);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "two logs");
        assertEq(logs[1].topics[0], BoardAnchor.ReceiptKeyRetired.selector, "topic 0");
        assertEq(logs[1].topics[1], _x(key), "x");
        assertTrue(keccak256(logs[1].data) == keccak256(abi.encode(uint8(3))), "prefix");
        _assertAccumulated(logs);
        assertEq(
            uint256(vm.load(address(anchor), _receiptKeySlot(key))),
            (uint256(EPOCH + 3600) << 64) | EPOCH,
            "word"
        );
    }

    /// Only the authority writes the record, so evidence under a key is
    /// attributable to it alone (T-26, T-52).
    function test_ReceiptKeysRefuseAnyoneButTheAuthority() public {
        bytes memory key = _receiptKey(0x02, "k");
        bytes memory notAuthority =
            abi.encodeWithSelector(BoardAnchor.NotAuthority.selector, address(0xA11CE));
        vm.prank(address(0xA11CE));
        (bool ok, bytes memory ret) =
            address(anchor).call(abi.encodeCall(BoardAnchor.registerReceiptKey, (key)));
        _assertRefused(ok, ret, notAuthority);
        vm.prank(authority);
        anchor.registerReceiptKey(key);
        vm.prank(address(0xA11CE));
        (ok, ret) = address(anchor).call(abi.encodeCall(BoardAnchor.retireReceiptKey, (key)));
        _assertRefused(ok, ret, notAuthority);
        (, uint64 retiredAt) = anchor.receiptKeyRecord(0x02, _x(key));
        assertEq(retiredAt, 0, "retired by a stranger");
    }

    /// A key is registered once and never again, retired or not, so a seized
    /// key, once retired, can't come back for a hostile creator to list
    /// (T-69); and retired at most once, so `retired_at` never moves.
    function test_ReceiptKeyRecordIsAppendOnly() public {
        bytes memory key = _receiptKey(0x02, "k");
        bytes32 x = _x(key);
        bytes memory again =
            abi.encodeWithSelector(BoardAnchor.ReceiptKeyAlreadyRegistered.selector, uint8(2), x);
        bytes memory notActive =
            abi.encodeWithSelector(BoardAnchor.ReceiptKeyNotActive.selector, uint8(2), x);
        _expectReceiptKeyRefused(BoardAnchor.retireReceiptKey.selector, key, notActive);
        vm.warp(EPOCH);
        vm.prank(authority);
        anchor.registerReceiptKey(key);
        vm.warp(EPOCH + 1);
        _expectReceiptKeyRefused(BoardAnchor.registerReceiptKey.selector, key, again);
        vm.prank(authority);
        anchor.retireReceiptKey(key);
        vm.warp(EPOCH + 2);
        _expectReceiptKeyRefused(BoardAnchor.registerReceiptKey.selector, key, again);
        _expectReceiptKeyRefused(BoardAnchor.retireReceiptKey.selector, key, notActive);
        (uint64 registeredAt, uint64 retiredAt) = anchor.receiptKeyRecord(0x02, x);
        assertEq(registeredAt, EPOCH, "registeredAt moved");
        assertEq(retiredAt, EPOCH + 1, "retiredAt moved");
        // Its twin, the other prefix with the same x, is its negation: anyone
        // holding the retired key's secret holds the twin's, so it never
        // comes in either.
        _expectReceiptKeyRefused(
            BoardAnchor.registerReceiptKey.selector,
            _receiptKey(0x03, "k"),
            abi.encodeWithSelector(BoardAnchor.ReceiptKeyAlreadyRegistered.selector, uint8(3), x)
        );
        (registeredAt,) = anchor.receiptKeyRecord(0x03, x);
        assertEq(registeredAt, 0, "twin registered");
    }

    /// A key is exactly 33 bytes starting 0x02 or 0x03, for both calls (T-17).
    function test_ReceiptKeyFraming() public {
        bytes memory malformed = abi.encodeWithSelector(BoardAnchor.MalformedReceiptKey.selector);
        uint256[5] memory lengths = [uint256(0), 1, 32, 34, 65];
        for (uint256 i; i < lengths.length; i++) {
            bytes memory key = new bytes(lengths[i]);
            if (key.length != 0) key[0] = 0x02;
            _expectReceiptKeyRefused(BoardAnchor.registerReceiptKey.selector, key, malformed);
            _expectReceiptKeyRefused(BoardAnchor.retireReceiptKey.selector, key, malformed);
        }
        uint8[4] memory prefixes = [0x00, 0x01, 0x04, 0x82];
        for (uint256 i; i < prefixes.length; i++) {
            bytes memory key = _receiptKey(prefixes[i], "k");
            _expectReceiptKeyRefused(BoardAnchor.registerReceiptKey.selector, key, malformed);
            _expectReceiptKeyRefused(BoardAnchor.retireReceiptKey.selector, key, malformed);
        }
    }

    /// The calldata is exactly one canonical 33-byte `bytes` argument: a
    /// moved offset, a trailing byte or word, and dirty padding are refused.
    function test_ReceiptKeysRefuseNonCanonicalCalldata() public {
        bytes4[2] memory selectors =
            [BoardAnchor.registerReceiptKey.selector, BoardAnchor.retireReceiptKey.selector];
        for (uint256 f; f < 2; f++) {
            bytes memory key = _receiptKey(0x02, "k");
            bytes memory good = abi.encodeWithSelector(selectors[f], key);
            bytes memory nonCanonical = abi.encodeWithSelector(_nonCanonical());
            bytes memory dirty = bytes.concat(good);
            dirty[dirty.length - 1] = 0x01;
            // A properly framed argument at offset 0x40, after a junk word.
            bytes memory moved = bytes.concat(
                selectors[f], abi.encode(uint256(0x40), uint256(0), uint256(33)), key, new bytes(31)
            );
            // Offset 0, reading the offset word as a zero length: the
            // calldata's length fits an empty argument, so only the offset
            // check refuses it.
            bytes memory selfPointing = bytes.concat(selectors[f], abi.encode(uint256(0)));
            // Framing is checked after canonicality: a bad prefix in
            // non-canonical calldata is refused as non-canonical.
            bytes memory badPrefix =
                bytes.concat(abi.encodeWithSelector(selectors[f], _receiptKey(0x04, "k")), hex"00");
            bytes[6] memory calls = [
                bytes.concat(good, hex"00"),
                bytes.concat(good, bytes32(0)),
                dirty,
                moved,
                selfPointing,
                badPrefix
            ];
            for (uint256 i; i < calls.length; i++) {
                vm.prank(authority);
                (bool ok, bytes memory ret) = address(anchor).call(calls[i]);
                _assertRefused(ok, ret, nonCanonical);
            }
            (uint64 registeredAt, uint64 retiredAt) = anchor.receiptKeyRecord(0x02, _x(key));
            assertEq(f == 0 ? registeredAt : retiredAt, 0, "written");
            vm.prank(authority);
            (bool accepted,) = address(anchor).call(good);
            assertTrue(accepted, "the canonical call");
        }
    }

    /// The caller is checked first: a stranger's call is refused as such
    /// whatever its key or calldata, so no one but the authority learns
    /// anything from the record's refusals or reaches them.
    function test_ReceiptKeysCheckTheCallerFirst() public {
        bytes memory notAuthority =
            abi.encodeWithSelector(BoardAnchor.NotAuthority.selector, address(0xA11CE));
        bytes4[2] memory selectors =
            [BoardAnchor.registerReceiptKey.selector, BoardAnchor.retireReceiptKey.selector];
        for (uint256 f; f < 2; f++) {
            bytes memory good = abi.encodeWithSelector(selectors[f], _receiptKey(0x02, "k"));
            bytes[3] memory calls = [
                abi.encodeWithSelector(selectors[f], _receiptKey(0x04, "k")),
                abi.encodeWithSelector(selectors[f], new bytes(32)),
                bytes.concat(good, hex"00")
            ];
            for (uint256 i; i < calls.length; i++) {
                vm.prank(address(0xA11CE));
                (bool ok, bytes memory ret) = address(anchor).call(calls[i]);
                _assertRefused(ok, ret, notAuthority);
            }
        }
    }

    /// Any calldata the authority sends to either call is accepted only if it
    /// is exactly the canonical encoding of the key it decodes to (T-17).
    function testFuzz_ReceiptKeyCalldataIsCanonical(
        bytes calldata tail,
        uint8 cut,
        bool dirty,
        bool retire
    ) public {
        bytes memory key = _receiptKey(0x02, keccak256(tail));
        if (retire) {
            vm.prank(authority);
            anchor.registerReceiptKey(key);
        }
        bytes memory good = retire
            ? abi.encodeCall(BoardAnchor.retireReceiptKey, (key))
            : abi.encodeCall(BoardAnchor.registerReceiptKey, (key));
        bytes memory call;
        if (dirty) {
            call = bytes.concat(good);
            uint256 at = 4 + uint256(keccak256(tail)) % (good.length - 4);
            call[at] = bytes1(uint8(call[at]) ^ (1 + cut % 255));
        } else if (cut % 2 == 0) {
            call = bytes.concat(good, tail);
        } else {
            uint256 keep = good.length - cut % (good.length - 3);
            call = new bytes(keep);
            for (uint256 i; i < keep; i++) {
                call[i] = good[i];
            }
        }
        vm.prank(authority);
        (bool ok,) = address(anchor).call(call);
        if (!ok) return;
        bytes memory decoded = this.decodeReceiptKeyCall(call);
        assertTrue(
            keccak256(call) == keccak256(bytes.concat(bytes4(call), abi.encode(decoded))),
            "accepted a non-canonical call"
        );
        assertEq(decoded.length, 33, "accepted a malformed key");
    }

    function decodeReceiptKeyCall(bytes calldata call) external pure returns (bytes memory) {
        return abi.decode(call[4:], (bytes));
    }

    /// Any sequence of registrations and retirements of a few keys, at any
    /// times, leaves each record as the first registration and the first
    /// retirement after it wrote it, and nothing else succeeds (T-69).
    function testFuzz_ReceiptKeyRecordFollowsTheFirstWrites(uint256[8] calldata ops) public {
        // Keys 0–3: prefixes 0x02 and 0x03 of two x values, so 2k and 2k + 1 are twins.
        uint64[2][4] memory shadow;
        uint256 t = EPOCH;
        for (uint256 i; i < ops.length; i++) {
            uint256 k = ops[i] % 4;
            bool retire = (ops[i] >> 8) % 2 == 1;
            t += (ops[i] >> 16) % 1000;
            vm.warp(t);
            vm.prank(authority);
            (bool ok,) = address(anchor)
                .call(
                    retire
                        ? abi.encodeCall(BoardAnchor.retireReceiptKey, (_fuzzKey(k)))
                        : abi.encodeCall(BoardAnchor.registerReceiptKey, (_fuzzKey(k)))
                );
            bool allowed = retire
                ? shadow[k][0] != 0 && shadow[k][1] == 0
                : shadow[k][0] == 0 && shadow[k ^ 1][0] == 0;
            assertTrue(ok == allowed, "acceptance");
            if (ok) shadow[k][retire ? 1 : 0] = uint64(t);
        }
        for (uint256 k; k < 4; k++) {
            bytes memory key = _fuzzKey(k);
            (uint64 registeredAt, uint64 retiredAt) =
                anchor.receiptKeyRecord(uint8(key[0]), _x(key));
            assertEq(registeredAt, shadow[k][0], "registeredAt");
            assertEq(retiredAt, shadow[k][1], "retiredAt");
        }
    }

    function _fuzzKey(uint256 k) internal pure returns (bytes memory) {
        return _receiptKey(uint8(2 + k % 2), bytes32(k / 2 + 1));
    }

    /// A real key's calldata and logs carry no text. The 32 bytes after the
    /// prefix are the authority's choice and aren't checked on the curve, so
    /// text in them is accepted: T-17's stated residual, kept honest here.
    function test_ReceiptKeyCarriesNoTextButCould() public {
        string memory json = vm.readFile(DEFINITION_V4_VECTORS);
        bytes memory key =
            vm.parseBytes(vm.parseJsonString(json, ".vectors[0].value.receipt_keys[1]"));
        vm.recordLogs();
        vm.prank(authority);
        anchor.registerReceiptKey(key);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(
            !_looksLikeText(abi.encodeCall(BoardAnchor.registerReceiptKey, (key))), "calldata"
        );
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        bytes memory text = bytes.concat(hex"02", "Alice Smith, alice@example.com..");
        assertTrue(_looksLikeText(text), "detector misses the text");
        vm.prank(authority);
        anchor.registerReceiptKey(text);
        (uint64 registeredAt,) = anchor.receiptKeyRecord(0x02, _x(text));
        assertTrue(registeredAt != 0, "text accepted (T-17 residual)");
    }

    // --- fuzz ----------------------------------------------------------------

    /// Far from any window, nothing is stored.
    function testFuzz_NothingStoredFarFromTheWindow(uint32 segment, uint256 t) public {
        uint256 end = anchor.periodEnd(segment);
        t = t % (uint256(EPOCH) + (uint256(1) << 32) * PERIOD + 2 * DEADLINE);
        vm.assume(t < end || t - end > DEADLINE);
        vm.warp(t);
        vm.prank(authority);
        (bool ok,) = address(anchor)
            .call(
                abi.encodeCall(BoardAnchor.anchor, (_encode(ID, segment, 1, "h", "r"), bytes("")))
            );
        assertTrue(!ok, "stored outside the window");
    }

    /// Any checkpoint at any time is stored exactly when it is non-empty and
    /// inside its window, and then under its hash.
    function testFuzz_StoredExactlyInsideTheWindow(
        bytes32 id,
        uint32 segment,
        uint64 size,
        bytes32 head,
        bytes32 root,
        uint256 t
    ) public {
        // Around the window, so both outcomes are common.
        uint256 end = anchor.periodEnd(segment);
        t = end - PERIOD + t % (PERIOD + DEADLINE + 2);
        vm.warp(t);
        bool allowed = size != 0 && t >= end && t - end <= DEADLINE;
        vm.prank(authority);
        (bool ok,) = address(anchor)
            .call(
                abi.encodeCall(
                    BoardAnchor.anchor, (_encode(id, segment, size, head, root), bytes(""))
                )
            );
        assertTrue(ok == allowed, "acceptance");
        assertEq(
            anchor.checkpointHashOf(id, segment),
            ok ? lib.hash(id, segment, size, head, root) : bytes32(0),
            "stored"
        );
    }

    // --- helpers -------------------------------------------------------------

    /// A crude personal-data detector: an at sign with two printable ASCII
    /// characters on each side (an email address), or a run of 12 or more
    /// printable characters (a name, a street address, a document number).
    /// Loose enough that ~250 bytes of hash output rarely trip it (about 2%
    /// for a fresh fixture), so a failure after a fixture change needs a look,
    /// not a looser detector.
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

    /// `u16(version)` and a body of `bodyLength` bytes of 0xab.
    function _locator(uint16 version, uint256 bodyLength) internal pure returns (bytes memory b) {
        b = new bytes(2 + bodyLength);
        b[0] = bytes1(uint8(version >> 8));
        b[1] = bytes1(uint8(version));
        for (uint256 i = 2; i < b.length; i++) {
            b[i] = 0xab;
        }
    }

    function _word(bytes memory b, uint256 at) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), at))
        }
    }

    function _expectRefusedWith(bytes memory checkpoints, bytes memory loc, bytes memory expected)
        internal
    {
        vm.prank(authority);
        (bool ok, bytes memory ret) =
            address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (checkpoints, loc)));
        _assertRefused(ok, ret, expected);
    }

    function _nonCanonical() internal pure returns (bytes4) {
        return bytes4(keccak256("NonCanonicalCalldata()"));
    }

    function _encode(bytes32 id, uint32 segment, uint64 size, bytes32 head, bytes32 root)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(id, segment, size, head, root);
    }

    function _slot(bytes32 id, uint32 segment) internal pure returns (bytes32) {
        bytes32 inner = keccak256(
            abi.encode(id, 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00)
        );
        return keccak256(abi.encode(uint256(segment), inner));
    }

    function _expectRefused(bytes memory checkpoints, bytes memory expected) internal {
        vm.prank(authority);
        (bool ok, bytes memory ret) =
            address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (checkpoints, bytes(""))));
        _assertRefused(ok, ret, expected);
    }

    function _assertRefused(bool ok, bytes memory ret, bytes memory expected) internal pure {
        assertTrue(!ok, "call succeeded");
        _assertData(ret, expected);
    }

    function _assertData(bytes memory ret, bytes memory expected) internal pure {
        assertTrue(keccak256(ret) == keccak256(expected), "unexpected revert data");
    }

    function _assertAccumulated(Vm.Log[] memory logs) internal view {
        bytes32 acc = EventAccumulatorLib.genesis(uint64(block.chainid), address(anchor));
        for (uint256 i; i < logs.length; i++) {
            acc = EventAccumulatorLib.step(acc, uint64(i), logs[i].topics, logs[i].data);
        }
        (bytes32 stored, uint64 count) = anchor.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, logs.length, "count");
    }

    /// `prefix ‖ x`: the anchor checks only the framing, so any `x` will do.
    function _receiptKey(uint8 prefix, bytes32 x) internal pure returns (bytes memory) {
        return abi.encodePacked(prefix, x);
    }

    function _x(bytes memory key) internal pure returns (bytes32 x) {
        assembly ("memory-safe") {
            x := mload(add(key, 0x21))
        }
    }

    /// The record's word: `mapping(uint8 => mapping(bytes32 => Record))` at `A + 4`.
    function _receiptKeySlot(bytes memory key) internal pure returns (bytes32) {
        uint256 base = uint256(0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00);
        bytes32 inner = keccak256(abi.encode(uint256(uint8(key[0])), base + 4));
        return keccak256(abi.encode(_x(key), inner));
    }

    function _expectReceiptKeyRefused(bytes4 selector, bytes memory key, bytes memory expected)
        internal
    {
        vm.prank(authority);
        (bool ok, bytes memory ret) = address(anchor).call(abi.encodeWithSelector(selector, key));
        _assertRefused(ok, ret, expected);
    }

    function _judging(uint256 i) internal pure returns (string memory) {
        return string.concat(".judging[", vm.toString(i), "]");
    }

    function _uintString(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _board(uint256 i) internal pure returns (string memory) {
        return string.concat(".boards[", vm.toString(i), "]");
    }

    function _checkpoint(uint256 i, uint256 j) internal pure returns (string memory) {
        return string.concat(_board(i), ".checkpoints[", vm.toString(j), "]");
    }

    function _bytes32(string memory json, string memory key) internal pure returns (bytes32) {
        return bytes32(vm.parseBytes(vm.parseJsonString(json, key)));
    }

    function _parseCheckpoint(string memory json, string memory c)
        internal
        pure
        returns (bytes32 id, uint32 s, uint64 size, bytes32 head, bytes32 root)
    {
        id = _bytes32(json, string.concat(c, ".electionId"));
        s = uint32(vm.parseUint(vm.parseJsonString(json, string.concat(c, ".segment"))));
        size = uint64(vm.parseUint(vm.parseJsonString(json, string.concat(c, ".size"))));
        head = _bytes32(json, string.concat(c, ".head"));
        root = _bytes32(json, string.concat(c, ".root"));
    }
}
