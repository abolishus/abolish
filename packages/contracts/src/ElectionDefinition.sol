// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title The election definition, record type 0x0001 version 1 (docs/spec/election-definition.md).
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
    /// checking order. `None` means well formed.
    enum Rule {
        None,
        ProtocolMajor,
        ProfileOrder,
        ProfileTypes,
        ProfileVersion,
        OptionCount,
        Selections,
        Electorate,
        Panel,
        Chain,
        Timing
    }

    struct TierGroup {
        uint8 tier;
        uint64 groupId;
        uint256 root;
        uint64 rootL2Block;
        uint64 groupSize;
    }

    struct Definition {
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
        TierGroup[] electorate;
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
        /// Where `ceremony_transcript_hash` starts in the encoding, for the stub hash.
        uint256 transcriptOffset;
    }

    error DefinitionMalformed(DecodeError code, uint256 offset);

    uint16 internal constant RECORD_TYPE = 0x0001;
    uint8 internal constant VERSION = 1;
    uint256 internal constant MAX_PINS = 64;
    uint256 internal constant MAX_TIERS = 3;
    // Version 1's limits, written out: raising a protocol-wide limit is a new
    // record version (docs/spec/parameters.md), so version 1 never changes.
    uint256 internal constant MAX_OPTIONS = 64;
    uint256 internal constant MAX_TRUSTEES = 16;
    uint8 internal constant PLURALITY = 1;
    uint8 internal constant APPROVAL = 2;
    /// The BN254 scalar field modulus `r` (docs/spec/notation.md, `field<bn254>`).
    uint256 internal constant BN254_R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    /// `u8(len(tag)) ‖ tag` for the two hashes (0x1e = 30, 0x18 = 24).
    bytes internal constant DS_DEFINITION = "\x1eabolish/v1/election-definition";
    bytes internal constant DS_STUB = "\x18abolish/v1/election-stub";

    // --- decoding ----------------------------------------------------------

    /// Decodes `d` strictly as record type 0x0001 version 1, then checks the
    /// definition's own profile pins exactly that version (docs/spec/election-definition.md,
    /// Decoding). Reverts with the first failure, left to right.
    function decode(bytes calldata d) internal pure returns (Definition memory def) {
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
        if (v != VERSION) revert DefinitionMalformed(DecodeError.UnknownVersion, 2);

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

        (count, o) = _count(d, o, MAX_TIERS);
        def.electorate = new TierGroup[](count);
        for (uint256 i; i < count; i++) {
            TierGroup memory g = def.electorate[i];
            (v, o) = _enum(d, o, 0, 2);
            g.tier = uint8(v);
            (v, o) = _uint(d, o, 8);
            g.groupId = uint64(v);
            (v, o) = _uint(d, o, 32);
            // T-04, T-31: one encoding per field element.
            if (v >= BN254_R) revert DefinitionMalformed(DecodeError.NonCanonical, o - 32);
            g.root = v;
            (v, o) = _uint(d, o, 8);
            g.rootL2Block = uint64(v);
            (v, o) = _uint(d, o, 8);
            g.groupSize = uint64(v);
        }

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
        if (o != d.length) revert DefinitionMalformed(DecodeError.TrailingBytes, o);

        // Step 2: exactly one pin for 0x0001, at the record's own version,
        // wherever it appears (T-34, T-31).
        uint256 own;
        bool atVersion;
        for (uint256 i; i < def.pinTypes.length; i++) {
            if (def.pinTypes[i] == RECORD_TYPE) {
                own++;
                atVersion = def.pinVersions[i] == VERSION;
            }
        }
        if (own != 1 || !atVersion) revert DefinitionMalformed(DecodeError.ProfileMismatch, 0);
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

    /// The first well-formedness rule `def` breaks, or `Rule.None`.
    function rule(Definition memory def) internal pure returns (Rule) {
        if (def.protocolMajor != 1) return Rule.ProtocolMajor;
        for (uint256 i = 1; i < def.pinTypes.length; i++) {
            if (def.pinTypes[i - 1] >= def.pinTypes[i]) return Rule.ProfileOrder;
        }
        // Plurality and approval use exactly the types 0x0001 to 0x0009.
        if (def.pinTypes.length != 9) return Rule.ProfileTypes;
        for (uint256 i; i < 9; i++) {
            if (def.pinTypes[i] != i + 1) return Rule.ProfileTypes;
        }
        for (uint256 i; i < 9; i++) {
            if (def.pinVersions[i] < 1) return Rule.ProfileVersion;
        }
        if (def.optionCount < 2 || def.optionCount > MAX_OPTIONS) return Rule.OptionCount;
        if (
            def.minSelections > def.maxSelections || def.maxSelections > def.optionCount
                || def.maxSelections < 1
                || (def.electionType == PLURALITY
                    && (def.minSelections != 0 || def.maxSelections != 1))
        ) return Rule.Selections;
        if (!_electorateWellFormed(def.electorate)) return Rule.Electorate;
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
        return Rule.None;
    }

    /// Non-empty, tiers strictly ascending, no shared group or root, no empty
    /// group (T-01, T-16).
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

    /// `stub_hash = H(DS("abolish/v1/election-stub", encode(stub)))`, the
    /// definition with its 32-byte `ceremony_transcript_hash` at
    /// `transcriptOffset` zeroed.
    function stubHash(bytes calldata d, uint256 transcriptOffset) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(DS_STUB, d[:transcriptOffset], bytes32(0), d[transcriptOffset + 32:])
        );
    }
}
