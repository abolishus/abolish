// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {EventAccumulatorLib} from "../../src/EventAccumulator.sol";
import {GroupRegistry, VouchLib} from "../../src/GroupRegistry.sol";
import {MembershipProofLib} from "../../src/MembershipProof.sol";

/// The group registry with its Tier 1 proof check (rule 7) exposed alone,
/// and VouchLib's scopes and messages, so docs/spec/vectors/vouch.json,
/// whose root blocks are off the grid rule 5 requires, checks the proofs
/// exactly as `addTier1Member` does.
contract Tier1Harness is GroupRegistry {
    constructor(uint8 threshold_, address[] memory registrars_)
        GroupRegistry(threshold_, registrars_)
    {}

    /// Rule 7 over every vouch of a record that already frames, under this
    /// chain and this contract's address.
    function checkVouchProofs(bytes calldata record) external view {
        uint64 chainId = EventAccumulatorLib.chainId64(block.chainid);
        bytes memory voucheeBytes = VouchLib.vouchee(
            chainId, address(this), uint64(bytes8(record[0:8])), uint256(bytes32(record[8:40]))
        );
        uint256 voucheeScope = MembershipProofLib.field(VouchLib.voucheeScopeBytes(voucheeBytes));
        for (uint256 i; i < VouchLib.K; i++) {
            _checkVouchProofs(record, i, chainId, voucheeBytes, voucheeScope);
        }
    }

    function voucheeScope(uint64 chainId, address registry, uint64 groupId, uint256 commitment)
        external
        pure
        returns (bytes32)
    {
        return VouchLib.voucheeScopeBytes(VouchLib.vouchee(chainId, registry, groupId, commitment));
    }

    function slotScope(uint64 chainId, address registry, uint16 slot)
        external
        pure
        returns (bytes32)
    {
        return VouchLib.slotScopeBytes(chainId, registry, slot);
    }

    function message(
        uint8 role,
        uint64 chainId,
        address registry,
        uint64 groupId,
        uint256 commitment,
        uint64 tier2GroupId,
        uint64 rootBlock,
        uint256 otherNullifier
    ) external pure returns (bytes32) {
        return VouchLib.messageBytes(
            role,
            VouchLib.vouchee(chainId, registry, groupId, commitment),
            tier2GroupId,
            rootBlock,
            otherNullifier
        );
    }

    function constants()
        external
        pure
        returns (uint256 k, uint256 slots, uint256 interval, uint256 window, uint256 length)
    {
        return (
            VouchLib.K,
            VouchLib.SLOTS,
            VouchLib.ROOT_INTERVAL,
            VouchLib.ROOT_WINDOW,
            VouchLib.RECORD_LENGTH
        );
    }
}
