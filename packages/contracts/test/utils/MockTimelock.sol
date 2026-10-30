// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// Stands in for the registration paymaster's admin, OpenZeppelin's
/// `TimelockController`, in the deploy script's test (test/deploy.test.ts),
/// which etches its runtime code on Anvil: the one getter the script reads.
contract MockTimelock {
    function getMinDelay() external pure returns (uint256) {
        return 2 days;
    }
}

/// A timelock with no delay: its proposer acts at once, as one key would.
contract MockNoDelayTimelock {
    function getMinDelay() external pure returns (uint256) {
        return 0;
    }
}
