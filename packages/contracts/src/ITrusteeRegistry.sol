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

    /// @notice Checks an author panel's registration record, in this
    /// registry's registration layout, for the election registry
    /// (docs/spec/contracts.md, Author panel registration, checks 6 to 9):
    /// its key set has at least `threshold` seats, in strictly increasing
    /// order within the panel, with distinct valid signing keys, none of
    /// them one of `keys`; and its approvals' seats are strictly increasing
    /// within the panel and each signature verifies under that seat's point
    /// in `keys` (the author keys, in seat order) on the ceremony
    /// registration statement naming this registry and the record's panel,
    /// stub, transcript and key set hash. Returns the key set's hash and its
    /// seats as a bitmask; reverts with the registry's own errors otherwise.
    /// A view of its inputs alone: it checks nothing against the panels
    /// this registry pins and records nothing, so the caller checks the
    /// record's header and quorum against the definition.
    function checkAuthorRegistration(
        bytes calldata registration,
        uint256[2][] calldata keys,
        uint8 threshold
    ) external view returns (bytes32 keySetHash, uint256 seats);
}
