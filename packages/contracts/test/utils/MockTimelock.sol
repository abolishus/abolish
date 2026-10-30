// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// Stands in for the registration paymaster's admin, OpenZeppelin's
/// `TimelockController`, in the deploy script's test (test/deploy.test.ts),
/// which etches its runtime code on Anvil: the getters the script reads. Its
/// Safe, the only proposer and canceller, is at `SAFE`.
contract MockTimelock {
    address internal constant SAFE = address(0xe05);

    function getMinDelay() external pure virtual returns (uint256) {
        return 2 days;
    }

    function hasRole(bytes32 role, address account) external pure virtual returns (bool) {
        return account == SAFE
            && (role == keccak256("PROPOSER_ROLE") || role == keccak256("CANCELLER_ROLE"));
    }
}

/// A timelock with no delay: its proposer acts at once, as one key would.
contract MockNoDelayTimelock is MockTimelock {
    function getMinDelay() external pure override returns (uint256) {
        return 0;
    }
}

/// A timelock whose roles are anyone's: every account holds every role.
contract MockOpenTimelock is MockTimelock {
    function hasRole(bytes32, address) external pure override returns (bool) {
        return true;
    }
}

/// A timelock whose Safe isn't its proposer.
contract MockUnproposedTimelock is MockTimelock {
    function hasRole(bytes32, address) external pure override returns (bool) {
        return false;
    }
}
