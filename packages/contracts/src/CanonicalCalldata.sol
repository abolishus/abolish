// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title Exact calldata for functions taking `bytes` arguments.
library CanonicalCalldata {
    error NonCanonicalCalldata();

    /// The calldata is exactly the standard ABI encoding of one `bytes`
    /// argument: offset 0x20, zero padding, nothing after it. Solidity's
    /// decoder accepts other offsets and trailing bytes, which would let a
    /// transaction carry bytes no record defines (docs/spec/notation.md,
    /// Result-critical fields; T-17).
    function requireOneBytesArgument(bytes calldata b) internal pure {
        requireWordsThenBytes(0, b);
    }

    /// The calldata is exactly the standard ABI encoding of `words` static
    /// one-word arguments followed by one `bytes` argument: the bytes'
    /// offset `32 · (words + 1)`, zero padding, nothing after it. The
    /// static words themselves are the decoder's: Solidity reverts on a
    /// value outside its type, such as a `uint64` word with bit 64 set.
    function requireWordsThenBytes(uint256 words, bytes calldata b) internal pure {
        uint256 len = b.length;
        uint256 padded = (len + 31) & ~uint256(31);
        uint256 head = 4 + 32 * (words + 1);
        uint256 offsetWord;
        uint256 lastWord;
        assembly ("memory-safe") {
            offsetWord := calldataload(sub(head, 32))
            // The word holding the last data bytes and the padding after them.
            if mod(len, 32) {
                lastWord := calldataload(add(add(head, 32), sub(padded, 32)))
            }
        }
        if (msg.data.length != head + 32 + padded || offsetWord != head - 4) {
            revert NonCanonicalCalldata();
        }
        if (len % 32 != 0 && lastWord << (8 * (len % 32)) != 0) revert NonCanonicalCalldata();
    }

    /// The calldata is exactly the standard ABI encoding of two `bytes`
    /// arguments: the head's two offsets pointing at the first and second
    /// tails in order, each tail zero-padded, nothing after the second.
    function requireTwoBytesArguments(bytes calldata a, bytes calldata b) internal pure {
        uint256 paddedA = (a.length + 31) & ~uint256(31);
        uint256 paddedB = (b.length + 31) & ~uint256(31);
        // a's data follows the 4-byte selector, two offset words and its
        // length word; b's follows a's padded data and its own length word.
        uint256 offsetA;
        uint256 offsetB;
        assembly ("memory-safe") {
            offsetA := a.offset
            offsetB := b.offset
        }
        if (offsetA != 4 + 96 || offsetB != 4 + 128 + paddedA) revert NonCanonicalCalldata();
        if (msg.data.length != 4 + 128 + paddedA + paddedB) revert NonCanonicalCalldata();
        _requireZeroPadding(a);
        _requireZeroPadding(b);
    }

    function _requireZeroPadding(bytes calldata b) private pure {
        uint256 len = b.length;
        if (len % 32 == 0) return;
        uint256 lastWord;
        assembly ("memory-safe") {
            lastWord := calldataload(add(b.offset, sub(len, mod(len, 32))))
        }
        if (lastWord << (8 * (len % 32)) != 0) revert NonCanonicalCalldata();
    }
}
