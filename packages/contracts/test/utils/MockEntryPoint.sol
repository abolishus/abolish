// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {
    PackedUserOperation
} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/// The parts of an ERC-4337 EntryPoint the registration paymaster uses: the
/// deposit and stake calls, and one operation's paymaster validation then
/// execution. It keeps the books and calls in the order EntryPoint v0.8
/// does, without its gas accounting, which is the EntryPoint's own.
contract MockEntryPoint {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public unstakeDelayOf;
    mapping(address => bool) public unlocked;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw");
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        require(unstakeDelaySec > 0, "delay");
        stakeOf[msg.sender] += msg.value;
        unstakeDelayOf[msg.sender] = unstakeDelaySec;
        unlocked[msg.sender] = false;
    }

    function unlockStake() external {
        unlocked[msg.sender] = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked[msg.sender], "locked");
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw stake");
    }

    /// Validates `op` with `paymaster`, charges `maxCost` to its deposit,
    /// and runs the operation's call on its sender.
    function handleOp(IPaymaster paymaster, PackedUserOperation calldata op, uint256 maxCost)
        external
        returns (bool success)
    {
        (bytes memory context, uint256 validationData) =
            paymaster.validatePaymasterUserOp(op, keccak256(abi.encode(op)), maxCost);
        require(context.length == 0 && validationData == 0, "validation result");
        balanceOf[address(paymaster)] -= maxCost;
        (success,) = op.sender.call(op.callData);
    }
}

/// An account with ERC-4337's reference `execute`, run only by the EntryPoint.
contract MockAccount {
    address internal immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "not from EntryPoint");
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
