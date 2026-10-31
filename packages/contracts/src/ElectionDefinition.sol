// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title The election definition, record type 0x0001 versions 1 and 3 to 7
/// (docs/spec/election-definition.md).
/// @notice A strict decoder, the well-formedness rules, and the definition and
/// stub hashes, so the election registry admits only definitions that decode
/// under the spec and are well formed (T-17, T-31, T-34). `H` is SHA-256
/// through the EVM precompile, over `DS(tag, m) = u8(len(tag)) ‖ tag ‖ m`
/// (docs/spec/domain-separation.md).
library ElectionDefinitionLib {
    /// The decode error codes of docs/spec/notation.md (Strict decoding), in
    /// the order a vector file names them.
    enum DecodeError {
        Truncated,
        TrailingBytes,
        LengthOverMax,
        UnknownRecordType,
        UnexpectedRecordType,
        UnknownVersion,
        InvalidEnum,
        NonCanonical,
        ProfileMismatch
    }

    /// The well-formedness rules of docs/spec/election-definition.md, in
    /// checking order. `None` means well formed. Each version checks only the
    /// rules its layout has.
    enum Rule {
        None,
        ProtocolMajor,
        ProfileOrder,
        ProfileTypes,
        ProfileVersion,
        Questions,
        OptionCount,
        Selections,
        Electorate,
        Cells,
        Panel,
        Chain,
        Timing,
        ReceiptKeys,
        Results,
        CivicSealed,
        AuthorPanel,
        RollingClass,
        RollingTier
    }

    struct TierGroup {
        uint8 tier;
        uint64 groupId;
        uint256 root;
        uint64 rootL2Block;
        uint64 groupSize;
    }

    /// Version 3 to 6's `region_group`.
    struct RegionGroup {
        uint64 groupId;
        uint16 region;
    }

    /// Version 3 to 6's `cell`.
    struct Cell {
        uint256 root;
        uint64 members;
    }

    /// Version 3 to 6's `tier_electorate`: a tier's groups, its regions'
    /// member counts and its cells.
    struct TierElectorate {
        uint8 tier;
        uint64 rootL2Block;
        RegionGroup[] groups;
        uint64[] regions;
        Cell[] cells;
    }

    /// Version 7's `rolling_tier`: a tier whose ballots prove against step
    /// roots of its groups' additions (docs/spec/election-definition.md,
    /// Rolling electorates).
    struct RollingTier {
        uint8 tier;
        uint64 rootL2Block;
        uint64[] groups;
        uint256 root;
        uint64 groupSize;
    }

    /// Version 5 to 7's `question`.
    struct Question {
        uint8 method;
        uint16 optionCount;
        uint16 minSelections;
        uint16 maxSelections;
    }

    /// A `p256-key`, `prefix ‖ x`: comparing (prefix, x) in that order
    /// compares the 33-byte encodings.
    struct P256Key {
        uint8 prefix;
        bytes32 x;
    }

    /// Every version's fields. A field a version's layout doesn't have is
    /// zero or empty: `electionType` to `maxSelections` are versions 1, 3
    /// and 4's, `questions` 5 to 7's; `electorate` is version 1's,
    /// `tiers` 3 to 7's; `receiptKeys` 4 to 7's; `pollClass` to
    /// `authorTranscriptHash` 6 and 7's; `electorateMode` and `rolling` 7's.
    struct Definition {
        uint8 version;
        uint8 protocolMajor;
        uint16[] pinTypes;
        uint8[] pinVersions;
        bytes32 electionId;
        uint64 l2ChainId;
        uint64 l1ChainId;
        address electionRegistry;
        address board;
        address trusteeRegistry;
        address groupRegistry;
        address l1Anchor;
        address l1Relay;
        uint8 electionType;
        uint8 tallyScheme;
        uint16 optionCount;
        uint16 minSelections;
        uint16 maxSelections;
        Question[] questions;
        TierGroup[] electorate;
        TierElectorate[] tiers;
        bytes32 membershipVkHash;
        bytes32 panelId;
        uint8 threshold;
        uint8 panelSize;
        bytes32 ceremonyTranscriptHash;
        uint64 opensAt;
        uint64 closesAt;
        uint32 l1InclusionBound;
        uint64 sequencingWindow;
        uint64 maxSequencerDrift;
        bytes32 displayTextCommitment;
        P256Key[] receiptKeys;
        uint8 pollClass;
        uint8 resultsMode;
        uint32 liveEvery;
        uint32 liveBatch;
        uint8 authorThreshold;
        P256Key[] authorKeys;
        bytes32 authorTranscriptHash;
        uint8 electorateMode;
        RollingTier[] rolling;
        /// Where `ceremony_transcript_hash` starts in the encoding, for the stub hash.
        uint256 transcriptOffset;
        /// Where `author_transcript_hash` starts, for the author stub hash:
        /// version 6's last field, but version 7's fields follow it.
        uint256 authorTranscriptOffset;
    }

    error DefinitionMalformed(DecodeError code, uint256 offset);

    uint16 internal constant RECORD_TYPE = 0x0001;
    uint256 internal constant MAX_PINS = 64;
    uint256 internal constant MAX_TIERS = 3;
    // The limits of versions 1 to 7, written out: raising a protocol-wide
    // limit is a new record version (docs/spec/parameters.md), so no
    // version's limits ever change.
    uint256 internal constant MAX_OPTIONS = 64;
    uint256 internal constant MAX_TRUSTEES = 16;
    uint256 internal constant MAX_GROUPS = 1024;
    uint256 internal constant MAX_REGIONS = 1024;
    /// Per tier's `cells` list, and in the whole definition (the rule `cells`).
    uint256 internal constant MAX_CELLS = 256;
    uint256 internal constant MAX_RECEIPT_KEYS = 4;
    uint256 internal constant MAX_QUESTIONS = 32;
    /// `MIN_CELL_ELECTORATE`, the fold's floor (docs/spec/parameters.md).
    uint256 internal constant MIN_CELL_ELECTORATE = 1000;
    /// `MIN_LIVE_BATCH` (docs/spec/parameters.md).
    uint256 internal constant MIN_LIVE_BATCH = 20;
    uint8 internal constant PLURALITY = 1;
    uint8 internal constant APPROVAL = 2;
    uint8 internal constant CIVIC = 3;
    uint8 internal constant SEALED = 1;
    uint8 internal constant EVERYDAY = 1;
    uint8 internal constant ROLLING = 2;
    /// `(p + 1) / 4` for P-256's prime `p` (OpenZeppelin's `P256.P`):
    /// `p ≡ 3 (mod 4)`, so `a^((p + 1) / 4)` is a square root of `a`
    /// whenever `a` has one.
    uint256 internal constant P256_SQRT_EXPONENT = (P256.P + 1) / 4;
    /// The BN254 scalar field modulus `r` (docs/spec/notation.md, `field<bn254>`).
    uint256 internal constant BN254_R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    /// `u8(len(tag)) ‖ tag` for the two hashes (0x1e = 30, 0x18 = 24).
    bytes internal constant DS_DEFINITION = "\x1eabolish/v1/election-definition";
    bytes internal constant DS_STUB = "\x18abolish/v1/election-stub";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/author-panel` (0x17 = 23).
    bytes internal constant DS_AUTHOR_PANEL = "\x17abolish/v1/author-panel";

    // --- decoding ----------------------------------------------------------

    /// Decodes `d` strictly as record type 0x0001 under the layout its
    /// version byte names (1, or 3 to 7; 2 is never assigned), then checks
    /// the definition's own profile pins exactly that version
    /// (docs/spec/election-definition.md, Decoding). Reverts with the first
    /// failure, left to right. `view` only for the `ModExp` precompile, which
    /// checks a key's `x` is on the curve.
    function decode(bytes calldata d) internal view returns (Definition memory def) {
        uint256 o;
        uint256 v;
        (v, o) = _uint(d, o, 2);
        if (v != RECORD_TYPE) {
            // The contract can't learn of record types specified after it is
            // deployed, so it knows the specified types as of version 1's
            // freeze (docs/spec/versioning.md): 0x0007 and 0x0009 are
            // unexpected here, and anything else is unknown.
            revert DefinitionMalformed(
                v == 0x0007 || v == 0x0009
                    ? DecodeError.UnexpectedRecordType
                    : DecodeError.UnknownRecordType,
                0
            );
        }
        (v, o) = _uint(d, o, 1);
        if (v != 1 && (v < 3 || v > 7)) revert DefinitionMalformed(DecodeError.UnknownVersion, 2);
        def.version = uint8(v);

        o = _decodeHead(d, o, def);
        if (def.version < 5) {
            (v, o) = _enum(d, o, PLURALITY, APPROVAL);
            def.electionType = uint8(v);
            (v, o) = _enum(d, o, 1, 1);
            def.tallyScheme = uint8(v);
            (v, o) = _uint(d, o, 2);
            def.optionCount = uint16(v);
            (v, o) = _uint(d, o, 2);
            def.minSelections = uint16(v);
            (v, o) = _uint(d, o, 2);
            def.maxSelections = uint16(v);
        } else {
            o = _decodeQuestions(d, o, def);
            (v, o) = _enum(d, o, 1, 1);
            def.tallyScheme = uint8(v);
        }
        o = def.version == 1 ? _decodeElectorate(d, o, def) : _decodeTiers(d, o, def);
        o = _decodeTail(d, o, def);
        if (def.version >= 4) (def.receiptKeys, o) = _keys(d, o, MAX_RECEIPT_KEYS);
        if (def.version >= 6) o = _decodeV6(d, o, def);
        if (def.version == 7) o = _decodeRolling(d, o, def);
        if (o != d.length) revert DefinitionMalformed(DecodeError.TrailingBytes, o);

        // Step 2: exactly one pin for 0x0001, at the record's own version,
        // wherever it appears (T-34, T-31).
        uint256 own;
        bool atVersion;
        for (uint256 i; i < def.pinTypes.length; i++) {
            if (def.pinTypes[i] == RECORD_TYPE) {
                own++;
                atVersion = def.pinVersions[i] == def.version;
            }
        }
        if (own != 1 || !atVersion) revert DefinitionMalformed(DecodeError.ProfileMismatch, 0);
    }

    /// The profile, `election_id`, the chain IDs and the six addresses.
    function _decodeHead(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 v;
        (v, o) = _uint(d, o, 1);
        def.protocolMajor = uint8(v);
        uint256 count;
        (count, o) = _count(d, o, MAX_PINS);
        def.pinTypes = new uint16[](count);
        def.pinVersions = new uint8[](count);
        for (uint256 i; i < count; i++) {
            (v, o) = _uint(d, o, 2);
            def.pinTypes[i] = uint16(v);
            (v, o) = _uint(d, o, 1);
            def.pinVersions[i] = uint8(v);
        }

        (v, o) = _uint(d, o, 32);
        def.electionId = bytes32(v);
        (v, o) = _uint(d, o, 8);
        def.l2ChainId = uint64(v);
        (v, o) = _uint(d, o, 8);
        def.l1ChainId = uint64(v);
        (def.electionRegistry, o) = _address(d, o);
        (def.board, o) = _address(d, o);
        (def.trusteeRegistry, o) = _address(d, o);
        (def.groupRegistry, o) = _address(d, o);
        (def.l1Anchor, o) = _address(d, o);
        (def.l1Relay, o) = _address(d, o);
        return o;
    }

    /// Version 5 to 7's `questions`.
    function _decodeQuestions(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 count;
        (count, o) = _count(d, o, MAX_QUESTIONS);
        def.questions = new Question[](count);
        uint256 v;
        for (uint256 i; i < count; i++) {
            Question memory q = def.questions[i];
            (v, o) = _enum(d, o, 1, 1);
            q.method = uint8(v);
            (v, o) = _uint(d, o, 2);
            q.optionCount = uint16(v);
            (v, o) = _uint(d, o, 2);
            q.minSelections = uint16(v);
            (v, o) = _uint(d, o, 2);
            q.maxSelections = uint16(v);
        }
        return o;
    }

    /// Version 1's `electorate`.
    function _decodeElectorate(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 count;
        uint256 v;
        (count, o) = _count(d, o, MAX_TIERS);
        def.electorate = new TierGroup[](count);
        for (uint256 i; i < count; i++) {
            TierGroup memory g = def.electorate[i];
            (v, o) = _enum(d, o, 0, 2);
            g.tier = uint8(v);
            (v, o) = _uint(d, o, 8);
            g.groupId = uint64(v);
            (g.root, o) = _field(d, o);
            (v, o) = _uint(d, o, 8);
            g.rootL2Block = uint64(v);
            (v, o) = _uint(d, o, 8);
            g.groupSize = uint64(v);
        }
        return o;
    }

    /// Version 3 to 7's `electorate`, a list of `tier_electorate`.
    function _decodeTiers(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 count;
        (count, o) = _count(d, o, MAX_TIERS);
        def.tiers = new TierElectorate[](count);
        for (uint256 i; i < count; i++) {
            o = _decodeTier(d, o, def.tiers[i]);
        }
        return o;
    }

    function _decodeTier(bytes calldata d, uint256 o, TierElectorate memory t)
        private
        pure
        returns (uint256)
    {
        uint256 count;
        uint256 v;
        (v, o) = _enum(d, o, 0, 2);
        t.tier = uint8(v);
        (v, o) = _uint(d, o, 8);
        t.rootL2Block = uint64(v);
        (count, o) = _count(d, o, MAX_GROUPS);
        t.groups = new RegionGroup[](count);
        for (uint256 j; j < count; j++) {
            (v, o) = _uint(d, o, 8);
            t.groups[j].groupId = uint64(v);
            (v, o) = _uint(d, o, 2);
            t.groups[j].region = uint16(v);
        }
        (count, o) = _count(d, o, MAX_REGIONS);
        t.regions = new uint64[](count);
        for (uint256 j; j < count; j++) {
            (v, o) = _uint(d, o, 8);
            t.regions[j] = uint64(v);
        }
        (count, o) = _count(d, o, MAX_CELLS);
        t.cells = new Cell[](count);
        for (uint256 j; j < count; j++) {
            (t.cells[j].root, o) = _field(d, o);
            (v, o) = _uint(d, o, 8);
            t.cells[j].members = uint64(v);
        }
        return o;
    }

    /// Every version's fields from `membership_vk_hash` to
    /// `display_text_commitment`.
    function _decodeTail(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 v;
        (v, o) = _uint(d, o, 32);
        def.membershipVkHash = bytes32(v);
        (v, o) = _uint(d, o, 32);
        def.panelId = bytes32(v);
        (v, o) = _uint(d, o, 1);
        def.threshold = uint8(v);
        (v, o) = _uint(d, o, 1);
        def.panelSize = uint8(v);
        def.transcriptOffset = o;
        (v, o) = _uint(d, o, 32);
        def.ceremonyTranscriptHash = bytes32(v);
        (v, o) = _uint(d, o, 8);
        def.opensAt = uint64(v);
        (v, o) = _uint(d, o, 8);
        def.closesAt = uint64(v);
        (v, o) = _uint(d, o, 4);
        def.l1InclusionBound = uint32(v);
        (v, o) = _uint(d, o, 8);
        def.sequencingWindow = uint64(v);
        (v, o) = _uint(d, o, 8);
        def.maxSequencerDrift = uint64(v);
        (v, o) = _uint(d, o, 32);
        def.displayTextCommitment = bytes32(v);
        return o;
    }

    /// Version 6's fields after `receipt_keys`, which version 7 has too.
    function _decodeV6(bytes calldata d, uint256 o, Definition memory def)
        private
        view
        returns (uint256)
    {
        uint256 v;
        (v, o) = _enum(d, o, 1, 3);
        def.pollClass = uint8(v);
        (v, o) = _enum(d, o, 1, 2);
        def.resultsMode = uint8(v);
        (v, o) = _uint(d, o, 4);
        def.liveEvery = uint32(v);
        (v, o) = _uint(d, o, 4);
        def.liveBatch = uint32(v);
        (v, o) = _uint(d, o, 1);
        def.authorThreshold = uint8(v);
        (def.authorKeys, o) = _keys(d, o, MAX_TRUSTEES);
        def.authorTranscriptOffset = o;
        (v, o) = _uint(d, o, 32);
        def.authorTranscriptHash = bytes32(v);
        return o;
    }

    /// Version 7's `electorate_mode` and `rolling_electorate`, after
    /// `author_transcript_hash`.
    function _decodeRolling(bytes calldata d, uint256 o, Definition memory def)
        private
        pure
        returns (uint256)
    {
        uint256 v;
        uint256 count;
        (v, o) = _enum(d, o, 1, ROLLING);
        def.electorateMode = uint8(v);
        (count, o) = _count(d, o, MAX_TIERS);
        def.rolling = new RollingTier[](count);
        for (uint256 i; i < count; i++) {
            RollingTier memory t = def.rolling[i];
            (v, o) = _enum(d, o, 0, 2);
            t.tier = uint8(v);
            (v, o) = _uint(d, o, 8);
            t.rootL2Block = uint64(v);
            uint256 groups;
            (groups, o) = _count(d, o, MAX_GROUPS);
            t.groups = new uint64[](groups);
            for (uint256 j; j < groups; j++) {
                (v, o) = _uint(d, o, 8);
                t.groups[j] = uint64(v);
            }
            (t.root, o) = _field(d, o);
            (v, o) = _uint(d, o, 8);
            t.groupSize = uint64(v);
        }
        return o;
    }

    /// A `list<p256-key, max>`. A key is canonical if its prefix is `0x02` or
    /// `0x03` and `x < p` is the `x` of a point on the curve, which is exactly
    /// when the candidate square root of `x³ − 3x + b` that `ModExp` gives
    /// passes OpenZeppelin's on-curve check (`P256.isValidPublicKey`); the
    /// prefix picks one of that `x`'s two points, so either parity is valid
    /// and every encoding names one point (docs/spec/trustee-identity.md,
    /// Identity key; T-31). Anything else is `non-canonical` at the key.
    function _keys(bytes calldata d, uint256 o, uint256 max)
        private
        view
        returns (P256Key[] memory keys, uint256)
    {
        uint256 count;
        (count, o) = _count(d, o, max);
        keys = new P256Key[](count);
        for (uint256 i; i < count; i++) {
            if (d.length - o < 33) revert DefinitionMalformed(DecodeError.Truncated, o);
            uint256 prefix;
            uint256 x;
            (prefix,) = _uint(d, o, 1);
            (x,) = _uint(d, o + 1, 32);
            if ((prefix != 2 && prefix != 3) || !_onCurve(x)) {
                revert DefinitionMalformed(DecodeError.NonCanonical, o);
            }
            keys[i] = P256Key(uint8(prefix), bytes32(x));
            o += 33;
        }
        return (keys, o);
    }

    /// Whether some point of P-256 has this `x`.
    function _onCurve(uint256 x) private view returns (bool) {
        if (x >= P256.P) return false;
        return P256.isValidPublicKey(bytes32(x), bytes32(_candidateY(x)));
    }

    /// The candidate square root of `x³ + ax + b`, as `P256.isValidPublicKey`
    /// computes the right-hand side: a `y` of the point with this `x` when
    /// there is one.
    function _candidateY(uint256 x) private view returns (uint256) {
        uint256 p = P256.P;
        uint256 rhs = addmod(mulmod(addmod(mulmod(x, x, p), P256.A, p), x, p), P256.B, p);
        return Math.modExp(rhs, P256_SQRT_EXPONENT, p);
    }

    /// The point `(x, y)` of a decoded `p256-key`: the decoder admitted only
    /// keys whose `x` is a point's, so `y` is the candidate root or its
    /// negation, whichever has the prefix's parity (`0x02` even, `0x03` odd).
    /// P-256 has no point with `y = 0`, so the two always differ in parity.
    function point(P256Key memory key) internal view returns (uint256 x, uint256 y) {
        x = uint256(key.x);
        y = _candidateY(x);
        if (y & 1 != uint256(key.prefix) - 2) y = P256.P - y;
    }

    /// A `field<bn254>`: T-04, T-31, one encoding per field element.
    function _field(bytes calldata d, uint256 o) private pure returns (uint256 v, uint256 next) {
        (v, next) = _uint(d, o, 32);
        if (v >= BN254_R) revert DefinitionMalformed(DecodeError.NonCanonical, o);
    }

    /// The `n`-byte (1 ≤ n ≤ 32) big-endian integer at `o`, and the offset after it.
    function _uint(bytes calldata d, uint256 o, uint256 n)
        private
        pure
        returns (uint256 v, uint256 next)
    {
        if (d.length - o < n) revert DefinitionMalformed(DecodeError.Truncated, o);
        assembly ("memory-safe") {
            v := shr(sub(256, mul(n, 8)), calldataload(add(d.offset, o)))
        }
        next = o + n;
    }

    function _address(bytes calldata d, uint256 o) private pure returns (address a, uint256 next) {
        uint256 v;
        (v, next) = _uint(d, o, 20);
        a = address(uint160(v));
    }

    /// An `enum8` whose allowed values are `lo` to `hi`.
    function _enum(bytes calldata d, uint256 o, uint256 lo, uint256 hi)
        private
        pure
        returns (uint256 v, uint256 next)
    {
        (v, next) = _uint(d, o, 1);
        if (v < lo || v > hi) revert DefinitionMalformed(DecodeError.InvalidEnum, o);
    }

    /// A `list` count, checked against its maximum before any element is read (T-52).
    function _count(bytes calldata d, uint256 o, uint256 max)
        private
        pure
        returns (uint256 c, uint256 next)
    {
        (c, next) = _uint(d, o, 4);
        if (c > max) revert DefinitionMalformed(DecodeError.LengthOverMax, o);
    }

    // --- well-formedness ---------------------------------------------------

    /// The first well-formedness rule `def` breaks, or `Rule.None`: version
    /// 1's rules, with version 3's `electorate` and `cells` for regional
    /// cells, version 4's `receipt-keys`, version 5's `questions` in place of
    /// the one question's rules, version 6's three rules, and version 7's
    /// `electorate` under its mode, then `rolling-class` and `rolling-tier`
    /// last.
    function rule(Definition memory def) internal pure returns (Rule) {
        Rule r = _profileRule(def);
        if (r != Rule.None) return r;
        r = def.version >= 5 ? _questionsRule(def.questions) : _questionRule(def);
        if (r != Rule.None) return r;
        bool rolling = def.electorateMode == ROLLING;
        if (def.version == 1) {
            if (!_electorateWellFormed(def.electorate)) return Rule.Electorate;
        } else if (rolling) {
            // A list the mode doesn't use would be a second electorate a
            // reader could take for the poll's; a rolling tier is one cell
            // and states none, so `cells` holds.
            if (def.tiers.length != 0 || !_rollingTiersOrdered(def.rolling)) {
                return Rule.Electorate;
            }
        } else {
            if (def.rolling.length != 0 || !_tiersWellFormed(def.tiers)) return Rule.Electorate;
            if (!_cellsWellFormed(def.tiers)) return Rule.Cells;
        }
        // T-14: a 1-of-n panel would let one trustee open every sharing alone.
        if (def.threshold < 2 || def.threshold > def.panelSize || def.panelSize > MAX_TRUSTEES) {
            return Rule.Panel;
        }
        if (!_chainWellFormed(def)) return Rule.Chain;
        // The close rule's deadline closes_at + δ must fit a u64.
        if (
            def.opensAt >= def.closesAt
                || uint256(def.closesAt) + def.l1InclusionBound > type(uint64).max
        ) return Rule.Timing;
        // T-26: at least one receipt key, none listed twice.
        if (def.version >= 4 && (def.receiptKeys.length == 0 || !_ascending(def.receiptKeys))) {
            return Rule.ReceiptKeys;
        }
        if (def.version < 6) return Rule.None;
        r = _v6Rule(def);
        if (r != Rule.None || !rolling) return r;
        // Civic polls keep a fixed electorate (the owner, 2026-10-12).
        if (def.pollClass != EVERYDAY) return Rule.RollingClass;
        return _rollingGroupsWellFormed(def.rolling) ? Rule.None : Rule.RollingTier;
    }

    function _profileRule(Definition memory def) private pure returns (Rule) {
        if (def.protocolMajor != 1) return Rule.ProtocolMajor;
        for (uint256 i = 1; i < def.pinTypes.length; i++) {
            if (def.pinTypes[i - 1] >= def.pinTypes[i]) return Rule.ProfileOrder;
        }
        // Plurality, approval and selection questions use exactly the types
        // 0x0001 to 0x0009.
        if (def.pinTypes.length != 9) return Rule.ProfileTypes;
        for (uint256 i; i < 9; i++) {
            if (def.pinTypes[i] != i + 1) return Rule.ProfileTypes;
        }
        for (uint256 i; i < 9; i++) {
            if (def.pinVersions[i] < 1) return Rule.ProfileVersion;
        }
        return Rule.None;
    }

    /// Versions 1, 3 and 4's `option-count` and `selections`.
    function _questionRule(Definition memory def) private pure returns (Rule) {
        if (def.optionCount < 2 || def.optionCount > MAX_OPTIONS) return Rule.OptionCount;
        if (
            def.minSelections > def.maxSelections || def.maxSelections > def.optionCount
                || def.maxSelections < 1
                || (def.electionType == PLURALITY
                    && (def.minSelections != 0 || def.maxSelections != 1))
        ) return Rule.Selections;
        return Rule.None;
    }

    /// Versions 5 and 6's `questions`, `option-count` (every `m_q ≥ 2` and the
    /// running total within `MAX_OPTIONS`) and `selections`, each over every
    /// question before the next rule (T-28).
    function _questionsRule(Question[] memory qs) private pure returns (Rule) {
        if (qs.length == 0) return Rule.Questions;
        uint256 total;
        for (uint256 i; i < qs.length; i++) {
            total += qs[i].optionCount;
            if (qs[i].optionCount < 2 || total > MAX_OPTIONS) return Rule.OptionCount;
        }
        for (uint256 i; i < qs.length; i++) {
            Question memory q = qs[i];
            if (
                q.minSelections > q.maxSelections || q.maxSelections > q.optionCount
                    || q.maxSelections < 1
            ) return Rule.Selections;
        }
        return Rule.None;
    }

    /// Version 1's `electorate`: non-empty, tiers strictly ascending, no
    /// shared group or root, no empty group (T-01, T-16).
    function _electorateWellFormed(TierGroup[] memory e) private pure returns (bool) {
        if (e.length == 0) return false;
        for (uint256 i; i < e.length; i++) {
            if (e[i].groupSize < 1) return false;
            if (i > 0 && e[i - 1].tier >= e[i].tier) return false;
            for (uint256 j; j < i; j++) {
                if (e[j].groupId == e[i].groupId || e[j].root == e[i].root) return false;
            }
        }
        return true;
    }

    /// Versions 3 to 6's `electorate`: tiers non-empty and strictly
    /// ascending; each tier's groups and regions non-empty, its groups in
    /// strictly ascending `group_id` and in no other tier, so each group is in
    /// one region of one tier and no member counts in two cells (T-01, G-2);
    /// every region named by a group, and none empty.
    function _tiersWellFormed(TierElectorate[] memory ts) private pure returns (bool) {
        if (ts.length == 0) return false;
        for (uint256 i; i < ts.length; i++) {
            TierElectorate memory t = ts[i];
            if (i > 0 && ts[i - 1].tier >= t.tier) return false;
            if (t.groups.length == 0 || t.regions.length == 0) return false;
            bool[] memory named = new bool[](t.regions.length);
            for (uint256 j; j < t.groups.length; j++) {
                RegionGroup memory g = t.groups[j];
                if (j > 0 && t.groups[j - 1].groupId >= g.groupId) return false;
                // Earlier tiers' groups are ascending too, so a search finds
                // a repeat in log time, whatever the tiers' sizes (T-52).
                for (uint256 k; k < i; k++) {
                    if (_hasGroup(ts[k].groups, g.groupId)) return false;
                }
                if (g.region >= t.regions.length) return false;
                named[g.region] = true;
            }
            for (uint256 r; r < t.regions.length; r++) {
                if (!named[r] || t.regions[r] < 1) return false;
            }
        }
        return true;
    }

    /// Version 7's `electorate` under mode 2: rolling tiers non-empty and in
    /// strictly ascending order of tier.
    function _rollingTiersOrdered(RollingTier[] memory ts) private pure returns (bool) {
        if (ts.length == 0) return false;
        for (uint256 i = 1; i < ts.length; i++) {
            if (ts[i - 1].tier >= ts[i].tier) return false;
        }
        return true;
    }

    /// Version 7's `rolling-tier`: each rolling tier's groups non-empty, in
    /// strictly ascending order and in no other tier, so no member's leaf is
    /// in two tiers' trees (T-01, T-16).
    function _rollingGroupsWellFormed(RollingTier[] memory ts) private pure returns (bool) {
        for (uint256 i; i < ts.length; i++) {
            uint64[] memory groups = ts[i].groups;
            if (groups.length == 0) return false;
            for (uint256 j; j < groups.length; j++) {
                if (j > 0 && groups[j - 1] >= groups[j]) return false;
                // Earlier tiers passed, so their groups are ascending and a
                // search finds a repeat in log time (T-52).
                for (uint256 k; k < i; k++) {
                    if (_holds(ts[k].groups, groups[j])) return false;
                }
            }
        }
        return true;
    }

    /// Whether `ids`, in strictly ascending order, holds `id`.
    function _holds(uint64[] memory ids, uint64 id) private pure returns (bool) {
        uint256 lo;
        uint256 hi = ids.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint64 m = ids[mid];
            if (m == id) return true;
            if (m < id) lo = mid + 1;
            else hi = mid;
        }
        return false;
    }

    /// Whether `groups`, in strictly ascending `group_id`, holds `id`.
    function _hasGroup(RegionGroup[] memory groups, uint64 id) private pure returns (bool) {
        uint256 lo;
        uint256 hi = groups.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint64 m = groups[mid].groupId;
            if (m == id) return true;
            if (m < id) lo = mid + 1;
            else hi = mid;
        }
        return false;
    }

    /// Versions 3 to 6's `cells`, after `electorate`: each tier's cells are
    /// the fold of its region counts (docs/spec/election-definition.md,
    /// Regional cells), at most 256 in all, with no root shared by two, so
    /// the floor on every split tier follows from the stated counts (T-16,
    /// T-34) and no membership proof fits two cells (T-01).
    function _cellsWellFormed(TierElectorate[] memory ts) private pure returns (bool) {
        uint256 total;
        for (uint256 i; i < ts.length; i++) {
            if (!_foldMatches(ts[i])) return false;
            total += ts[i].cells.length;
        }
        if (total > MAX_CELLS) return false;
        uint256[] memory roots = new uint256[](total);
        uint256 n;
        for (uint256 i; i < ts.length; i++) {
            for (uint256 j; j < ts[i].cells.length; j++) {
                uint256 root = ts[i].cells[j].root;
                for (uint256 k; k < n; k++) {
                    if (roots[k] == root) return false;
                }
                roots[n++] = root;
            }
        }
        return true;
    }

    /// Whether `t`'s cells are the fold of its regions: each region with at
    /// least `MIN_CELL_ELECTORATE` members on its own, in region order, then
    /// one remainder cell of the rest, if the tier is split (at least two
    /// such cells, and a remainder, if any, at the floor); otherwise one cell
    /// of every region. Each cell's `members` is its regions' sum, over
    /// `uint256`, which 1,024 `u64` counts can't overflow.
    function _foldMatches(TierElectorate memory t) private pure returns (bool) {
        uint256 large;
        uint256 small;
        uint256 smallSum;
        uint256 all;
        for (uint256 r; r < t.regions.length; r++) {
            uint256 c = t.regions[r];
            all += c;
            if (c >= MIN_CELL_ELECTORATE) {
                large++;
            } else {
                small++;
                smallSum += c;
            }
        }
        uint256 candidates = large + (small > 0 ? 1 : 0);
        if (candidates < 2 || (small > 0 && smallSum < MIN_CELL_ELECTORATE)) {
            return t.cells.length == 1 && t.cells[0].members == all;
        }
        if (t.cells.length != candidates) return false;
        uint256 k;
        for (uint256 r; r < t.regions.length; r++) {
            if (t.regions[r] >= MIN_CELL_ELECTORATE) {
                if (t.cells[k++].members != t.regions[r]) return false;
            }
        }
        return small == 0 || t.cells[k].members == smallSum;
    }

    /// Whether the keys are in strictly ascending order of their encodings.
    function _ascending(P256Key[] memory keys) private pure returns (bool) {
        for (uint256 i = 1; i < keys.length; i++) {
            P256Key memory a = keys[i - 1];
            P256Key memory b = keys[i];
            if (a.prefix > b.prefix || (a.prefix == b.prefix && a.x >= b.x)) return false;
        }
        return true;
    }

    /// Version 6's `results`, `civic-sealed` and `author-panel`, in order.
    function _v6Rule(Definition memory def) private pure returns (Rule) {
        // T-17: a sealed poll's zeros carry no chosen bytes; T-16: a live
        // poll releases on a schedule, in batches of at least the floor.
        if (def.resultsMode == SEALED) {
            if (def.liveEvery != 0 || def.liveBatch != 0) return Rule.Results;
        } else if (def.liveEvery < 1 || def.liveBatch < MIN_LIVE_BATCH) {
            return Rule.Results;
        }
        // Civic referendums are always sealed (the brief).
        if (def.pollClass == CIVIC && def.resultsMode != SEALED) return Rule.CivicSealed;
        uint256 n = def.authorKeys.length;
        if (def.authorThreshold == 0 && n == 0) {
            // No author panel: no chosen bytes in its transcript hash (T-17).
            if (def.authorTranscriptHash != bytes32(0)) return Rule.AuthorPanel;
            return Rule.None;
        }
        // A panel's transcript hash differs from the zeros of the default
        // stub (T-37); `1 ≤ k_A ≤ n_A`, and no key in two seats (T-14).
        if (
            def.authorTranscriptHash == bytes32(0) || def.authorThreshold < 1
                || def.authorThreshold > n
        ) return Rule.AuthorPanel;
        for (uint256 i; i < n; i++) {
            for (uint256 j; j < i; j++) {
                if (
                    def.authorKeys[i].prefix == def.authorKeys[j].prefix
                        && def.authorKeys[i].x == def.authorKeys[j].x
                ) return Rule.AuthorPanel;
            }
        }
        return Rule.None;
    }

    function _chainWellFormed(Definition memory def) private pure returns (bool) {
        if (def.l2ChainId == 0 || def.l1ChainId == 0 || def.l2ChainId == def.l1ChainId) {
            return false;
        }
        address[4] memory l2 =
            [def.electionRegistry, def.board, def.trusteeRegistry, def.groupRegistry];
        for (uint256 i; i < 4; i++) {
            if (l2[i] == address(0)) return false;
            for (uint256 j; j < i; j++) {
                if (l2[j] == l2[i]) return false;
            }
        }
        return
            def.l1Anchor != address(0) && def.l1Relay != address(0) && def.l1Anchor != def.l1Relay;
    }

    // --- hashes ------------------------------------------------------------

    /// `definition_hash = H(DS("abolish/v1/election-definition", encode(definition)))`.
    function hash(bytes calldata d) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(DS_DEFINITION, d));
    }

    /// `author_panel_id = H(DS("abolish/v1/author-panel", u8(k_A) ‖ u8(n_A) ‖
    /// Q_1 ‖ … ‖ Q_{n_A}))` (docs/spec/trustee-identity.md, Author panel
    /// identifier), over the 33-byte encodings of version 6's `author_keys`
    /// as the definition carries them. The decoder's 16-key limit keeps
    /// `n_A` within a `u8`.
    function authorPanelId(Definition memory def) internal pure returns (bytes32) {
        bytes memory keys;
        for (uint256 i; i < def.authorKeys.length; i++) {
            keys = abi.encodePacked(keys, def.authorKeys[i].prefix, def.authorKeys[i].x);
        }
        return sha256(
            abi.encodePacked(
                DS_AUTHOR_PANEL, def.authorThreshold, uint8(def.authorKeys.length), keys
            )
        );
    }

    /// `author_stub_hash = H(DS("abolish/v1/election-stub", encode(author_stub)))`
    /// of a version-6 or version-7 definition: both `ceremony_transcript_hash`
    /// at `transcriptOffset` and `author_transcript_hash` at
    /// `authorTranscriptOffset` zeroed, and version 7's fields after it kept
    /// (docs/spec/election-definition.md, Stub hash and the ceremony).
    /// Defined only for those versions, the only ones with an author panel:
    /// below version 6 `authorTranscriptOffset` is 0 and the slice reverts.
    function authorStubHash(
        bytes calldata d,
        uint256 transcriptOffset,
        uint256 authorTranscriptOffset
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_STUB,
                d[:transcriptOffset],
                bytes32(0),
                d[transcriptOffset + 32:authorTranscriptOffset],
                bytes32(0),
                d[authorTranscriptOffset + 32:]
            )
        );
    }

    /// `stub_hash = H(DS("abolish/v1/election-stub", encode(stub)))`, the
    /// definition with its 32-byte `ceremony_transcript_hash` at
    /// `transcriptOffset` zeroed.
    function stubHash(bytes calldata d, uint256 transcriptOffset) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(DS_STUB, d[:transcriptOffset], bytes32(0), d[transcriptOffset + 32:])
        );
    }
}
