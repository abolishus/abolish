// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib, IElectionParameters} from "../src/BallotCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {MembershipProofLib} from "../src/MembershipProof.sol";
import {BallotHarness, ParametersStub} from "./utils/BallotHarness.sol";
import {DefinitionHarness, MockTrusteeRegistry} from "./utils/DefinitionHarness.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {TestBase} from "./utils/Vm.sol";

/// The board's ballot check (docs/spec/contracts.md, Board, Ballots; Ballots
/// (version 4)) against the ballot vectors: ballot.json, ballot-v2.json,
/// ballot-v3-records.json and ballot-v4-records.json (records with real
/// Semaphore proofs, admission results and decode rejections), ballot-v3.json
/// and ballot-validity.json (committed votes,
/// their shapes and codec rejections). Every expected value comes from the files. The board runs
/// every admission check but the validity proofs (ADR 0028, 3B), so a vector
/// the verifier rejects only at `option-proof` or `sum-proof` is admitted
/// here, and every other gets the verifier's own verdict (T-25, T-17).
contract BallotCheckTest is TestBase {
    string internal constant V1 = "../../docs/spec/vectors/ballot.json";
    string internal constant V2 = "../../docs/spec/vectors/ballot-v2.json";
    string internal constant V3 = "../../docs/spec/vectors/ballot-v3.json";
    string internal constant V3_RECORDS = "../../docs/spec/vectors/ballot-v3-records.json";
    string internal constant V4_RECORDS = "../../docs/spec/vectors/ballot-v4-records.json";
    string internal constant VALIDITY = "../../docs/spec/vectors/ballot-validity.json";

    BallotHarness internal lib;
    DefinitionHarness internal defs;

    function setUp() public {
        lib = new BallotHarness();
        defs = new DefinitionHarness();
    }

    function test_VectorFileFormats() public view {
        assertTrue(_eq(_str(vm.readFile(V1), ".format"), "abolish-ballot-vectors/1"), "v1 format");
        assertTrue(_eq(_str(vm.readFile(V2), ".format"), "abolish-ballot-vectors/1"), "v2 format");
        assertTrue(
            _eq(_str(vm.readFile(V3_RECORDS), ".format"), "abolish-ballot-vectors/1"),
            "v3 records format"
        );
        assertTrue(
            _eq(_str(vm.readFile(V4_RECORDS), ".format"), "abolish-ballot-vectors/1"),
            "v4 records format"
        );
        assertTrue(
            _eq(_str(vm.readFile(V3), ".format"), "abolish-ballot-v3-vectors/1"), "v3 format"
        );
        assertTrue(
            _eq(_str(vm.readFile(VALIDITY), ".format"), "abolish-ballot-validity-vectors/1"),
            "validity format"
        );
        assertTrue(_tag(BallotCheckLib.DS_BALLOT) == keccak256("abolish/v1/ballot"), "ballot tag");
        assertTrue(
            _tag(BallotCheckLib.DS_MESSAGE) == keccak256("abolish/v1/membership-message"),
            "message tag"
        );
    }

    // --- records with membership proofs (versions 1 to 3) --------------------

    /// Every ballot of ballot.json: the admitted ones give the file's ballot
    /// hash, `M` and tier; the rest the file's code, except the validity
    /// proofs', which the board doesn't run.
    function test_BallotVectorsV1() public {
        assertEq(_ballots(V1, 1), 20, "v1 ballot coverage");
    }

    function test_BallotVectorsV2() public {
        assertEq(_ballots(V2, 2), 21, "v2 ballot coverage");
    }

    /// ballot-v3-records.json's ballots under their version-5 definition's
    /// questions and cells: a range proof's failure (`sum-proof`, naming its
    /// question) is the verifier's alone, so that ballot is admitted here,
    /// and a ballot shaped for other questions is `validity-shape` (T-28).
    function test_BallotVectorsV3() public {
        assertEq(_ballots(V3_RECORDS, 3), 20, "v3 ballot coverage");
    }

    /// ballot-v4-records.json's ballots under their version-6 definitions'
    /// panels, questions and cells, each judged against both of its
    /// registered key sets: with an author panel and without one, an author
    /// half where there is none or missing where there is one
    /// (`validity-shape`), an unqualified seat of either panel, the default
    /// panel's reported first (`share-hash-unqualified`), and a swapped author
    /// half, which the ballot hash and so `M` bind (`membership-proof`;
    /// T-17, T-37, T-38). Option and range proofs are the verifier's alone.
    function test_BallotVectorsV4() public {
        string memory json = vm.readFile(V4_RECORDS);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".ballots", i, "")); i++) {
            string memory b = _at(".ballots", i, "");
            string memory id = _str(json, string.concat(b, ".id"));
            ParametersStub stub = _stubV4(
                json, string.concat(".elections.", _str(json, string.concat(b, ".election")))
            );
            bytes memory record = _bytes(json, string.concat(b, ".encoding"));
            uint256 qualified = _mask(vm.parseJsonUintArray(json, string.concat(b, ".registered")));
            uint256 authorQualified =
                _mask(vm.parseJsonUintArray(json, string.concat(b, ".authorRegistered")));
            string memory code = _str(json, string.concat(b, ".admission.code"));
            if (_eq(code, "ok") || _eq(code, "option-proof") || _eq(code, "sum-proof")) {
                BallotCheckLib.Admitted memory a =
                    lib.check(record, stub, qualified, authorQualified);
                assertEq(a.version, 4, id);
                if (_eq(code, "ok")) {
                    string memory r = string.concat(b, ".admission");
                    assertEq(
                        a.ballotHash,
                        bytes32(_bytes(json, string.concat(r, ".ballotHash"))),
                        string.concat("ballot hash of ", id)
                    );
                    assertEq(
                        a.message,
                        bytes32(_bytes(json, string.concat(r, ".message"))),
                        string.concat("M of ", id)
                    );
                    assertEq(
                        a.cell,
                        vm.parseJsonUint(json, string.concat(r, ".cell")),
                        string.concat("cell of ", id)
                    );
                    assertEq(
                        a.tier,
                        vm.parseJsonUint(json, string.concat(r, ".tier")),
                        string.concat("tier of ", id)
                    );
                }
            } else {
                try lib.check(record, stub, qualified, authorQualified) {
                    revert(string.concat("admitted ", id));
                } catch (bytes memory reason) {
                    assertEq(
                        keccak256(reason),
                        keccak256(
                            abi.encodeWithSelector(
                                BallotCheckLib.BallotRefused.selector, _code(code)
                            )
                        ),
                        string.concat("refusal of ", id)
                    );
                }
            }
        }
        assertEq(i, 23, "v4 ballot coverage");
    }

    /// The author key set is judged on its own: a ballot whose author half
    /// names a seat outside it is refused whatever the default key set, and
    /// one the vectors admit is refused once any author seat it fills leaves
    /// the set, so a check that skipped the author panel fails here (T-17).
    function test_AuthorKeySetJudgedV4() public {
        string memory json = vm.readFile(V4_RECORDS);
        ParametersStub stub = _stubV4(json, ".elections.panels");
        // ok-every-seat fills all three seats of both panels.
        bytes memory record = _bytes(json, ".ballots[3].encoding");
        assertTrue(_eq(_str(json, ".ballots[3].id"), "ok-every-seat"), "the every-seat ballot");
        lib.check(record, stub, 14, 14);
        for (uint256 seat = 1; seat <= 3; seat++) {
            uint256 without = 14 & ~(1 << seat);
            _expectRefusedV4(record, stub, 14, without, BallotCheckLib.Code.ShareHashUnqualified);
            _expectRefusedV4(record, stub, without, 14, BallotCheckLib.Code.ShareHashUnqualified);
        }
        // Bit 0 and bits past the panel name no seat.
        _expectRefusedV4(record, stub, 14, 1 | (1 << 4), BallotCheckLib.Code.ShareHashUnqualified);
    }

    /// Without an author panel the author half is two empty lists: a
    /// ballot carrying one, even of zero-filled hashes, fits no shape, and so
    /// does a ballot of a poll with one that leaves it out (validity-shape;
    /// ballot-validity.md, Committed vote (version 4), Notes).
    function test_AuthorHalfShapeV4() public {
        string memory json = vm.readFile(V4_RECORDS);
        ParametersStub stub = _stubV4(json, ".elections.panels");
        bytes32 h = bytes32(_bytes(json, ".elections.panels.definitionHash"));
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV4(json, ".elections.panels");
        bytes memory record = _bytes(json, ".ballots[0].encoding");
        lib.check(record, stub, 6, 6);
        // The same parameters with another author threshold or panel size,
        // or with none.
        p.authorThreshold = 3;
        stub.set(h, p, tiers, roots);
        _expectRefusedV4(record, stub, 6, 6, BallotCheckLib.Code.ValidityShape);
        (p.authorThreshold, p.authorPanelSize) = (2, 4);
        stub.set(h, p, tiers, roots);
        _expectRefusedV4(record, stub, 6, 6, BallotCheckLib.Code.ValidityShape);
        (p.authorThreshold, p.authorPanelSize) = (0, 0);
        stub.set(h, p, tiers, roots);
        _expectRefusedV4(record, stub, 6, 0, BallotCheckLib.Code.ValidityShape);

        // ok-default-only's author half as `T` rows of no element, beside
        // no share hash: the second encoding the one-encoding rule refuses,
        // as its shape, before its ballot hash changes anything.
        ParametersStub own = _stubV4(json, ".elections.default-only");
        bytes memory honest = _bytes(json, ".ballots[7].encoding");
        assertTrue(_eq(_str(json, ".ballots[7].id"), "ok-default-only"), "the default-only ballot");
        lib.check(honest, own, 6, 0);
        // `vss` (9 rows of 2) and `share_hashes` (3) end at 1080.
        uint256 at = BallotCheckLib.VOTE_AT + 4 + 9 * (4 + 64) + 4 + 3 * 32;
        assertEq(_u32(honest, at), 0, "the empty author_vss");
        bytes memory rows = abi.encodePacked(uint32(9), new bytes(4 * 9));
        _expectRefusedV4(
            bytes.concat(
                _slice(honest, 0, at), rows, _slice(honest, at + 4, honest.length - at - 4)
            ),
            own,
            6,
            0,
            BallotCheckLib.Code.ValidityShape
        );
    }

    /// A definition with an author panel fits no ballot of versions 1 to 3,
    /// so the author share hashes are never read from a record without them.
    function test_AuthorPanelFitsNoEarlierVersion() public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        string memory json = vm.readFile(V1);
        bytes32 h = bytes32(_bytes(json, ".elections.plurality.definitionHash"));
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV1(json, ".elections.plurality");
        (p.authorThreshold, p.authorPanelSize) = (1, 1);
        stub.set(h, p, tiers, roots);
        _expectRefusedV4(honest, stub, 6, 2, BallotCheckLib.Code.ValidityShape);
    }

    /// Every decode rejection at its offset. The one record of another type
    /// is a type the spec specifies, so the board reports it as unexpected,
    /// where the file, which knows only 0x0002, says unknown (notation.md,
    /// Strict decoding: the contract knows the registry's types).
    function test_DecodeVectorsV1() public {
        assertEq(_decodes(V1, 1), 11, "v1 decode coverage");
    }

    function test_DecodeVectorsV2() public {
        assertEq(_decodes(V2, 2), 8, "v2 decode coverage");
    }

    function test_DecodeVectorsV3() public {
        assertEq(_decodes(V3_RECORDS, 3), 8, "v3 decode coverage");
    }

    /// ballot-v4-records.json's rejections: each author list's count over its
    /// maximum before anything it counts is read (T-52), an author element
    /// that is the identity or not canonical, and the same bytes under
    /// versions 1 and 3, which the pin refuses.
    function test_DecodeVectorsV4() public {
        string memory json = vm.readFile(V4_RECORDS);
        ParametersStub stub = _stubV4(json, ".elections.panels");
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            string memory id = _str(json, string.concat(d, ".id"));
            try lib.check(_bytes(json, string.concat(d, ".encoding")), stub, 14, 14) {
                revert(string.concat("admitted ", id));
            } catch (bytes memory reason) {
                (ElectionDefinitionLib.DecodeError got, uint256 offset) = _malformed(reason);
                assertTrue(
                    got == _decodeError(_str(json, string.concat(d, ".error"))),
                    string.concat("code for ", id)
                );
                if (vm.keyExistsJson(json, string.concat(d, ".offset"))) {
                    assertEq(
                        offset,
                        vm.parseJsonUint(json, string.concat(d, ".offset")),
                        string.concat("offset for ", id)
                    );
                }
            }
        }
        assertEq(i, 13, "v4 decode coverage");
    }

    // --- committed votes (versions 1 and 3) ----------------------------------

    /// ballot-validity.json's committed votes: each frames, and its shape
    /// holds unless the file says `validity-shape`; each codec rejection of
    /// a committed vote is refused with its code (the file gives no offsets).
    function test_CommittedVoteVectorsV1() public view {
        string memory json = vm.readFile(VALIDITY);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".ballots", i, "")); i++) {
            string memory c = _at(".ballots", i, ".context");
            ElectionRegistry.Question[] memory qs = new ElectionRegistry.Question[](1);
            qs[0] = ElectionRegistry.Question(
                1,
                uint16(vm.parseJsonUint(json, string.concat(c, ".optionCount"))),
                uint16(vm.parseJsonUint(json, string.concat(c, ".minSelections"))),
                uint16(vm.parseJsonUint(json, string.concat(c, ".maxSelections")))
            );
            ElectionRegistry.Parameters memory p = _params(
                1,
                vm.parseJsonUint(json, string.concat(c, ".threshold")),
                vm.parseJsonUint(json, string.concat(c, ".panelSize")),
                qs
            );
            bool shape = lib.vote(_bytes(json, _at(".ballots", i, ".encoding")), 1, p);
            assertTrue(
                shape != _isShape(json, _at(".ballots", i, "")),
                string.concat("shape of ", _str(json, _at(".ballots", i, ".id")))
            );
        }
        assertEq(i, 31, "validity ballot coverage");
        ElectionRegistry.Parameters memory any =
            _params(1, 2, 3, new ElectionRegistry.Question[](0));
        uint256 n;
        for (i = 0; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            if (!_eq(_str(json, _at(".decode", i, ".type")), "committed-vote")) continue;
            n++;
            try lib.vote(_bytes(json, _at(".decode", i, ".encoding")), 1, any) {
                revert(string.concat("framed ", _str(json, _at(".decode", i, ".id"))));
            } catch (bytes memory reason) {
                (ElectionDefinitionLib.DecodeError code,) = _malformed(reason);
                assertTrue(
                    code == _decodeError(_str(json, _at(".decode", i, ".error"))),
                    string.concat("code for ", _str(json, _at(".decode", i, ".id")))
                );
            }
        }
        assertEq(n, 11, "validity decode coverage");
    }

    /// ballot-v3.json's committed votes over version-5 definitions: each
    /// frames, its shape holds unless the file says `validity-shape`, and its
    /// ballot hash, over a record built around it, is the file's; each codec
    /// rejection is refused with its code at its offset.
    function test_CommittedVoteVectorsV3() public view {
        string memory json = vm.readFile(V3);
        uint256 i;
        uint256 hashes;
        for (; vm.keyExistsJson(json, _at(".ballots", i, "")); i++) {
            string memory b = _at(".ballots", i, "");
            string memory e =
                string.concat(".elections.", _str(json, string.concat(b, ".election")));
            ElectionRegistry.Parameters memory p = _paramsV3(json, e);
            bytes memory voteBytes = _bytes(json, string.concat(b, ".encoding"));
            string memory id = _str(json, string.concat(b, ".id"));
            assertTrue(
                lib.vote(voteBytes, 3, p) != _isShape(json, b), string.concat("shape of ", id)
            );
            bytes memory record = abi.encodePacked(
                uint16(2),
                uint8(3),
                _bytes(json, string.concat(b, ".context.definitionHash")),
                uint8(vm.parseJsonUint(json, string.concat(b, ".context.cell"))),
                vm.parseUint(_str(json, string.concat(b, ".context.nullifier"))),
                new bytes(296),
                voteBytes
            );
            if (!vm.keyExistsJson(json, string.concat(b, ".ballotHash"))) continue;
            hashes++;
            assertEq(
                lib.ballotHash(record),
                bytes32(_bytes(json, string.concat(b, ".ballotHash"))),
                string.concat("ballot hash of ", id)
            );
        }
        assertEq(i, 31, "v3 ballot coverage");
        assertEq(hashes, 8, "v3 ballot hash coverage");
        ElectionRegistry.Parameters memory owners = _paramsV3(json, ".elections.owners-four");
        for (i = 0; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            string memory id = _str(json, _at(".decode", i, ".id"));
            try lib.vote(_bytes(json, _at(".decode", i, ".encoding")), 3, owners) {
                revert(string.concat("framed ", id));
            } catch (bytes memory reason) {
                (ElectionDefinitionLib.DecodeError code, uint256 offset) = _malformed(reason);
                assertTrue(
                    code == _decodeError(_str(json, _at(".decode", i, ".error"))),
                    string.concat("code for ", id)
                );
                assertEq(offset, vm.parseJsonUint(json, _at(".decode", i, ".offset")), id);
            }
        }
        assertEq(i, 7, "v3 decode coverage");
    }

    // --- framing edges -------------------------------------------------------

    /// An element's encoding is refused at or above `2²⁵⁵ − 19`, when odd,
    /// when its top bit is set and as the identity; below `p` and even it is
    /// framed, whether or not it decodes (ADR 0028, 3B). A scalar is refused
    /// at `ℓ` and framed at `ℓ − 1`.
    function test_ElementAndScalarFraming() public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        uint256 at = BallotCheckLib.VOTE_AT + 8; // the first VSS commitment
        uint256 p = BallotCheckLib.P25519;
        _expectMalformedAt(_withWord(honest, at, _le(p)), stub, at);
        _expectMalformedAt(_withWord(honest, at, _le(p + 1)), stub, at);
        _expectMalformedAt(_withWord(honest, at, _le(type(uint256).max - 1)), stub, at);
        // `2`'s little-endian encoding is even and below p: it frames, and
        // the record then fails only on its membership proof (the ballot
        // hash changed). An odd one doesn't frame.
        _expectRefused(_withWord(honest, at, _le(2)), stub, BallotCheckLib.Code.MembershipProof);
        _expectRefused(_withWord(honest, at, _le(p - 1)), stub, BallotCheckLib.Code.MembershipProof);
        _expectMalformedAt(_withWord(honest, at, _le(3)), stub, at);
        _expectMalformedAt(_withWord(honest, at, 0), stub, at);
        uint256 scalarAt = _optionProofsAt(honest) + 4;
        _expectMalformedAt(_withWord(honest, scalarAt, _le(BallotCheckLib.L)), stub, scalarAt);
        _expectRefused(
            _withWord(honest, scalarAt, _le(BallotCheckLib.L - 1)),
            stub,
            BallotCheckLib.Code.MembershipProof
        );
    }

    /// The membership proof's points are the record's decode errors at their
    /// offsets, found when the proof is checked, after the admission checks
    /// before it.
    function test_ProofPointsAreDecodeErrors() public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        _expectMalformedAt(_withWord(honest, 108, 0), stub, 108);
        _expect(
            _withWord(_withWord(honest, 108, 0), 108 + 32, 0),
            stub,
            abi.encodeWithSelector(
                BallotCheckLib.BallotMalformed.selector,
                ElectionDefinitionLib.DecodeError.NonCanonical,
                108
            )
        );
        _expect(
            _withWord(honest, 300, MembershipProofLib.P),
            stub,
            abi.encodeWithSelector(
                BallotCheckLib.BallotMalformed.selector,
                ElectionDefinitionLib.DecodeError.NonCanonical,
                300
            )
        );
    }

    // --- the election's parameters -------------------------------------------

    /// A pin the library doesn't know admits nothing; ballot versions 1 and 2
    /// fit no definition with several questions; a tier in two cells is no
    /// version-1 ballot's; a root of 0 is refused as the proof (T-04).
    function test_ParameterEdges() public {
        string memory json = vm.readFile(V1);
        bytes memory honest = _bytes(json, ".ballots[0].encoding");
        bytes32 h = bytes32(_bytes(json, ".elections.plurality.definitionHash"));
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV1(json, ".elections.plurality");
        ParametersStub stub = new ParametersStub();

        // Version 5 (rolling electorates) is the first pin the board can't read.
        p.ballotVersion = 5;
        stub.set(h, p, tiers, roots);
        _expect(
            _withByte(honest, 2, 5),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnknownVersion, 2)
        );

        p.ballotVersion = 1;
        ElectionRegistry.Question[] memory two = new ElectionRegistry.Question[](2);
        two[0] = p.questions[0];
        two[1] = p.questions[0];
        ElectionRegistry.Question[] memory one = p.questions;
        p.questions = two;
        stub.set(h, p, tiers, roots);
        _expectRefused(honest, stub, BallotCheckLib.Code.ValidityShape);

        p.questions = one;
        uint8[] memory doubled = new uint8[](3);
        uint256[] memory doubledRoots = new uint256[](3);
        (doubled[0], doubled[1], doubled[2]) = (tiers[0], tiers[1], tiers[0]);
        (doubledRoots[0], doubledRoots[1], doubledRoots[2]) = (roots[0], roots[1], 7);
        stub.set(h, p, doubled, doubledRoots);
        _expectRefused(honest, stub, BallotCheckLib.Code.BallotTier);

        uint256[] memory zero = new uint256[](roots.length);
        zero[1] = roots[1];
        stub.set(h, p, tiers, zero);
        _expectRefused(honest, stub, BallotCheckLib.Code.MembershipProof);

        stub.set(h, p, tiers, roots);
        lib.check(honest, stub, 6);
    }

    /// Every type the spec lists but 0x0002 is unexpected and any other
    /// unknown; version 0 is no pin; a record that ends in its header, before
    /// its election or inside its proof is truncated where it ends.
    function test_RecordTypes() public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        _expect(
            _withByte(honest, 1, 0x0c),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x14),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x15),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x16),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x17),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x1a),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x1b),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0)
        );
        _expect(
            _withByte(honest, 1, 0x00),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0)
        );
        _expect(
            _withByte(honest, 2, 0),
            stub,
            _malformedData(ElectionDefinitionLib.DecodeError.ProfileMismatch, 2)
        );
        _expect(new bytes(1), stub, _malformedData(ElectionDefinitionLib.DecodeError.Truncated, 0));
        _expect(hex"0002", stub, _malformedData(ElectionDefinitionLib.DecodeError.Truncated, 2));
        bytes memory short = new bytes(300);
        for (uint256 i; i < 108; i++) {
            short[i] = honest[i];
        }
        _expect(short, stub, _malformedData(ElectionDefinitionLib.DecodeError.Truncated, 108));
        bytes memory inNumber = new bytes(70);
        for (uint256 i; i < 70; i++) {
            inNumber[i] = honest[i];
        }
        _expect(inNumber, stub, _malformedData(ElectionDefinitionLib.DecodeError.Truncated, 68));
    }

    // --- the real registry ---------------------------------------------------

    /// The check reads the parameters the election registry recorded: a
    /// ballot naming a definition it never registered is stray, one naming a
    /// tier the definition doesn't list is `ballot-tier`, and one of the
    /// right shape reaches its membership proof, which fails against the
    /// registered root.
    function test_ReadsTheElectionRegistry() public {
        RegistryFixture.installL1Block(vm);
        MockTrusteeRegistry trustees = new MockTrusteeRegistry();
        ElectionRegistry registry =
            new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
        vm.prank(address(0xC4EA));
        bytes32 id = registry.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        // ballot.json's plurality election: three options, k = 2, n = 3.
        (d.threshold, d.panelSize) = (2, 3);
        bytes memory enc = RegistryFixture.approve(defs, trustees, d);
        vm.prank(address(0xC4EA));
        registry.registerDefinition(enc);
        bytes32 h = defs.hash(enc);

        bytes memory honest = _bytes(vm.readFile(V1), ".ballots[0].encoding");
        IElectionParameters reg = IElectionParameters(address(registry));
        _expectRefused(honest, reg, BallotCheckLib.Code.BallotStray);
        bytes memory ours = _withWord(honest, 3, uint256(h));
        _expectRefused(ours, reg, BallotCheckLib.Code.MembershipProof);
        _expectRefused(_withByte(ours, 35, 1), reg, BallotCheckLib.Code.BallotTier);
    }

    // --- properties ----------------------------------------------------------

    /// No change to any one byte of an honest record is admitted: the
    /// header, the election, the tier and the nullifier are checked or
    /// bound by `M`, the committed vote by the ballot hash, and the proof by
    /// the pairing (T-38, T-31).
    function testFuzz_NoOneByteChangeAdmitted(uint256 position, uint8 delta) public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        vm.assume(delta != 0);
        position = position % honest.length;
        honest[position] = bytes1(uint8(honest[position]) ^ delta);
        try lib.check(honest, stub, 6) {
            revert("a changed record was admitted");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            assertTrue(
                selector == BallotCheckLib.BallotMalformed.selector
                    || selector == BallotCheckLib.BallotRefused.selector,
                "an unexpected revert"
            );
        }
    }

    /// The same for a version-4 record with both halves: the author half is
    /// framed, shaped and bound by the ballot hash like the default half.
    function testFuzz_NoOneByteChangeAdmittedV4(uint256 position, uint8 delta) public {
        string memory json = vm.readFile(V4_RECORDS);
        ParametersStub stub = _stubV4(json, ".elections.panels");
        bytes memory honest = _bytes(json, ".ballots[3].encoding");
        lib.check(honest, stub, 14, 14);
        vm.assume(delta != 0);
        position = position % honest.length;
        honest[position] = bytes1(uint8(honest[position]) ^ delta);
        try lib.check(honest, stub, 14, 14) {
            revert("a changed record was admitted");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            assertTrue(
                selector == BallotCheckLib.BallotMalformed.selector
                    || selector == BallotCheckLib.BallotRefused.selector,
                "an unexpected revert"
            );
        }
    }

    /// Arbitrary input is refused with the library's own errors, never
    /// another revert.
    function testFuzz_ArbitraryInputRefused(bytes calldata record) public {
        (, ParametersStub stub) = _honestV1();
        try lib.check(record, stub, 6) {
            revert("arbitrary input admitted");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            assertTrue(
                selector == BallotCheckLib.BallotMalformed.selector
                    || selector == BallotCheckLib.BallotRefused.selector,
                "an unexpected revert"
            );
        }
    }

    /// A record naming the honest ballot's election, with anything after its
    /// tier, is refused with the library's own errors.
    function testFuzz_ArbitraryBodyRefused(bytes calldata body) public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        bytes memory head = new bytes(36);
        for (uint256 i; i < 36; i++) {
            head[i] = honest[i];
        }
        try lib.check(bytes.concat(head, body), stub, 6) {
            revert("arbitrary body admitted");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            assertTrue(
                selector == BallotCheckLib.BallotMalformed.selector
                    || selector == BallotCheckLib.BallotRefused.selector,
                "an unexpected revert"
            );
        }
    }

    /// An honest ballot of three options at `k = 2` and `n = 3` costs about
    /// 272,000 gas to check, mostly the pairing; framing and shaping the
    /// largest vote in the vectors costs about 400,000.
    function test_Gas() public {
        (bytes memory honest, ParametersStub stub) = _honestV1();
        uint256 used = lib.checkGas(honest, stub, 6);
        assertTrue(used > 200_000 && used < 300_000, "gas of an honest ballot");
        // questions-max: 32 questions of two options at k = 2, the largest
        // vote in the vectors (about 16.8 KB): 128 elements and 448 scalars.
        string memory json = vm.readFile(V3);
        uint256 framing = lib.voteGas(
            _bytes(json, ".ballots[4].encoding"), 3, _paramsV3(json, ".elections.questions-max")
        );
        assertTrue(framing > 300_000 && framing < 500_000, "gas of framing the largest vote");
    }

    // --- helpers -------------------------------------------------------------

    /// Runs every ballot of a record file against a stub holding only its
    /// own election, so another election's ballot is stray.
    function _ballots(string memory path, uint8 version) internal returns (uint256 i) {
        string memory json = vm.readFile(path);
        for (; vm.keyExistsJson(json, _at(".ballots", i, "")); i++) {
            string memory b = _at(".ballots", i, "");
            string memory id = _str(json, string.concat(b, ".id"));
            string memory e =
                string.concat(".elections.", _str(json, string.concat(b, ".election")));
            ParametersStub stub = _stub(json, e, version);
            uint256 qualified = _mask(vm.parseJsonUintArray(json, string.concat(b, ".registered")));
            bytes memory record = _bytes(json, string.concat(b, ".encoding"));
            string memory result = _result(json, b);
            if (_eq(result, "ok") || _eq(result, "option-proof") || _eq(result, "sum-proof")) {
                BallotCheckLib.Admitted memory a = lib.check(record, stub, qualified);
                assertEq(
                    a.ballotHash,
                    bytes32(_bytes(json, string.concat(b, ".ballotHash"))),
                    string.concat("ballot hash of ", id)
                );
                assertEq(
                    a.message,
                    bytes32(_bytes(json, string.concat(b, ".message"))),
                    string.concat("M of ", id)
                );
                assertEq(a.version, version, id);
                if (version >= 2 && vm.keyExistsJson(json, string.concat(b, ".tier"))) {
                    assertEq(
                        a.tier,
                        vm.parseJsonUint(json, string.concat(b, ".tier")),
                        string.concat("tier of ", id)
                    );
                }
            } else {
                _expect(
                    record,
                    stub,
                    abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, _code(result))
                );
            }
        }
    }

    function _decodes(string memory path, uint8 version) internal returns (uint256 i) {
        string memory json = vm.readFile(path);
        string memory e = string.concat(".elections.", _str(json, ".ballots[0].election"));
        ParametersStub stub = _stub(json, e, version);
        for (; vm.keyExistsJson(json, _at(".decode", i, "")); i++) {
            string memory d = _at(".decode", i, "");
            string memory id = _str(json, string.concat(d, ".id"));
            bytes memory record = _bytes(json, string.concat(d, ".encoding"));
            ElectionDefinitionLib.DecodeError code =
                _decodeError(_str(json, string.concat(d, ".error")));
            if (_eq(id, "other-type")) {
                code = ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
            }
            try lib.check(record, stub, 6) {
                revert(string.concat("admitted ", id));
            } catch (bytes memory reason) {
                (ElectionDefinitionLib.DecodeError got, uint256 offset) = _malformed(reason);
                assertTrue(got == code, string.concat("code for ", id));
                if (vm.keyExistsJson(json, string.concat(d, ".offset"))) {
                    assertEq(
                        offset,
                        vm.parseJsonUint(json, string.concat(d, ".offset")),
                        string.concat("offset for ", id)
                    );
                }
            }
        }
    }

    /// A stub with one election of a record file: its definition's panel,
    /// questions and ballot pin, and its tiers' (version 1) or cells'
    /// (versions 2 and 3) roots from the file.
    function _stub(string memory json, string memory e, uint8 version)
        internal
        returns (ParametersStub stub)
    {
        stub = new ParametersStub();
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            version == 1 ? _electionV1(json, e) : _electionV2(json, e);
        assertEq(p.ballotVersion, version, "the definition's ballot pin");
        if (version == 3) _assertQuestions(json, e, p.questions);
        stub.set(bytes32(_bytes(json, string.concat(e, ".definitionHash"))), p, tiers, roots);
    }

    /// A stub with one election of ballot-v4-records.json.
    function _stubV4(string memory json, string memory e) internal returns (ParametersStub stub) {
        stub = new ParametersStub();
        (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots) =
            _electionV4(json, e);
        stub.set(bytes32(_bytes(json, string.concat(e, ".definitionHash"))), p, tiers, roots);
    }

    /// A version-6 definition's parameters, decoded from its bytes and
    /// checked against the panels and questions the file lists beside it,
    /// with its cells' roots from the file.
    function _electionV4(string memory json, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        ElectionDefinitionLib.Definition memory d =
            defs.decode(_bytes(json, string.concat(e, ".definition")));
        (p, tiers, roots) = _electionV2(json, e);
        p.authorThreshold = d.authorThreshold;
        p.authorPanelSize = uint8(d.authorKeys.length);
        assertEq(p.ballotVersion, 4, "the definition's ballot pin");
        _assertQuestions(json, e, p.questions);
        assertEq(p.threshold, vm.parseUint(_str(json, string.concat(e, ".threshold"))), "k");
        assertEq(p.panelSize, vm.parseUint(_str(json, string.concat(e, ".panelSize"))), "n");
        assertEq(
            p.authorThreshold, vm.parseUint(_str(json, string.concat(e, ".authorThreshold"))), "k_A"
        );
        assertEq(
            p.authorPanelSize, vm.parseUint(_str(json, string.concat(e, ".authorPanelSize"))), "n_A"
        );
    }

    function _expectRefusedV4(
        bytes memory record,
        IElectionParameters reg,
        uint256 qualified,
        uint256 authorQualified,
        BallotCheckLib.Code code
    ) internal view {
        try lib.check(record, reg, qualified, authorQualified) {
            revert("admitted");
        } catch (bytes memory reason) {
            assertEq(
                keccak256(reason),
                keccak256(abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, code)),
                "unexpected refusal"
            );
        }
    }

    /// The questions decoded from the definition are the ones the file lists
    /// beside it, so the check is judged against the file's statement.
    function _assertQuestions(
        string memory json,
        string memory e,
        ElectionRegistry.Question[] memory qs
    ) internal view {
        uint256 n;
        for (; vm.keyExistsJson(json, _at(string.concat(e, ".questions"), n, "")); n++) {
            string memory s = _at(string.concat(e, ".questions"), n, "");
            assertTrue(n < qs.length, "the file's question count");
            assertEq(qs[n].method, 1, "selection");
            assertEq(
                qs[n].optionCount,
                vm.parseJsonUint(json, string.concat(s, ".optionCount")),
                "option count"
            );
            assertEq(
                qs[n].minSelections,
                vm.parseJsonUint(json, string.concat(s, ".minSelections")),
                "minimum"
            );
            assertEq(
                qs[n].maxSelections,
                vm.parseJsonUint(json, string.concat(s, ".maxSelections")),
                "maximum"
            );
        }
        assertEq(n, qs.length, "the file's question count");
    }

    function _electionV1(string memory json, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        p = _fromDefinition(defs.decode(_bytes(json, string.concat(e, ".definition"))));
        uint256 n;
        while (vm.keyExistsJson(json, _at(string.concat(e, ".tiers"), n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            string memory t = _at(string.concat(e, ".tiers"), i, "");
            tiers[i] = uint8(vm.parseJsonUint(json, string.concat(t, ".tier")));
            roots[i] = vm.parseUint(_str(json, string.concat(t, ".root")));
        }
    }

    function _electionV2(string memory json, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory p, uint8[] memory tiers, uint256[] memory roots)
    {
        p = _fromDefinition(defs.decode(_bytes(json, string.concat(e, ".definition"))));
        uint256 n;
        while (vm.keyExistsJson(json, _at(string.concat(e, ".cells"), n, ""))) n++;
        tiers = new uint8[](n);
        roots = new uint256[](n);
        for (uint256 i; i < n; i++) {
            string memory c = _at(string.concat(e, ".cells"), i, "");
            assertEq(vm.parseJsonUint(json, string.concat(c, ".cell")), i, "cells in order");
            tiers[i] = uint8(vm.parseJsonUint(json, string.concat(c, ".tier")));
            roots[i] = vm.parseUint(_str(json, string.concat(c, ".root")));
        }
    }

    /// The panel, the questions and the ballot pin of a definition: version
    /// 5's list, or versions 1, 3 and 4's one question.
    function _fromDefinition(ElectionDefinitionLib.Definition memory d)
        internal
        pure
        returns (ElectionRegistry.Parameters memory p)
    {
        ElectionRegistry.Question[] memory qs;
        if (d.version >= 5) {
            qs = new ElectionRegistry.Question[](d.questions.length);
            for (uint256 q; q < qs.length; q++) {
                ElectionDefinitionLib.Question memory dq = d.questions[q];
                qs[q] = ElectionRegistry.Question(
                    dq.method, dq.optionCount, dq.minSelections, dq.maxSelections
                );
            }
        } else {
            qs = new ElectionRegistry.Question[](1);
            qs[0] = ElectionRegistry.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        }
        p = _params(0, d.threshold, d.panelSize, qs);
        for (uint256 i; i < d.pinTypes.length; i++) {
            if (d.pinTypes[i] == 2) p.ballotVersion = d.pinVersions[i];
        }
    }

    function _paramsV3(string memory json, string memory e)
        internal
        view
        returns (ElectionRegistry.Parameters memory)
    {
        uint256 n;
        while (vm.keyExistsJson(json, _at(string.concat(e, ".questions"), n, ""))) n++;
        ElectionRegistry.Question[] memory qs = new ElectionRegistry.Question[](n);
        for (uint256 q; q < n; q++) {
            string memory s = _at(string.concat(e, ".questions"), q, "");
            qs[q] = ElectionRegistry.Question(
                1,
                uint16(vm.parseJsonUint(json, string.concat(s, ".optionCount"))),
                uint16(vm.parseJsonUint(json, string.concat(s, ".minSelections"))),
                uint16(vm.parseJsonUint(json, string.concat(s, ".maxSelections")))
            );
        }
        return _params(
            3,
            vm.parseJsonUint(json, string.concat(e, ".threshold")),
            vm.parseJsonUint(json, string.concat(e, ".panelSize")),
            qs
        );
    }

    function _params(uint8 version, uint256 k, uint256 n, ElectionRegistry.Question[] memory qs)
        internal
        pure
        returns (ElectionRegistry.Parameters memory p)
    {
        p.ballotVersion = version;
        p.threshold = uint8(k);
        p.panelSize = uint8(n);
        p.questions = qs;
        for (uint256 i; i < qs.length; i++) {
            p.optionCount += qs[i].optionCount;
        }
    }

    /// ballot.json's first ballot (`ok-tier-0`) and a stub holding its election.
    function _honestV1() internal returns (bytes memory honest, ParametersStub stub) {
        string memory json = vm.readFile(V1);
        honest = _bytes(json, ".ballots[0].encoding");
        assertTrue(_eq(_str(json, ".ballots[0].id"), "ok-tier-0"), "the honest ballot");
        stub = _stub(json, ".elections.plurality", 1);
    }

    /// Where the honest record's option proofs start: after `vss` (three
    /// options of two commitments) and `share_hashes` (three).
    function _optionProofsAt(bytes memory r) internal pure returns (uint256) {
        uint256 o = BallotCheckLib.VOTE_AT;
        uint256 options = _u32(r, o);
        o += 4;
        for (uint256 j; j < options; j++) {
            o += 4 + 32 * _u32(r, o);
        }
        return o + 4 + 32 * _u32(r, o);
    }

    function _slice(bytes memory r, uint256 from, uint256 length)
        internal
        pure
        returns (bytes memory c)
    {
        c = new bytes(length);
        for (uint256 i; i < length; i++) {
            c[i] = r[from + i];
        }
    }

    function _u32(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 4; i++) {
            v = (v << 8) | uint8(r[o + i]);
        }
    }

    /// `x` as 32 bytes little-endian, read back as a big-endian word.
    function _le(uint256 x) internal pure returns (uint256 w) {
        for (uint256 i; i < 32; i++) {
            w = (w << 8) | ((x >> (8 * i)) & 0xff);
        }
    }

    function _withWord(bytes memory r, uint256 at, uint256 word)
        internal
        pure
        returns (bytes memory c)
    {
        c = bytes.concat(r);
        for (uint256 i; i < 32; i++) {
            c[at + i] = bytes1(uint8(word >> (8 * (31 - i))));
        }
    }

    function _withByte(bytes memory r, uint256 at, uint8 b) internal pure returns (bytes memory c) {
        c = bytes.concat(r);
        c[at] = bytes1(b);
    }

    function _mask(uint256[] memory seats) internal pure returns (uint256 m) {
        for (uint256 i; i < seats.length; i++) {
            m |= 1 << seats[i];
        }
    }

    function _expectRefused(bytes memory record, IElectionParameters reg, BallotCheckLib.Code code)
        internal
        view
    {
        _expect(record, reg, abi.encodeWithSelector(BallotCheckLib.BallotRefused.selector, code));
    }

    function _expectMalformedAt(bytes memory record, IElectionParameters reg, uint256 offset)
        internal
        view
    {
        _expect(record, reg, _malformedData(ElectionDefinitionLib.DecodeError.NonCanonical, offset));
    }

    function _malformedData(ElectionDefinitionLib.DecodeError code, uint256 offset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(BallotCheckLib.BallotMalformed.selector, code, offset);
    }

    function _expect(bytes memory record, IElectionParameters reg, bytes memory expected)
        internal
        view
    {
        try lib.check(record, reg, 6) {
            revert("admitted");
        } catch (bytes memory reason) {
            assertTrue(keccak256(reason) == keccak256(expected), "unexpected refusal");
        }
    }

    function _malformed(bytes memory reason)
        internal
        pure
        returns (ElectionDefinitionLib.DecodeError code, uint256 offset)
    {
        assertTrue(bytes4(reason) == BallotCheckLib.BallotMalformed.selector, "not a decode error");
        bytes memory args = new bytes(reason.length - 4);
        for (uint256 i; i < args.length; i++) {
            args[i] = reason[i + 4];
        }
        (code, offset) = abi.decode(args, (ElectionDefinitionLib.DecodeError, uint256));
    }

    function _isShape(string memory json, string memory b) internal view returns (bool) {
        string memory k = string.concat(b, ".result.code");
        return vm.keyExistsJson(json, k) && _eq(_str(json, k), "validity-shape");
    }

    function _result(string memory json, string memory b) internal pure returns (string memory) {
        return _str(json, string.concat(b, ".result"));
    }

    function _code(string memory s) internal pure returns (BallotCheckLib.Code) {
        bytes32 c = keccak256(bytes(s));
        if (c == keccak256("ballot-stray")) return BallotCheckLib.Code.BallotStray;
        if (c == keccak256("ballot-tier")) return BallotCheckLib.Code.BallotTier;
        if (c == keccak256("ballot-cell")) return BallotCheckLib.Code.BallotCell;
        if (c == keccak256("validity-shape")) return BallotCheckLib.Code.ValidityShape;
        if (c == keccak256("share-hash-unqualified")) {
            return BallotCheckLib.Code.ShareHashUnqualified;
        }
        if (c == keccak256("membership-proof")) return BallotCheckLib.Code.MembershipProof;
        revert(string.concat("unknown result ", s));
    }

    function _decodeError(string memory s)
        internal
        pure
        returns (ElectionDefinitionLib.DecodeError)
    {
        bytes32 c = keccak256(bytes(s));
        if (c == keccak256("truncated")) return ElectionDefinitionLib.DecodeError.Truncated;
        if (c == keccak256("trailing-bytes")) {
            return ElectionDefinitionLib.DecodeError.TrailingBytes;
        }
        if (c == keccak256("length-over-max")) {
            return ElectionDefinitionLib.DecodeError.LengthOverMax;
        }
        if (c == keccak256("unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        if (c == keccak256("unknown-version")) {
            return ElectionDefinitionLib.DecodeError.UnknownVersion;
        }
        if (c == keccak256("invalid-enum")) return ElectionDefinitionLib.DecodeError.InvalidEnum;
        if (c == keccak256("non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", s));
    }

    function _tag(bytes memory ds) internal pure returns (bytes32) {
        bytes memory tag = new bytes(ds.length - 1);
        for (uint256 i; i < tag.length; i++) {
            tag[i] = ds[i + 1];
        }
        assertEq(uint8(ds[0]), tag.length, "tag length byte");
        return keccak256(tag);
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(_str(json, key));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
