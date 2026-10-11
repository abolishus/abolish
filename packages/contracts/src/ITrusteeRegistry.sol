// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title What the election registry asks the trustee key registry (docs/spec/contracts.md, Election registry).
/// @notice The trustee registry itself is P1-18's next part. It records a pair
/// (stub hash, ceremony transcript hash) only with signatures over both from
/// enough distinct seats of the panel it pins, never on `msg.sender` alone
/// (docs/spec/trustee-identity.md, Ceremony registration; T-37, T-71).
interface ITrusteeRegistry {
    /// @notice Whether a quorum of the pinned panel approved the ceremony
    /// transcript `transcriptHash` for the definition stub `stubHash`.
    function ceremonyRecorded(bytes32 stubHash, bytes32 transcriptHash) external view returns (bool);
}
