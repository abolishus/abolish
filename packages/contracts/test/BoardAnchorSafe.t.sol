// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BoardAnchor} from "../src/BoardAnchor.sol";
import {Safe} from "../vendor/safe-smart-account/contracts/Safe.sol";
import {Enum} from "../vendor/safe-smart-account/contracts/common/Enum.sol";
import {
    SafeProxyFactory
} from "../vendor/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {TestBase} from "./utils/Vm.sol";

/// The board anchor with a real Safe (v1.4.1, vendored) as its authority, as
/// the deployment runs it (docs/spec/contracts.md, Board anchor): a call
/// lands only with the threshold's signatures, and a Safe transaction whose
/// anchor call the anchor refuses reverts as a whole when it carries no
/// `safeTxGas` and no gas price, so the anchoring job can never take a
/// mined Safe transaction for an anchor made (T-49, T-69). The worker's
/// sender (apps/worker/src/anchor-safe.ts) sends exactly these transactions.
contract BoardAnchorSafeTest is TestBase {
    uint64 internal constant EPOCH = 1_800_000_000;
    uint64 internal constant PERIOD = 3600;
    uint64 internal constant DEADLINE = 43_200;
    bytes32 internal constant ID = keccak256("election");

    uint256[3] internal keys = [uint256(0xa11ce), 0xb0b, 0xca401];
    Safe internal safe;
    BoardAnchor internal anchor;

    function setUp() public {
        Safe singleton = new Safe();
        SafeProxyFactory factory = new SafeProxyFactory();
        address[] memory owners = new address[](3);
        for (uint256 i; i < 3; i++) {
            owners[i] = vm.addr(keys[i]);
        }
        bytes memory init = abi.encodeCall(
            Safe.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = Safe(payable(address(factory.createProxyWithNonce(address(singleton), init, 0))));
        anchor = new BoardAnchor(BoardAnchor.Clock(EPOCH, PERIOD, DEADLINE), address(safe));
        vm.warp(EPOCH + 2 * PERIOD);
    }

    function test_AnchorsWithTheThresholdsSignatures() public {
        bytes memory data = _call(_checkpoint(1));
        assertTrue(_exec(data, _sign(data, _pair(0, 1))), "executed");
        assertTrue(anchor.checkpointHashOf(ID, 1) != bytes32(0), "anchored");
        assertEq(safe.nonce(), 1, "nonce");
    }

    function test_RefusesFewerSignaturesThanTheThreshold() public {
        bytes memory data = _call(_checkpoint(1));
        uint256[] memory one = new uint256[](1);
        one[0] = keys[2];
        bytes memory sigs = _sign(data, one);
        vm.expectRevert(bytes("GS020"));
        _exec(data, sigs);
        assertEq(anchor.checkpointHashOf(ID, 1), bytes32(0), "not anchored");
    }

    function test_RefusesUnsortedSignatures() public {
        bytes memory data = _call(_checkpoint(1));
        uint256[] memory pair = _pair(0, 1);
        (pair[0], pair[1]) =
            vm.addr(pair[0]) < vm.addr(pair[1]) ? (pair[1], pair[0]) : (pair[0], pair[1]);
        bytes memory sigs;
        for (uint256 i; i < 2; i++) {
            sigs = bytes.concat(sigs, _signature(pair[i], data));
        }
        vm.expectRevert(bytes("GS026"));
        _exec(data, sigs);
    }

    /// A checkpoint the anchor refuses (its period isn't over) reverts the
    /// whole Safe transaction: nothing is anchored and the nonce stays.
    function test_ARefusedAnchorCallRevertsTheSafeTransaction() public {
        bytes memory data = _call(_checkpoint(2));
        bytes memory sigs = _sign(data, _pair(0, 2));
        vm.expectRevert(bytes("GS013"));
        _exec(data, sigs);
        assertEq(safe.nonce(), 0, "nonce");
        assertEq(anchor.checkpointHashOf(ID, 2), bytes32(0), "not anchored");
    }

    function _exec(bytes memory data, bytes memory sigs) internal returns (bool) {
        return safe.execTransaction(
            address(anchor),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            sigs
        );
    }

    /// Signatures by `signers`, ordered by owner address as the Safe requires.
    function _sign(bytes memory data, uint256[] memory signers)
        internal
        view
        returns (bytes memory sigs)
    {
        for (uint256 i; i < signers.length; i++) {
            for (uint256 j = i + 1; j < signers.length; j++) {
                if (vm.addr(signers[j]) < vm.addr(signers[i])) {
                    (signers[i], signers[j]) = (signers[j], signers[i]);
                }
            }
        }
        for (uint256 i; i < signers.length; i++) {
            sigs = bytes.concat(sigs, _signature(signers[i], data));
        }
    }

    function _signature(uint256 key, bytes memory data) internal view returns (bytes memory) {
        bytes32 h = safe.getTransactionHash(
            address(anchor),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            address(0),
            safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _pair(uint256 a, uint256 b) internal view returns (uint256[] memory p) {
        p = new uint256[](2);
        (p[0], p[1]) = (keys[a], keys[b]);
    }

    function _call(bytes memory checkpoints) internal pure returns (bytes memory) {
        return abi.encodeCall(BoardAnchor.anchor, (checkpoints, bytes("")));
    }

    function _checkpoint(uint32 segment) internal pure returns (bytes memory) {
        return abi.encodePacked(
            ID,
            segment,
            uint64(1),
            bytes32("head"),
            bytes32("root"),
            hex"01551220",
            keccak256("object"),
            hex"01701220",
            keccak256("hashes")
        );
    }
}
