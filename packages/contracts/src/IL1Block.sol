// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title The OP Stack's `L1Block` predeploy, the L2 block's L1 origin (docs/spec/contracts.md, Election registry, Events).
/// @notice Each L2 block's first transaction, the L1-attributes deposit, sets
/// these to the block's L1 origin. The registry records them in its events so
/// the accumulator authenticates them, and no transaction or header is
/// archived for them (ADR 0025). A verifier checks them against finalized L1
/// and the event's own L2 timestamp; it never trusts them as read (T-71).
interface IL1Block {
    function number() external view returns (uint64);
    function timestamp() external view returns (uint64);
    function hash() external view returns (bytes32);
}
