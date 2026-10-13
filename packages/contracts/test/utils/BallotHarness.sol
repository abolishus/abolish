// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib, IElectionParameters} from "../../src/BallotCheck.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";

/// Exposes the ballot check to tests, with the record in calldata as the
/// board holds it.
contract BallotHarness {
    function check(bytes calldata record, IElectionParameters registry, uint256 qualified)
        external
        view
        returns (BallotCheckLib.Admitted memory)
    {
        return BallotCheckLib.check(record, registry, qualified);
    }

    /// The gas `check` used, measured inside the call so the harness's own
    /// calldata copying isn't counted.
    function checkGas(bytes calldata record, IElectionParameters registry, uint256 qualified)
        external
        view
        returns (uint256 used)
    {
        uint256 before = gasleft();
        BallotCheckLib.check(record, registry, qualified);
        used = before - gasleft();
    }

    /// Frames a committed vote alone, offsets counted from its first byte,
    /// and checks its shape against `p`.
    function vote(
        bytes calldata committedVote,
        uint8 version,
        ElectionRegistry.Parameters calldata p
    ) external pure returns (bool shapeOk) {
        BallotCheckLib.Layout memory l =
            BallotCheckLib.frameVote(committedVote, 0, version, p.threshold);
        return BallotCheckLib.shapeOk(committedVote, l, p, version);
    }

    /// The gas framing and the shape check used.
    function voteGas(
        bytes calldata committedVote,
        uint8 version,
        ElectionRegistry.Parameters calldata p
    ) external view returns (uint256 used) {
        uint256 before = gasleft();
        BallotCheckLib.Layout memory l =
            BallotCheckLib.frameVote(committedVote, 0, version, p.threshold);
        BallotCheckLib.shapeOk(committedVote, l, p, version);
        used = before - gasleft();
    }

    function ballotHash(bytes calldata record) external pure returns (bytes32) {
        return BallotCheckLib.ballotHash(record);
    }
}

/// The election registry's three parameter reads, set by the test from a
/// vector file's election, so the expected values come from the vectors
/// rather than from the registry's own derivation (which its tests cover).
contract ParametersStub is IElectionParameters {
    mapping(bytes32 => ElectionRegistry.Parameters) internal _parameters;
    mapping(bytes32 => uint8[]) internal _tiers;
    mapping(bytes32 => uint256[]) internal _roots;

    function set(
        bytes32 h,
        ElectionRegistry.Parameters memory p,
        uint8[] memory tiers,
        uint256[] memory roots
    ) external {
        ElectionRegistry.Parameters storage s = _parameters[h];
        s.ballotVersion = p.ballotVersion;
        s.threshold = p.threshold;
        s.panelSize = p.panelSize;
        s.optionCount = p.optionCount;
        s.cellCount = uint16(tiers.length);
        s.authorThreshold = p.authorThreshold;
        s.authorPanelSize = p.authorPanelSize;
        s.opensAt = p.opensAt;
        s.closesAt = p.closesAt;
        s.l1InclusionBound = p.l1InclusionBound;
        delete s.questions;
        for (uint256 i; i < p.questions.length; i++) {
            s.questions.push(p.questions[i]);
        }
        _tiers[h] = tiers;
        _roots[h] = roots;
    }

    function parameters(bytes32 h) external view returns (ElectionRegistry.Parameters memory) {
        return _parameters[h];
    }

    function cellTiers(bytes32 h) external view returns (uint8[] memory) {
        return _tiers[h];
    }

    function cell(bytes32 h, uint256 c) external view returns (uint8, uint256) {
        return (_tiers[h][c], _roots[h][c]);
    }
}
