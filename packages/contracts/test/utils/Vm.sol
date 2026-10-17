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

    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function assume(bool condition) external pure;
    function chainId(uint256 newChainId) external;
    function clearMockedCalls() external;
    function cool(address target) external;
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
    function deal(address account, uint256 newBalance) external;
    function envOr(string calldata name, bool defaultValue) external view returns (bool value);
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes calldata revertData) external;
    function getNonce(address account) external view returns (uint64 nonce);
    function getRecordedLogs() external returns (Log[] memory logs);
    function keyExistsJson(string calldata json, string calldata key) external view returns (bool);
    function load(address target, bytes32 slot) external view returns (bytes32 data);
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
    function parseBytes(string calldata stringifiedValue) external pure returns (bytes memory);
    function parseJson(string calldata json, string calldata key)
        external
        pure
        returns (bytes memory abiEncodedData);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool);
    function parseJsonString(string calldata json, string calldata key)
        external
        pure
        returns (string memory);
    function parseJsonStringArray(string calldata json, string calldata key)
        external
        pure
        returns (string[] memory);
    function parseJsonUint(string calldata json, string calldata key)
        external
        pure
        returns (uint256);
    function parseJsonUintArray(string calldata json, string calldata key)
        external
        pure
        returns (uint256[] memory);
    function parseUint(string calldata stringifiedValue) external pure returns (uint256);
    function prank(address msgSender) external;
    function readFile(string calldata path) external view returns (string memory data);
    function recordLogs() external;
    function revertToState(uint256 snapshotId) external returns (bool success);
    function roll(uint256 newHeight) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function signP256(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (bytes32 r, bytes32 s);
    function snapshotState() external returns (uint256 snapshotId);
    function store(address target, bytes32 slot, bytes32 value) external;
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes calldata value) external pure returns (string memory);
    function txGasPrice(uint256 newGasPrice) external;
    function warp(uint256 newTimestamp) external;
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
