// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// The Foundry cheatcodes the deploy script uses, declared by hand as the
/// tests' are (test/utils/Vm.sol): a few signatures are easier to review than
/// a vendored forge-std. Signatures follow Foundry's `Vm.sol`.
interface ScriptVm {
    enum ForgeContext {
        TestGroup,
        Test,
        Coverage,
        Snapshot,
        ScriptGroup,
        ScriptDryRun,
        ScriptBroadcast,
        ScriptResume,
        Unknown
    }

    function isContext(ForgeContext context) external view returns (bool result);
    function activeFork() external view returns (uint256 forkId);
    function createFork(string calldata urlOrAlias) external returns (uint256 forkId);
    function selectFork(uint256 forkId) external;
    function readFile(string calldata path) external view returns (string memory data);
    function parseJsonBytes32(string calldata json, string calldata key)
        external
        pure
        returns (bytes32);
    function envString(string calldata name) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key)
        external
        pure
        returns (uint256);
    function parseJsonUintArray(string calldata json, string calldata key)
        external
        pure
        returns (uint256[] memory);
    function parseJsonAddress(string calldata json, string calldata key)
        external
        pure
        returns (address);
    function parseJsonAddressArray(string calldata json, string calldata key)
        external
        pure
        returns (address[] memory);
    function parseJsonBytes(string calldata json, string calldata key)
        external
        pure
        returns (bytes memory);
    function parseJsonString(string calldata json, string calldata key)
        external
        pure
        returns (string memory);
    function getCode(string calldata artifactPath) external view returns (bytes memory);
    function getNonce(address account) external view returns (uint64);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
    function writeFile(string calldata path, string calldata data) external;
    function projectRoot() external view returns (string memory);
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(bytes calldata value) external pure returns (string memory);
}
