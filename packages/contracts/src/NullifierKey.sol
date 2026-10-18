// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title What the group registry asks the trustee registry about a panel
/// (docs/spec/contracts.md, Group registry, Nullifier keys).
/// @notice Implemented by `TrusteeRegistry`, whose panels and identity keys
/// are pinned for good at its deployment.
interface ITrusteePanels {
    /// @notice A pinned panel's threshold `k`, size `n` and ceremony quorum;
    /// all zero for a panel it doesn't pin.
    function panelOf(bytes32 panelId)
        external
        view
        returns (uint8 threshold, uint8 size, uint8 quorum);

    /// @notice Seat `index`'s identity key as `(x, y)`; zero outside the panel.
    function keyOf(bytes32 panelId, uint256 index) external view returns (uint256 x, uint256 y);
}

/// @title The Tier 2 scope's nullifier-key statements and windows
/// (docs/spec/nullifier-key.md, Approval; docs/spec/nullifier-reshare.md,
/// Approval and Consent).
/// @notice Each statement is `u64(l2_chain_id) ‖ bytes[20](group_registry) ‖
/// panel_id ‖ u8(index) ‖ rest`, signed as `H(DS(tag, statement))` with `H`
/// SHA-256 and `DS(tag, m) = u8(len(tag)) ‖ tag ‖ m`
/// (docs/spec/domain-separation.md). The registry builds every statement
/// itself from the record and its own state, never from the submitter.
library NullifierKeyLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/nullifier-key-approval-3` (0x27 = 39).
    bytes internal constant DS_KEY_APPROVAL = "\x27abolish/v1/sig/nullifier-key-approval-3";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/nullifier-reshare-approval-2` (0x2b = 43).
    bytes internal constant DS_RESHARE_APPROVAL = "\x2babolish/v1/sig/nullifier-reshare-approval-2";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/nullifier-reshare-consent` (0x28 = 40).
    bytes internal constant DS_CONSENT = "\x28abolish/v1/sig/nullifier-reshare-consent";

    /// `MAX_KEY_WINDOW`: an initial key's deadline lies at most this many L2
    /// blocks after the block that records it (docs/spec/parameters.md).
    uint256 internal constant MAX_KEY_WINDOW = 302_400;
    /// `MAX_RESHARE_WINDOW`: the same bound for a reshare.
    uint256 internal constant MAX_RESHARE_WINDOW = 302_400;

    /// `u64(deadline) ‖ key_id ‖ u8(count)`.
    uint256 internal constant KEY_HEADER = 41;
    /// `predecessor ‖ new_panel_id ‖ u64(deadline) ‖ key_id ‖ u8(consents)`.
    uint256 internal constant RESHARE_HEADER = 105;
    /// `u8(index) ‖ p256-sig`.
    uint256 internal constant APPROVAL_LENGTH = 65;

    /// `H(DS(tag, u64(chainId) ‖ registry ‖ panel ‖ u8(index) ‖ rest))`.
    function digest(
        bytes memory ds,
        uint64 chainId,
        address registry,
        bytes32 panel,
        uint8 index,
        bytes memory rest
    ) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(ds, chainId, registry, panel, index, rest));
    }

    /// The initial key's approval after its index: `key_id ‖ u64(deadline)` (101 bytes in all).
    function keyApprovalRest(bytes32 keyId, uint64 deadline) internal pure returns (bytes memory) {
        return abi.encodePacked(keyId, deadline);
    }

    /// A successor's approval after its index: `predecessor ‖ key_id ‖
    /// u64(deadline)` (133 bytes in all).
    function reshareApprovalRest(bytes32 predecessor, bytes32 keyId, uint64 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(predecessor, keyId, deadline);
    }

    /// The old panel's consent after its index: `predecessor ‖ new_panel_id ‖
    /// key_id ‖ u64(deadline)` (165 bytes in all).
    function consentRest(bytes32 predecessor, bytes32 newPanel, bytes32 keyId, uint64 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(predecessor, newPanel, keyId, deadline);
    }

    /// A panel's quorum for a key, `max(k, n − 1)` (ADR 0006, rule 7),
    /// never the trustee registry's ceremony quorum.
    function quorum(uint8 threshold, uint8 size) internal pure returns (uint256) {
        uint256 others = size == 0 ? 0 : uint256(size) - 1;
        return threshold > others ? threshold : others;
    }
}
