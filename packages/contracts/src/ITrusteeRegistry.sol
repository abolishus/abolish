// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title What the election registry asks the trustee key registry (docs/spec/contracts.md, Election registry).
/// @notice Implemented by `TrusteeRegistry`. It records a pair (stub hash,
/// ceremony transcript hash) only with signatures over both from a quorum of
/// distinct seats of a panel it pins, never on `msg.sender` alone
/// (docs/spec/trustee-identity.md, Ceremony registration; T-37, T-71).
interface ITrusteeRegistry {
    /// @notice Whether a quorum of distinct seats of the pinned panel
    /// identified by `panelId`, whose threshold and size are `threshold` and
    /// `panelSize`, approved the ceremony transcript `transcriptHash` for the
    /// definition stub `stubHash`. False for any panel it doesn't pin, so a
    /// quorum of one pinned panel can't approve a definition naming another
    /// panel or another threshold (T-14, T-37).
    function ceremonyRecorded(
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 panelId,
        uint8 threshold,
        uint8 panelSize
    ) external view returns (bool);
}
