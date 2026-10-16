// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {IStakeManager} from "@account-abstraction/contracts/interfaces/IStakeManager.sol";
import {
    PackedUserOperation
} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {GroupRegistry} from "./GroupRegistry.sol";

/// @title The registration paymaster (docs/spec/contracts.md, Registration paymaster).
/// @notice Pays, from its EntryPoint deposit, for exactly one kind of ERC-4337
/// UserOperation: the signing service's account calling the group registry's
/// `addMembers`, at no more than a fixed cost (docs/adr/0024-tier0-registration.md,
/// docs/spec/registration.md). It sponsors no voter, so no voter's account
/// or address ever meets a commitment here (T-13), and no one else can
/// spend the deposit; whoever seizes the service's key can drain it, at most
/// `maxCost` per operation (T-69, T-52). Everything it checks is in the UserOperation and its immutables, so
/// it reads no storage while validating (ERC-7562) and needs no stake.
/// Its admin, a timelock behind our Safe, can only move funds in and out of
/// the EntryPoint; what it sponsors is fixed at deployment (T-62). It holds
/// nothing a verifier reads and emits no log.
contract RegistrationPaymaster is IPaymaster {
    /// Why a UserOperation isn't sponsored, in the order checked.
    enum Refusal {
        Sender,
        InitCode,
        PaymasterData,
        CallData,
        Cost
    }

    /// `execute(address,uint256,bytes)`, the call ERC-4337's reference
    /// account (and most others) makes on the account owner's behalf.
    bytes4 internal constant EXECUTE = 0xb61d27f6;

    /// `paymasterAndData` is the paymaster's address and its two gas limits
    /// (EntryPoint v0.8's `PAYMASTER_DATA_OFFSET`), with nothing after.
    uint256 internal constant PAYMASTER_AND_DATA_LENGTH = 52;

    /// Where `execute`'s `bytes` data starts: the selector, the target, the
    /// value, the offset and the length word.
    uint256 internal constant INNER = 4 + 32 * 4;

    /// The EntryPoint (v0.8), which holds the deposit and is the only caller
    /// of `validatePaymasterUserOp`.
    IStakeManager public immutable entryPoint;
    /// The group registry whose `addMembers` is the only call sponsored.
    address public immutable registry;
    /// The signing service's account, the only sender sponsored.
    address public immutable service;
    /// The timelock that may withdraw the deposit and manage the stake.
    address public immutable admin;
    /// The most one UserOperation may cost the deposit, in wei.
    uint256 public immutable maxCost;

    error InvalidDeployment();
    error NotEntryPoint();
    error NotAdmin();
    error NotSponsored(Refusal refusal);
    error PostOpNotUsed();

    constructor(
        IStakeManager entryPoint_,
        address registry_,
        address service_,
        address admin_,
        uint256 maxCost_
    ) {
        // The EntryPoint, the registry and the admin are contracts; an admin
        // without code, or with only an EIP-7702 delegation, is a single key
        // (T-62). Code doesn't prove a timelock, so the deployment record
        // names it, but the plain mistake is refused here. The service's
        // account may be deployed later, but never through a sponsored
        // operation (`InitCode`).
        if (
            !_isContract(address(entryPoint_)) || !_isContract(registry_) || !_isContract(admin_)
                || service_ == address(0) || maxCost_ == 0
        ) revert InvalidDeployment();
        entryPoint = entryPoint_;
        registry = registry_;
        service = service_;
        admin = admin_;
        maxCost = maxCost_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @inheritdoc IPaymaster
    /// @dev Sponsors the operation only if, in this order: its sender is the
    /// service's account; it deploys no account; it carries no paymaster
    /// data; its call is exactly `execute(registry, 0, addMembers(…))`; and
    /// its `maxCost` is at most this paymaster's. It returns no context, so
    /// the EntryPoint never calls `postOp`, and no time range.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost_)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (userOp.sender != service) revert NotSponsored(Refusal.Sender);
        if (userOp.initCode.length != 0) revert NotSponsored(Refusal.InitCode);
        if (userOp.paymasterAndData.length != PAYMASTER_AND_DATA_LENGTH) {
            revert NotSponsored(Refusal.PaymasterData);
        }
        if (!_isAddMembersCall(userOp.callData)) revert NotSponsored(Refusal.CallData);
        if (maxCost_ > maxCost) revert NotSponsored(Refusal.Cost);
        return ("", 0);
    }

    /// @inheritdoc IPaymaster
    /// @dev Never called: validation returns no context.
    function postOp(PostOpMode, bytes calldata, uint256, uint256) external pure {
        revert PostOpNotUsed();
    }

    /// @notice Adds to the deposit operations are paid from. Anyone may.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice The deposit left.
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyAdmin {
        entryPoint.withdrawTo(to, amount);
    }

    /// @notice A stake lifts the bundlers' limits on an unstaked paymaster
    /// (ERC-7562); this one works without one.
    function addStake(uint32 unstakeDelaySec) external payable onlyAdmin {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyAdmin {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyAdmin {
        entryPoint.withdrawStake(to);
    }

    /// Whether `c` is exactly the standard ABI encoding of
    /// `execute(registry, 0, inner)` with `inner` exactly the standard ABI
    /// encoding of `addMembers(record)`, up to the record's own padding. The
    /// offsets and lengths are fixed so that the call checked here is the one
    /// the account makes, and `inner` can't carry bytes after the record,
    /// which the registry would refuse at the deposit's cost; the record
    /// itself is the registry's to check (T-17, T-71).
    function _isAddMembersCall(bytes calldata c) private view returns (bool) {
        if (c.length < INNER + 68 || bytes4(c[0:4]) != EXECUTE) return false;
        if (uint256(bytes32(c[4:36])) != uint256(uint160(registry))) return false;
        if (uint256(bytes32(c[36:68])) != 0 || uint256(bytes32(c[68:100])) != 0x60) return false;
        uint256 len = uint256(bytes32(c[100:132]));
        if (len > c.length - INNER) return false;
        uint256 padded = (len + 31) & ~uint256(31);
        if (c.length != INNER + padded) return false;
        if (len % 32 != 0 && uint256(bytes32(c[INNER + padded - 32:])) << (8 * (len % 32)) != 0) {
            return false;
        }
        // `inner` is the selector, the offset 0x20, the record's length and
        // the record, padded to a word.
        if (len < 68 || bytes4(c[INNER:INNER + 4]) != GroupRegistry.addMembers.selector) {
            return false;
        }
        if (uint256(bytes32(c[INNER + 4:INNER + 36])) != 0x20) return false;
        uint256 recordLength = uint256(bytes32(c[INNER + 36:INNER + 68]));
        return recordLength <= len - 68 && len == 68 + ((recordLength + 31) & ~uint256(31));
    }

    function _isContract(address a) private view returns (bool) {
        bytes memory code = a.code;
        if (code.length == 0) return false;
        return !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
    }
}
