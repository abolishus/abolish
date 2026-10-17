// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {
    SIG_VALIDATION_FAILED,
    SIG_VALIDATION_SUCCESS
} from "@account-abstraction/contracts/core/Helpers.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {
    PackedUserOperation
} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title The registration service's account (docs/spec/contracts.md, Registration account).
/// @notice The ERC-4337 account the signing service submits its Tier 0
/// batches from, the registration paymaster's only sponsored sender. It is
/// ERC-4337's reference `BaseAccount` (EntryPoint v0.8, vendored unmodified),
/// so `execute` means exactly what the paymaster's calldata check assumes,
/// with one owner key fixed at deployment and no upgrade path: unlike the
/// reference `SimpleAccount` (UUPS) or an EIP-7702 delegation, nothing can
/// later change what `execute` does (T-62, T-69). Only the EntryPoint can
/// make it call anything, and only for an operation the owner key signed.
/// It holds no ether (it has no `receive`), so every operation it sends is
/// paid for by a paymaster, and emits no log.
contract RegistrationAccount is BaseAccount {
    IEntryPoint private immutable _entryPoint;
    /// The address of the signing service's key, which signs each
    /// operation's hash.
    address public immutable owner;

    error InvalidDeployment();

    constructor(IEntryPoint entryPoint_, address owner_) {
        // An EntryPoint without code (or with only an EIP-7702 delegation)
        // is a mistake no operation could ever pass through; a zero owner
        // would accept every signature `ecrecover` fails on.
        if (!_isContract(address(entryPoint_)) || owner_ == address(0)) {
            revert InvalidDeployment();
        }
        _entryPoint = entryPoint_;
        owner = owner_;
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /// @dev EntryPoint v0.8's `userOpHash` is already the EIP-712 digest of
    /// the operation, bound to the chain and the EntryPoint, so the owner
    /// signs it as it is (as the reference account does). A signature that
    /// doesn't recover, recovers to someone else, or isn't 65 bytes with a
    /// low `s` is a failed validation, never a revert, as ERC-4337 asks.
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(userOpHash, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer != owner) return SIG_VALIDATION_FAILED;
        return SIG_VALIDATION_SUCCESS;
    }

    function _isContract(address a) private view returns (bool) {
        bytes memory code = a.code;
        if (code.length == 0) return false;
        return !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00);
    }
}
