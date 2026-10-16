// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {ElectionRegistry} from "./ElectionRegistry.sol";
import {MembershipProofLib} from "./MembershipProof.sol";

/// The election registry's view of what the board checks a ballot against
/// (docs/spec/contracts.md, Election registry, Parameters): the registry
/// implements it, and the board reads nothing about an election from anyone
/// else (ADR 0028, 1C; T-25, T-71).
interface IElectionParameters {
    function parameters(bytes32 definitionHash)
        external
        view
        returns (ElectionRegistry.Parameters memory);

    function cellTiers(bytes32 definitionHash) external view returns (uint8[] memory);

    function cell(bytes32 definitionHash, uint256 c) external view returns (uint8, uint256);
}

/// @title The board's ballot check (docs/spec/contracts.md, Board, Ballots).
/// @notice Checks a direct-submitted ballot record (type 0x0002, versions 1
/// to 3) against its registered definition's parameters, in the spec's
/// order: the header and the election it names, the version the election
/// pins, strict framing of every field, then `ballot-tier` (`ballot-cell`),
/// `validity-shape`, `share-hash-unqualified` and the membership proof over
/// `M`, which it recomputes from the record. It runs everything that needs
/// no ristretto255 arithmetic (ADR 0028, 3B): an element's encoding is
/// checked below `2²⁵⁵ − 19`, even and non-zero, the cheap part of RFC 9496's
/// `Decode`, and the validity proofs are framed but not verified. So it
/// refuses only records the verifier rejects, and never an honest ballot
/// (T-25), while what it admits that the verifier still rejects is bounded
/// to those fields (T-17). Every failure reverts.
library BallotCheckLib {
    /// Why a decoded ballot is refused: the admission codes of
    /// docs/spec/ballot-validity.md that the board checks, in its order.
    enum Code {
        BallotStray,
        BallotTier,
        BallotCell,
        ValidityShape,
        ShareHashUnqualified,
        MembershipProof
    }

    /// What an admitted ballot gives the board: the election it names, its
    /// cell and that cell's tier, its nullifier, `ballot_hash` and `M`, and
    /// the election's window, which the board's paths each test their own
    /// way (docs/spec/close.md, Window).
    struct Admitted {
        bytes32 definitionHash;
        uint8 version;
        uint8 cell;
        uint8 tier;
        uint256 nullifier;
        bytes32 ballotHash;
        bytes32 message;
        uint64 opensAt;
        uint64 closesAt;
    }

    /// Where the committed vote's lists start, and their counts, as framing
    /// found them.
    struct Layout {
        uint256 vssCount;
        /// Whether every option has exactly `k` VSS commitments.
        bool degreesK;
        uint256 shareHashesAt;
        uint256 shareCount;
        uint256 optionProofCount;
        /// The sum proof's (version 3: the range proofs') count field.
        uint256 sumAt;
    }

    error BallotMalformed(ElectionDefinitionLib.DecodeError code, uint256 offset);
    error BallotRefused(Code code);

    uint16 internal constant RECORD_TYPE = 0x0002;
    /// The highest record type docs/spec/versioning.md specifies as this
    /// library is written: every type from 0x0001 to it other than 0x0002 is
    /// `unexpected-record-type`, anything else `unknown-record-type`. A
    /// deployed board can't learn of later types.
    uint16 internal constant LAST_KNOWN_TYPE = 0x0017;
    /// The fixed offsets of docs/spec/ballot-validity.md, Ballot record,
    /// shared by versions 1 to 3.
    uint256 internal constant DEFINITION_AT = 3;
    uint256 internal constant TIER_AT = 35;
    uint256 internal constant NULLIFIER_AT = 36;
    uint256 internal constant L1_NUMBER_AT = 68;
    uint256 internal constant L1_HASH_AT = 76;
    uint256 internal constant PROOF_AT = 108;
    uint256 internal constant VOTE_AT = 364;
    uint256 internal constant MAX_OPTIONS = 64;
    uint256 internal constant MAX_TRUSTEES = 16;
    uint256 internal constant MAX_QUESTIONS = 32;
    /// `MAX_OPTIONS + 1`: a sum or range proof's branches.
    uint256 internal constant MAX_BRANCHES = 65;
    /// ristretto255's base field prime `2²⁵⁵ − 19`.
    uint256 internal constant P25519 =
        0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    /// ristretto255's group order `ℓ = 2²⁵² + 27742317777372353535851937790883648493`.
    uint256 internal constant L =
        0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/ballot` (0x11 = 17) and
    /// `abolish/v1/membership-message` (0x1d = 29).
    bytes internal constant DS_BALLOT = "\x11abolish/v1/ballot";
    bytes internal constant DS_MESSAGE = "\x1dabolish/v1/membership-message";

    /// Checks `record` as the board does, against the parameters `registry`
    /// recorded for the definition it names and `qualified`, the registered
    /// key set's seats as a bitmask (bit `i` for seat `i`, from 1). Returns
    /// what an admitted ballot gives; reverts with `BallotMalformed` or
    /// `BallotRefused` on the first failure. `view` for the registry's reads
    /// and the precompiles; it needs more than `MembershipProofLib.PAIRING_GAS`
    /// left once the proof is reached.
    function check(bytes calldata record, IElectionParameters registry, uint256 qualified)
        internal
        view
        returns (Admitted memory a)
    {
        (a,) = checkWithLayout(record, registry, qualified);
    }

    /// `check`, also returning the committed vote's layout, so the board's
    /// posting path finds the admitted ballot's share hashes without
    /// framing it twice.
    function checkWithLayout(bytes calldata record, IElectionParameters registry, uint256 qualified)
        internal
        view
        returns (Admitted memory a, Layout memory l)
    {
        ElectionRegistry.Parameters memory p;
        (p, l) = frame(record, registry, a);
        (a.opensAt, a.closesAt) = (p.opensAt, p.closesAt);
        uint256 named = _uint(record, TIER_AT, 1);

        uint256 root;
        (a.cell, a.tier, root) =
            _cell(registry, a.definitionHash, a.version, uint8(named), p.cellCount);
        if (!shapeOk(record, l, p, a.version)) revert BallotRefused(Code.ValidityShape);
        // A seat outside the registered key set gets no shares, so its hash
        // is fixed and carries no chosen bytes into the archive (T-17).
        for (uint256 seat = 1; seat <= p.panelSize; seat++) {
            if (
                (qualified >> seat) & 1 == 0
                    && _uint(record, l.shareHashesAt + 32 * (seat - 1), 32) != 0
            ) revert BallotRefused(Code.ShareHashUnqualified);
        }

        a.ballotHash = ballotHash(record);
        a.message = sha256(
            abi.encodePacked(
                DS_MESSAGE, a.definitionHash, a.tier, a.ballotHash, record[L1_NUMBER_AT:PROOF_AT]
            )
        );
        _membership(record, a, root);
    }

    /// Steps 1 to 5 of the check: the header, the election `record` names,
    /// the version it pins, the fixed fields and the committed vote, framed
    /// strictly. Fills `a`'s definition hash, version and nullifier and
    /// returns the election's parameters and the vote's layout; reverts with
    /// `BallotMalformed`, or `BallotRefused(BallotStray)`, on the first
    /// failure.
    function frame(bytes calldata record, IElectionParameters registry, Admitted memory a)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, Layout memory l)
    {
        uint256 v = _uint(record, 0, 2);
        if (v != RECORD_TYPE) {
            _malformed(
                v != 0 && v <= LAST_KNOWN_TYPE
                    ? ElectionDefinitionLib.DecodeError.UnexpectedRecordType
                    : ElectionDefinitionLib.DecodeError.UnknownRecordType,
                0
            );
        }
        uint8 version = uint8(_uint(record, 2, 1));
        a.definitionHash = bytes32(_uint(record, DEFINITION_AT, 32));
        // The election comes first: the version a record must have is the
        // one its election pins, so a record naming no registered election
        // is refused before its version means anything.
        p = registry.parameters(a.definitionHash);
        if (p.ballotVersion == 0) revert BallotRefused(Code.BallotStray);
        // notation.md: the pin is checked before asking whether the version
        // is known, so an unpinned version is `profile-mismatch`.
        if (version != p.ballotVersion) {
            _malformed(ElectionDefinitionLib.DecodeError.ProfileMismatch, 2);
        }
        // The registry doesn't yet refuse every profile combination
        // (contracts.md, Registration): a pin this library doesn't know
        // admits no ballot.
        if (version > 3) {
            _malformed(ElectionDefinitionLib.DecodeError.UnknownVersion, 2);
        }
        a.version = version;

        uint256 named = _uint(record, TIER_AT, 1);
        if (version == 1 && named > 2) {
            _malformed(ElectionDefinitionLib.DecodeError.InvalidEnum, TIER_AT);
        }
        a.nullifier = _uint(record, NULLIFIER_AT, 32);
        if (a.nullifier >= MembershipProofLib.R) {
            _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, NULLIFIER_AT);
        }
        _uint(record, L1_NUMBER_AT, 8);
        _uint(record, L1_HASH_AT, 32);
        // The proof's points are decoded as the proof is checked, last, by
        // MembershipProofLib; here only its length is read.
        if (record.length < VOTE_AT) {
            _malformed(ElectionDefinitionLib.DecodeError.Truncated, PROOF_AT);
        }
        l = frameVote(record, VOTE_AT, version, p.threshold);
    }

    /// `ballot_hash = H(DS("abolish/v1/ballot", definition_hash ‖ u16(0x0002)
    /// ‖ u8(version) ‖ u8(tier or cell) ‖ encode(nullifier) ‖
    /// encode(committed_vote)))` (docs/spec/ballot-validity.md, Ballot hash;
    /// Hashes (version 3)), from a framed record: every field but the
    /// membership proof and the L1 reference, which `M` binds.
    function ballotHash(bytes calldata record) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_BALLOT,
                record[DEFINITION_AT:TIER_AT],
                record[0:DEFINITION_AT],
                record[TIER_AT:L1_NUMBER_AT],
                record[VOTE_AT:]
            )
        );
    }

    /// `validity-shape` for a framed committed vote: `T` options of exactly
    /// `k` commitments, `n` share hashes, `T` option proofs, and `max − min +
    /// 1` sum-proof branches (version 3: one range proof per question, each
    /// with its question's). Ballot versions 1 and 2 have one question; one
    /// pinned beside a definition with several fits no shape.
    function shapeOk(
        bytes calldata record,
        Layout memory l,
        ElectionRegistry.Parameters memory p,
        uint8 version
    ) internal pure returns (bool) {
        if (
            l.vssCount != p.optionCount || !l.degreesK || l.shareCount != p.panelSize
                || l.optionProofCount != p.optionCount
        ) return false;
        uint256 count = _uint(record, l.sumAt, 4);
        if (version < 3) {
            if (p.questions.length != 1) return false;
            return count == _range(p.questions[0]);
        }
        if (count != p.questions.length) return false;
        uint256 o = l.sumAt + 4;
        for (uint256 q; q < count; q++) {
            uint256 branches = _uint(record, o, 4);
            if (branches != _range(p.questions[q])) return false;
            o += 4 + 64 * branches;
        }
        return true;
    }

    /// Frames the committed vote at `o` strictly (docs/spec/ballot-validity.md,
    /// Committed vote; Committed vote (version 3)): every count within its
    /// maximum before what it counts is read (T-52), every element's encoding
    /// framed, every scalar below `ℓ`, and nothing after the last field.
    /// Reverts with `BallotMalformed` at the first failure, left to right.
    function frameVote(bytes calldata r, uint256 o, uint8 version, uint256 k)
        internal
        pure
        returns (Layout memory l)
    {
        (l.vssCount, o) = _count(r, o, MAX_OPTIONS);
        l.degreesK = true;
        for (uint256 j; j < l.vssCount; j++) {
            uint256 degree;
            (degree, o) = _count(r, o, MAX_TRUSTEES);
            if (degree != k) l.degreesK = false;
            for (uint256 t; t < degree; t++) {
                o = _element(r, o);
            }
        }
        l.shareHashesAt = o + 4;
        (l.shareCount, o) = _count(r, o, MAX_TRUSTEES);
        for (uint256 i; i < l.shareCount; i++) {
            _uint(r, o, 32);
            o += 32;
        }
        (l.optionProofCount, o) = _count(r, o, MAX_OPTIONS);
        o = _scalars(r, o, 4 * l.optionProofCount);
        l.sumAt = o;
        uint256 count;
        if (version < 3) {
            (count, o) = _count(r, o, MAX_BRANCHES);
            o = _scalars(r, o, 2 * count);
        } else {
            (count, o) = _count(r, o, MAX_QUESTIONS);
            for (uint256 q; q < count; q++) {
                uint256 branches;
                (branches, o) = _count(r, o, MAX_BRANCHES);
                o = _scalars(r, o, 2 * branches);
            }
        }
        if (o != r.length) _malformed(ElectionDefinitionLib.DecodeError.TrailingBytes, o);
    }

    /// The cell the ballot names, its tier and its root. Version 1 names a
    /// tier, which must be exactly one cell's: a definition of a later
    /// version that splits the tier pins ballot version 2 or 3, and one that
    /// doesn't fails verifier 2.3, so nothing honest is refused.
    function _cell(
        IElectionParameters registry,
        bytes32 h,
        uint8 version,
        uint8 named,
        uint256 cellCount
    ) private view returns (uint8 c, uint8 tier, uint256 root) {
        if (version == 1) {
            uint8[] memory tiers = registry.cellTiers(h);
            uint256 found;
            for (uint256 i; i < tiers.length; i++) {
                if (tiers[i] == named) {
                    found++;
                    c = uint8(i);
                }
            }
            if (found != 1) revert BallotRefused(Code.BallotTier);
        } else {
            if (named >= cellCount) revert BallotRefused(Code.BallotCell);
            c = named;
        }
        (tier, root) = registry.cell(h, c);
    }

    /// The membership proof against `[ρ, ν, m̂, ŝ]`: the cell's root, the
    /// record's nullifier, `F(M)` and the scope of the cell's tier and root,
    /// none of them from the submitter (membership.md, Owned elsewhere;
    /// T-12, T-38). A broken point is the record's decode error at its
    /// offset; a root the registry recorded as 0 is refused as the proof,
    /// since anyone can prove membership of it (T-04).
    function _membership(bytes calldata record, Admitted memory a, uint256 root) private view {
        // The registry records only canonical roots of tiers 0 to 2; the
        // tier and `r` bounds keep `scope` from reverting with an error of
        // its own if that ever changed.
        if (root == 0 || root >= MembershipProofLib.R || a.tier > 2) {
            revert BallotRefused(Code.MembershipProof);
        }
        (MembershipProofLib.Verdict verdict, uint256 offset) = MembershipProofLib.check(
            record[PROOF_AT:VOTE_AT],
            MembershipProofLib.Signals({
                root: root,
                nullifier: a.nullifier,
                message: MembershipProofLib.field(a.message),
                scope: MembershipProofLib.scope(a.definitionHash, a.tier, root)
            })
        );
        if (verdict == MembershipProofLib.Verdict.NonCanonical) {
            _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, PROOF_AT + offset);
        }
        if (verdict != MembershipProofLib.Verdict.Valid) {
            revert BallotRefused(Code.MembershipProof);
        }
    }

    /// A question's branch count, `max − min + 1`; the registry's
    /// `selections` rule holds, so `min ≤ max`.
    function _range(ElectionRegistry.Question memory q) private pure returns (uint256) {
        return uint256(q.maxSelections) - q.minSelections + 1;
    }

    /// An `element` at `o`: 32 bytes whose little-endian value is below
    /// `2²⁵⁵ − 19`, even (RFC 9496 §4.3.1 rejects a negative `s`) and not the
    /// identity, which no VSS commitment is. Whether it decodes to a point
    /// needs a square root in that field, which is left to the verifier
    /// (ADR 0028, 3B).
    function _element(bytes calldata r, uint256 o) private pure returns (uint256) {
        uint256 s = reversed(_uint(r, o, 32));
        if (s == 0 || s >= P25519 || s & 1 == 1) {
            _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, o);
        }
        return o + 32;
    }

    /// `count` scalars at `o`, each 32 bytes little-endian below `ℓ`.
    function _scalars(bytes calldata r, uint256 o, uint256 count) private pure returns (uint256) {
        for (uint256 i; i < count; i++) {
            if (reversed(_uint(r, o, 32)) >= L) {
                _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, o);
            }
            o += 32;
        }
        return o;
    }

    /// A `list` count, checked against its maximum before any element is read (T-52).
    function _count(bytes calldata r, uint256 o, uint256 max)
        private
        pure
        returns (uint256 c, uint256 next)
    {
        c = _uint(r, o, 4);
        if (c > max) _malformed(ElectionDefinitionLib.DecodeError.LengthOverMax, o);
        next = o + 4;
    }

    /// The `n`-byte (1 ≤ n ≤ 32) big-endian integer at `o`; `truncated` at
    /// `o` if the record ends first.
    function _uint(bytes calldata r, uint256 o, uint256 n) private pure returns (uint256 v) {
        if (r.length < o + n) _malformed(ElectionDefinitionLib.DecodeError.Truncated, o);
        assembly ("memory-safe") {
            v := shr(sub(256, mul(n, 8)), calldataload(add(r.offset, o)))
        }
    }

    /// A 32-byte word with its bytes in reverse order: a little-endian
    /// encoding's value.
    function reversed(uint256 v) internal pure returns (uint256) {
        v = ((v >> 8) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
            | ((v & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8);
        v = ((v >> 16) & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
            | ((v & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16);
        v = ((v >> 32) & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
            | ((v & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32);
        v = ((v >> 64) & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff)
            | ((v & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64);
        return (v >> 128) | (v << 128);
    }

    function _malformed(ElectionDefinitionLib.DecodeError code, uint256 offset) private pure {
        revert BallotMalformed(code, offset);
    }
}
