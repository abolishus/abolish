// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// Stands in for the anchoring Safe in the deploy script's test
/// (test/deploy.test.ts), which etches its runtime code on Anvil: the two
/// getters the script reads, a 2-of-3.
contract MockSafe {
    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = address(0x5a1);
        owners[1] = address(0x5a2);
        owners[2] = address(0x5a3);
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

/// A 1-of-1 Safe: one key, which the deploy script refuses as the authority.
contract MockSoleOwnerSafe {
    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = address(0x5a1);
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }
}
