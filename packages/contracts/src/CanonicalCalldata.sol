// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title Exact calldata for functions taking one `bytes` argument.
library CanonicalCalldata {
    error NonCanonicalCalldata();

    /// The calldata is exactly the standard ABI encoding of one `bytes`
    /// argument: offset 0x20, zero padding, nothing after it. Solidity's
    /// decoder accepts other offsets and trailing bytes, which would let a
    /// transaction carry bytes no record defines (docs/spec/notation.md,
    /// Result-critical fields; T-17).
    function requireOneBytesArgument(bytes calldata b) internal pure {
        uint256 len = b.length;
        uint256 padded = (len + 31) & ~uint256(31);
        uint256 offsetWord;
        uint256 lastWord;
        assembly ("memory-safe") {
            offsetWord := calldataload(4)
            // The word holding the last data bytes and the padding after them.
            if mod(len, 32) { lastWord := calldataload(add(68, sub(padded, 32))) }
        }
        if (msg.data.length != 68 + padded || offsetWord != 0x20) revert NonCanonicalCalldata();
        if (len % 32 != 0 && lastWord << (8 * (len % 32)) != 0) revert NonCanonicalCalldata();
    }
}
