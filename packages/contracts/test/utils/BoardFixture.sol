// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {IBoardElections, IBoardTrustees} from "../../src/DeliveryCheck.sol";
import {ParametersStub} from "./BallotHarness.sol";

/// The election registry as the board reads it: the parameter reads of
/// `ParametersStub`, each definition's ceremony and its author key set's
/// seats, all set by the test from a vector file, so the expected values
/// come from the vectors rather than from the registry's own derivation
/// (which its tests cover).
contract ElectionsStub is ParametersStub, IBoardElections {
    mapping(bytes32 definitionHash => bytes32[2]) internal _ceremonies;
    mapping(bytes32 definitionHash => uint256) internal _authorSeats;

    function setCeremony(bytes32 h, bytes32 stubHash, bytes32 panelId) external {
        _ceremonies[h] = [stubHash, panelId];
    }

    function setAuthorKeySet(bytes32 h, uint256 seats) external {
        _authorSeats[h] = seats;
    }

    function ceremony(bytes32 h) external view returns (bytes32 stubHash, bytes32 panelId) {
        return (_ceremonies[h][0], _ceremonies[h][1]);
    }

    /// The hash is no key set's: the board reads only the seats.
    function authorKeySetOf(bytes32 h) external view returns (bytes32 keySetHash, uint256 seats) {
        seats = _authorSeats[h];
        keySetHash = seats == 0 ? bytes32(0) : keccak256(abi.encode(h, seats));
    }
}

/// The trustee registry as the board reads it: a registered key set's seats
/// (bit `i` for seat `i`) and each seat's signing key, per stub and panel,
/// set by the test from a vector file's panel.
contract TrusteesStub is IBoardTrustees {
    mapping(bytes32 stubHash => mapping(bytes32 panelId => uint256)) internal _seats;
    mapping(bytes32 stubHash => mapping(bytes32 panelId => mapping(uint256 => uint256[2]))) internal
        _keys;

    function setKeySet(bytes32 stubHash, bytes32 panelId, uint256 seats) external {
        _seats[stubHash][panelId] = seats;
    }

    function setKey(bytes32 stubHash, bytes32 panelId, uint256 seat, uint256 x, uint256 y)
        external
    {
        _keys[stubHash][panelId][seat] = [x, y];
    }

    /// The hash is no key set's: the board reads only the seats.
    function keySetOf(bytes32 stubHash, bytes32 panelId)
        external
        view
        returns (bytes32 keySetHash, uint256 seats)
    {
        seats = _seats[stubHash][panelId];
        keySetHash = seats == 0 ? bytes32(0) : keccak256(abi.encode(stubHash, panelId, seats));
    }

    function signingKeyOf(bytes32 stubHash, bytes32 panelId, uint256 index)
        external
        view
        returns (uint256 x, uint256 y)
    {
        uint256[2] storage q = _keys[stubHash][panelId][index];
        return (q[0], q[1]);
    }
}
