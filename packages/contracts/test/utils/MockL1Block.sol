// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {IL1Block} from "../../src/IL1Block.sol";

/// Stands in for the OP Stack's `L1Block` predeploy, which neither Foundry's
/// EVM nor Anvil has: tests etch its runtime code at the predeploy's address
/// and set the origin the next L2 block would carry.
contract MockL1Block is IL1Block {
    uint64 public number;
    uint64 public timestamp;
    bytes32 public hash;

    function set(uint64 number_, uint64 timestamp_, bytes32 hash_) external {
        number = number_;
        timestamp = timestamp_;
        hash = hash_;
    }
}
