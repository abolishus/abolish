// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {GroupRegistry, GroupRegistryLib} from "../../src/GroupRegistry.sol";
import {Vm} from "./Vm.sol";

/// Exposes the library's internal functions and constants to the tests.
contract GroupHarness {
    function domainSeparator(uint256 chainId, address registry) external pure returns (bytes32) {
        return GroupRegistryLib.domainSeparator(chainId, registry);
    }

    function addMembersHash(uint64 groupId, uint8 tier, uint64 firstIndex, bytes32 commitmentsHash)
        external
        pure
        returns (bytes32)
    {
        return GroupRegistryLib.addMembersHash(groupId, tier, firstIndex, commitmentsHash);
    }

    function removeMembersHash(uint64 groupId, uint8 tier, uint64 size, bytes32 indicesHash)
        external
        pure
        returns (bytes32)
    {
        return GroupRegistryLib.removeMembersHash(groupId, tier, size, indicesHash);
    }

    function digest(bytes32 separator, bytes32 structHash) external pure returns (bytes32) {
        return GroupRegistryLib.digest(separator, structHash);
    }

    function forbidden(uint256 c) external pure returns (bool) {
        return GroupRegistryLib.forbidden(c);
    }

    function typeHashes()
        external
        pure
        returns (bytes32 domain, bytes32 addMembers, bytes32 removeMembers)
    {
        return (
            GroupRegistryLib.DOMAIN_TYPEHASH,
            GroupRegistryLib.ADD_MEMBERS_TYPEHASH,
            GroupRegistryLib.REMOVE_MEMBERS_TYPEHASH
        );
    }
}

/// Registrar keys, signed records and registry state for the group registry
/// tests. The keys are the test keys of docs/spec/vectors/group-registry.json
/// (produced by an independent Python implementation); signatures are made
/// by Foundry's `sign`, normalised to low s.
library GroupFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant VECTORS = "../../docs/spec/vectors/group-registry.json";

    /// The vectors' domain: Base Sepolia, and the first contract Anvil's
    /// first default account deploys (CREATE from `DEPLOYER` at nonce 0).
    uint256 internal constant VECTOR_CHAIN_ID = 84532;
    address internal constant VECTOR_REGISTRY = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    /// Storage slots of `GroupRegistry` (`forge inspect GroupRegistry storageLayout`).
    uint256 internal constant GROUP_COUNT_SLOT = 1;
    uint256 internal constant GROUPS_SLOT = 2;

    /// One registrar's signature, as the record carries it.
    struct Approval {
        uint8 seat;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /// The vectors' registrar keys, in seat order, and their threshold.
    function keys(string memory json)
        internal
        pure
        returns (uint256[] memory secrets, address[] memory addrs, uint8 threshold)
    {
        string[] memory sk = vm.parseJsonStringArray(json, ".registrars.secretKeys");
        string[] memory ad = vm.parseJsonStringArray(json, ".registrars.addresses");
        secrets = new uint256[](sk.length);
        addrs = new address[](ad.length);
        for (uint256 i; i < sk.length; i++) {
            secrets[i] = vm.parseUint(string.concat("0x", sk[i]));
            addrs[i] = address(bytes20(vm.parseBytes(ad[i])));
        }
        threshold = uint8(vm.parseJsonUint(json, ".registrars.threshold"));
    }

    function outsider(string memory json) internal pure returns (uint256) {
        return vm.parseUint(
            string.concat("0x", vm.parseJsonString(json, ".registrars.outsiderSecretKey"))
        );
    }

    /// A low-s signature by `sk` on `digest` (EIP-2).
    function sign(uint8 seat, uint256 sk, bytes32 digest) internal pure returns (Approval memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sk, digest);
        if (uint256(s) > GroupRegistryLib.HALF_N) {
            s = bytes32(GroupRegistryLib.N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        return Approval(seat, r, s, v);
    }

    /// The `AddMembers` digest `registry` checks for this batch.
    function addDigest(
        GroupRegistry registry,
        uint64 groupId,
        uint8 tier,
        uint64 firstIndex,
        uint256[] memory commitments
    ) internal view returns (bytes32) {
        return GroupRegistryLib.digest(
            registry.domainSeparator(),
            GroupRegistryLib.addMembersHash(
                groupId, tier, firstIndex, keccak256(abi.encodePacked(commitments))
            )
        );
    }

    /// The `RemoveMembers` digest `registry` checks for these indices,
    /// signed at member count `size`.
    function removeDigest(
        GroupRegistry registry,
        uint64 groupId,
        uint8 tier,
        uint64 size,
        uint64[] memory indices
    ) internal view returns (bytes32) {
        uint256[] memory words = new uint256[](indices.length);
        for (uint256 i; i < indices.length; i++) {
            words[i] = indices[i];
        }
        return GroupRegistryLib.digest(
            registry.domainSeparator(),
            GroupRegistryLib.removeMembersHash(
                groupId, tier, size, keccak256(abi.encodePacked(words))
            )
        );
    }

    /// Approvals by `seats` (1-based, in the order given) on `digest`.
    function approve(uint256[] memory secrets, uint8[] memory seats, bytes32 digest)
        internal
        pure
        returns (Approval[] memory a)
    {
        a = new Approval[](seats.length);
        for (uint256 i; i < seats.length; i++) {
            a[i] = sign(seats[i], secrets[seats[i] - 1], digest);
        }
    }

    /// `u64(group_id) ‖ u64(first_index) ‖ u16(count) ‖ commitments ‖
    /// u8(approvals) ‖ approvals × (u8(seat) ‖ r ‖ s ‖ u8(v))`.
    function encodeAdd(
        uint64 groupId,
        uint64 firstIndex,
        uint256[] memory commitments,
        Approval[] memory a
    ) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(groupId, firstIndex, uint16(commitments.length), commitments),
            _approvals(a)
        );
    }

    /// `u64(group_id) ‖ u64(size) ‖ u16(count) ‖ u64(index) × count ‖
    /// u8(approvals) ‖ approvals`.
    function encodeRemove(uint64 groupId, uint64 size, uint64[] memory indices, Approval[] memory a)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(groupId, size, uint16(indices.length));
        for (uint256 i; i < indices.length; i++) {
            out = abi.encodePacked(out, indices[i]);
        }
        out = bytes.concat(out, _approvals(a));
    }

    /// A signed addition of `commitments` to `groupId` at its current count.
    function addition(
        GroupRegistry registry,
        uint256[] memory secrets,
        uint8[] memory seats,
        uint64 groupId,
        uint256[] memory commitments
    ) internal view returns (bytes memory) {
        (uint8 tier,, uint64 count) = registry.groupOf(groupId);
        bytes32 d = addDigest(registry, groupId, tier, count, commitments);
        return encodeAdd(groupId, count, commitments, approve(secrets, seats, d));
    }

    /// A signed removal of `indices` from `groupId`, at its current count.
    function removal(
        GroupRegistry registry,
        uint256[] memory secrets,
        uint8[] memory seats,
        uint64 groupId,
        uint64[] memory indices
    ) internal view returns (bytes memory) {
        (,, uint64 count) = registry.groupOf(groupId);
        return removalAt(registry, secrets, seats, groupId, count, indices);
    }

    /// A signed removal of `indices` from `groupId`, signed at `size`.
    function removalAt(
        GroupRegistry registry,
        uint256[] memory secrets,
        uint8[] memory seats,
        uint64 groupId,
        uint64 size,
        uint64[] memory indices
    ) internal view returns (bytes memory) {
        (uint8 tier,,) = registry.groupOf(groupId);
        bytes32 d = removeDigest(registry, groupId, tier, size, indices);
        return encodeRemove(groupId, size, indices, approve(secrets, seats, d));
    }

    /// `count` distinct valid commitments derived from `seed`.
    function commitments(uint256 seed, uint256 count) internal pure returns (uint256[] memory c) {
        c = new uint256[](count);
        for (uint256 i; i < count; i++) {
            c[i] = uint256(keccak256(abi.encode("commitment", seed, i))) % GroupRegistryLib.R;
            // Never one of the forbidden values (probability ~2⁻²⁵⁰, but exact).
            if (c[i] <= 1 || c[i] == GroupRegistryLib.POSEIDON2_0_1) c[i] = 2 + i;
        }
    }

    /// Sets a group's record directly, for states no test can reach by
    /// calls (group 2⁶⁴ − 1, a count near 2³², a tier the registry refuses).
    function setGroup(
        GroupRegistry registry,
        uint64 groupId,
        uint8 tier,
        bool exists,
        uint64 memberCount
    ) internal {
        bytes32 slot = keccak256(abi.encode(uint256(groupId), GROUPS_SLOT));
        uint256 packed =
            uint256(memberCount) | (uint256(tier) << 64) | (exists ? uint256(1) << 72 : 0);
        vm.store(address(registry), slot, bytes32(packed));
        (uint8 t, bool e, uint64 c) = registry.groupOf(groupId);
        require(t == tier && e == exists && c == memberCount, "group slot layout");
    }

    function setGroupCount(GroupRegistry registry, uint256 count) internal {
        vm.store(address(registry), bytes32(GROUP_COUNT_SLOT), bytes32(count));
        require(registry.groupCount() == count, "group count slot layout");
    }

    function seats(uint8 a, uint8 b) internal pure returns (uint8[] memory s) {
        s = new uint8[](2);
        (s[0], s[1]) = (a, b);
    }

    function seats(uint8 a, uint8 b, uint8 c) internal pure returns (uint8[] memory s) {
        s = new uint8[](3);
        (s[0], s[1], s[2]) = (a, b, c);
    }

    function indices(uint64 a) internal pure returns (uint64[] memory x) {
        x = new uint64[](1);
        x[0] = a;
    }

    function indices(uint64 a, uint64 b) internal pure returns (uint64[] memory x) {
        x = new uint64[](2);
        (x[0], x[1]) = (a, b);
    }

    function _approvals(Approval[] memory a) private pure returns (bytes memory out) {
        out = abi.encodePacked(uint8(a.length));
        for (uint256 i; i < a.length; i++) {
            out = abi.encodePacked(out, a[i].seat, a[i].r, a[i].s, a[i].v);
        }
    }
}
