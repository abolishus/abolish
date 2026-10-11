// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// The Foundry cheatcodes these tests use, declared by hand instead of
/// vendoring forge-std: a few signatures are easier to review than a vendored
/// library (contracts skill, Layout). Signatures follow Foundry's `Vm.sol`.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function assume(bool condition) external pure;
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes calldata revertData) external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function keyExistsJson(string calldata json, string calldata key) external view returns (bool);
    function load(address target, bytes32 slot) external view returns (bytes32 data);
    function parseBytes(string calldata stringifiedValue) external pure returns (bytes memory);
    function parseJsonString(string calldata json, string calldata key)
        external
        pure
        returns (string memory);
    function parseJsonStringArray(string calldata json, string calldata key)
        external
        pure
        returns (string[] memory);
    function parseUint(string calldata stringifiedValue) external pure returns (uint256);
    function readFile(string calldata path) external view returns (string memory data);
    function recordLogs() external;
    function toString(uint256 value) external pure returns (string memory);
}

/// Base for the test contracts: the cheatcode address and plain assertions
/// that revert with a message, which Foundry reports as a failed test.
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(bytes32 a, bytes32 b, string memory message) internal pure {
        if (a != b) revert(message);
    }

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        if (a != b) revert(message);
    }

    function assertTrue(bool condition, string memory message) internal pure {
        if (!condition) revert(message);
    }
}
