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
            anchor.anchor(abi.encodePacked(id, s, size, head, root));
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
        anchor.anchor(_encode(ID, 2, 5, bytes32("head"), bytes32("root")));
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
        anchor.anchor(_encode(ID, 6, 1, bytes32("h"), bytes32("r")));
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
            )
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
                address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (cp)));
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
        anchor.anchor(_encode(ID, 4, 1, "h", "r"));
        vm.warp(end + PERIOD + DEADLINE); // period 5's last second
        vm.prank(authority);
        anchor.anchor(_encode(ID, 5, 1, "h", "r"));
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
        anchor.anchor(_encode(ID, 0, 2, "h", "r"));
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
        anchor.anchor(_encode(ID, 2, 1, "h", "r"));
        assertEq(anchor.lowestSegmentPlusOne(ID), 3, "first");
        vm.prank(authority);
        anchor.anchor(
            bytes.concat(_encode(keccak256("x"), 0, 2, "h", "r"), _encode(ID, 1, 1, "h", "r"))
        );
        assertEq(anchor.lowestSegmentPlusOne(ID), 2, "lowered");
        vm.prank(authority);
        anchor.anchor(_encode(ID, 0, 1, "h", "r"));
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
        uint256[5] memory lengths = [uint256(0), 1, 107, 109, 215];
        for (uint256 i; i < 5; i++) {
            _expectRefused(
                new bytes(lengths[i]),
                abi.encodeWithSelector(BoardAnchor.MalformedCheckpoints.selector, lengths[i])
            );
        }
    }

    /// T-17: the calldata is exactly the ABI encoding of the checkpoints, so
    /// no transaction to the anchor carries bytes no checkpoint defines.
    function test_RefusesNonCanonicalCalldata() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory cp = _encode(ID, 0, 1, "h", "r");
        bytes memory good = abi.encodeCall(BoardAnchor.anchor, (cp));
        bytes[] memory bad = new bytes[](3);
        bad[0] = bytes.concat(good, bytes32(0)); // a trailing word
        bad[1] = bytes.concat(good, hex"00"); // a trailing byte
        bad[2] = bytes.concat(good); // a copy: `good` must stay canonical
        bad[2][good.length - 1] = 0x01; // dirty padding (108 bytes end mid-word)
        for (uint256 i; i < bad.length; i++) {
            vm.prank(authority);
            (bool ok, bytes memory ret) = address(anchor).call(bad[i]);
            _assertRefused(ok, ret, abi.encodeWithSelector(_nonCanonical()));
        }
        vm.prank(authority);
        (bool success,) = address(anchor).call(good);
        assertTrue(success, "canonical calldata refused");
    }

    /// The same bytes at offset 0x40, after a junk word, are refused too.
    function test_RefusesAMovedArgument() public {
        vm.warp(EPOCH + PERIOD);
        bytes memory cp = _encode(ID, 0, 1, "h", "r");
        bytes memory moved = abi.encodePacked(
            BoardAnchor.anchor.selector,
            uint256(0x40),
            uint256(0),
            uint256(cp.length),
            cp,
            bytes20(0)
        );
        vm.prank(authority);
        (bool ok, bytes memory ret) = address(anchor).call(moved);
        _assertRefused(ok, ret, abi.encodeWithSelector(_nonCanonical()));
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
        anchor.anchor(cp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(!_looksLikeText(abi.encodeCall(BoardAnchor.anchor, (cp))), "calldata");
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

    // --- fuzz ----------------------------------------------------------------

    /// Far from any window, nothing is stored.
    function testFuzz_NothingStoredFarFromTheWindow(uint32 segment, uint256 t) public {
        uint256 end = anchor.periodEnd(segment);
        t = t % (uint256(EPOCH) + (uint256(1) << 32) * PERIOD + 2 * DEADLINE);
        vm.assume(t < end || t - end > DEADLINE);
        vm.warp(t);
        vm.prank(authority);
        (bool ok,) = address(anchor)
            .call(abi.encodeCall(BoardAnchor.anchor, (_encode(ID, segment, 1, "h", "r"))));
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
            .call(abi.encodeCall(BoardAnchor.anchor, (_encode(id, segment, size, head, root))));
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
            address(anchor).call(abi.encodeCall(BoardAnchor.anchor, (checkpoints)));
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
