// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IStakeManager} from "@account-abstraction/contracts/interfaces/IStakeManager.sol";
import {
    PackedUserOperation
} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";
import {RegistrationAccount} from "../src/RegistrationAccount.sol";
import {RegistrationPaymaster} from "../src/RegistrationPaymaster.sol";
import {GroupTestBase} from "./GroupRegistry.t.sol";
import {GroupFixture} from "./utils/GroupFixture.sol";
import {Vm} from "./utils/Vm.sol";
import {NullifierKeyFixture} from "./utils/NullifierKeyFixture.sol";

/// Stands in for the timelock, as in the paymaster's own tests.
contract TimelockStub {}

/// The registration account and paymaster (docs/spec/contracts.md,
/// Registration account and Registration paymaster) run through EntryPoint
/// v0.8 itself, vendored unmodified, rather than a stand-in: the service's
/// signed operation lands its batch at the deposit's cost, and every way an
/// operation can go wrong is refused by the EntryPoint before it costs
/// anything, or charged at most the paymaster's cap.
contract RegistrationEntryPointTest is GroupTestBase {
    uint256 internal constant MAX_COST = 0.01 ether;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    /// `execute(address,uint256,bytes)`.
    bytes4 internal constant EXECUTE = 0xb61d27f6;
    uint128 internal constant VERIFICATION_GAS = 100_000;
    uint128 internal constant CALL_GAS = 400_000;
    uint128 internal constant PAYMASTER_GAS = 50_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 50_000;
    uint128 internal constant FEE = 1 gwei;
    /// secp256k1's order, to flip a signature's `s` to its high twin.
    uint256 internal constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    EntryPoint internal entryPoint;
    GroupRegistry internal registry;
    RegistrationAccount internal account;
    RegistrationPaymaster internal paymaster;
    address payable internal bundler;
    uint256[] internal secrets;

    function setUp() public {
        string memory json = vm.readFile(GroupFixture.VECTORS);
        address[] memory registrars;
        uint8 threshold;
        (secrets, registrars, threshold) = GroupFixture.keys(json);
        registry = new GroupRegistry(
            threshold, registrars, NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        );
        registry.createGroup(0);
        entryPoint = new EntryPoint();
        account = new RegistrationAccount(IEntryPoint(address(entryPoint)), vm.addr(OWNER_KEY));
        paymaster = new RegistrationPaymaster(
            IStakeManager(address(entryPoint)),
            address(registry),
            address(account),
            address(new TimelockStub()),
            MAX_COST
        );
        paymaster.deposit{value: 1 ether}();
        bundler = payable(address(0xB0B));
    }

    // --- the account's deployment --------------------------------------------

    function test_TheAccountPinsItsEntryPointAndOwner() public view {
        assertTrue(address(account.entryPoint()) == address(entryPoint), "entry point");
        assertTrue(account.owner() == vm.addr(OWNER_KEY), "owner");
        assertEq(account.getNonce(), 0, "nonce");
    }

    function test_TheAccountRefusesAnEntryPointWithoutCodeOrAZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(RegistrationAccount.InvalidDeployment.selector));
        new RegistrationAccount(IEntryPoint(address(0xE1)), vm.addr(OWNER_KEY));
        vm.expectRevert(abi.encodeWithSelector(RegistrationAccount.InvalidDeployment.selector));
        new RegistrationAccount(IEntryPoint(address(entryPoint)), address(0));
        // A key's EIP-7702 delegation to the EntryPoint's code isn't the EntryPoint.
        address eoa = vm.addr(2);
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(entryPoint)));
        vm.expectRevert(abi.encodeWithSelector(RegistrationAccount.InvalidDeployment.selector));
        new RegistrationAccount(IEntryPoint(eoa), vm.addr(OWNER_KEY));
    }

    /// T-62: nothing can later change what `execute` does. The account has
    /// no upgrade entry and no fallback, and its code has no opcode that
    /// could run other code in its place, create a contract, end it or touch
    /// storage, so its validation reads only immutables (ERC-7562).
    function test_TheAccountCanNeitherChangeNorRunOtherCode() public {
        (bool ok,) = address(account)
            .call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(1), ""));
        assertTrue(!ok, "upgradeToAndCall");
        (ok,) = address(account).call(hex"deadbeef");
        assertTrue(!ok, "unknown selector");
        vm.deal(address(this), 1 ether);
        (ok,) = address(account).call{value: 1}("");
        assertTrue(!ok, "plain transfer");
        bytes memory code = address(account).code;
        assertTrue(code.length > 23, "not a delegation or a minimal proxy");
        for (uint256 i; i < code.length; i++) {
            uint8 op = uint8(code[i]);
            // PUSH1 to PUSH32 carry 1 to 32 bytes of data, immutables among them.
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            assertTrue(op != 0x54 && op != 0x55 && op != 0x5c && op != 0x5d, "storage opcode");
            assertTrue(op != 0xf0 && op != 0xf5, "create opcode");
            assertTrue(op != 0xf2 && op != 0xf4 && op != 0xff, "code-replacing opcode");
        }
    }

    function test_OnlyTheEntryPointRunsTheAccount() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        bytes32 hash = entryPoint.getUserOpHash(op);
        vm.expectRevert(bytes("account: not from EntryPoint"));
        account.validateUserOp(op, hash, 0);
        bytes memory call = _addMembersCall();
        vm.prank(vm.addr(OWNER_KEY));
        vm.expectRevert(bytes("account: not from EntryPoint"));
        account.execute(address(registry), 0, call);
        RegistrationAccountCall[] memory calls = new RegistrationAccountCall[](1);
        calls[0] = RegistrationAccountCall(address(registry), 0, call);
        bytes memory batch =
            abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);
        address[2] memory callers = [vm.addr(OWNER_KEY), address(0xCA11)];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok, bytes memory ret) = address(account).call(batch);
            assertTrue(!ok, "executeBatch ran");
            assertEq(
                keccak256(ret),
                keccak256(abi.encodeWithSignature("Error(string)", "account: not from EntryPoint")),
                "executeBatch refusal"
            );
        }
    }

    // --- the operation's hash --------------------------------------------------

    /// The hash the owner signs is EntryPoint v0.8's EIP-712 digest of the
    /// operation, computed here from ERC-4337's definition, so the signing
    /// service can compute it without asking the EntryPoint.
    function test_TheSignedHashIsTheOperationsEip712Digest() public view {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ERC4337"),
                keccak256("1"),
                block.chainid,
                address(entryPoint)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)"
                ),
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData)
            )
        );
        assertEq(
            entryPoint.getUserOpHash(op),
            keccak256(abi.encodePacked(hex"1901", domain, structHash)),
            "user operation hash"
        );
    }

    // --- an operation that lands -----------------------------------------------

    function test_ASignedSponsoredOperationLandsTheBatch() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        uint256 deposit = paymaster.getDeposit();
        vm.recordLogs();
        _handle(op);
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 2, "members added");
        (bool success, uint256 cost) = _outcome(vm.getRecordedLogs());
        assertTrue(success, "operation reverted");
        assertTrue(cost > 0 && cost <= MAX_COST, "cost within the cap");
        assertEq(paymaster.getDeposit(), deposit - cost, "paid from the deposit");
        assertEq(bundler.balance, cost, "bundler compensated");
        assertEq(address(account).balance, 0, "account holds nothing");
        assertEq(entryPoint.balanceOf(address(account)), 0, "account deposit");
        assertEq(account.getNonce(), 1, "nonce used");
    }

    /// The account logs nothing, and nothing the EntryPoint logs for the
    /// operation is text: a batch carries only commitments and approvals
    /// (T-12, T-13).
    function test_ALandedOperationLogsNoText() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        assertTrue(!_looksLikeText(op.callData), "text in calldata");
        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(account), "account logged");
            if (logs[i].emitter == address(entryPoint)) {
                assertTrue(!_looksLikeText(logs[i].data), "text in an EntryPoint log");
            }
        }
    }

    function test_TheSameOperationCannotLandTwice() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        _handle(op);
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce")
        );
        _handle(op);
    }

    /// The registry judges the record: one it refuses (signed for another
    /// position) still costs the deposit, at most the cap, and adds nothing.
    function test_ARefusedRecordCostsAtMostTheCap() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        _handle(op);
        // Signed for position 0 again, now that the group's count is 2.
        PackedUserOperation memory stale = _op(_execute(_addMembersCallAt(0)));
        stale.nonce = 1;
        stale = _signed(stale);
        uint256 deposit = paymaster.getDeposit();
        vm.recordLogs();
        _handle(stale);
        (bool success, uint256 cost) = _outcome(vm.getRecordedLogs());
        assertTrue(!success, "stale record landed");
        assertTrue(cost > 0 && cost <= MAX_COST, "cost within the cap");
        assertEq(paymaster.getDeposit(), deposit - cost, "paid from the deposit");
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 2, "nothing added");
    }

    // --- operations refused before they cost anything --------------------------

    function test_RefusesAnOperationSignedByAnotherKey() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.signature = _signature(0xB0B0, entryPoint.getUserOpHash(op));
        _expectFailed(op, "AA24 signature error");
    }

    function testFuzz_RefusesEveryOtherKey(uint256 key) public {
        vm.assume(key != 0 && key < N && key != OWNER_KEY);
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.signature = _signature(key, entryPoint.getUserOpHash(op));
        _expectFailed(op, "AA24 signature error");
    }

    function testFuzz_RefusesAnyChangeToTheSignature(uint8 at, uint8 delta) public {
        vm.assume(delta != 0);
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        uint256 i = uint256(at) % op.signature.length;
        op.signature[i] = bytes1(uint8(op.signature[i]) ^ delta);
        _expectFailed(op, "AA24 signature error");
    }

    function test_RefusesAMalformedHighSOrOtherVSignature() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        bytes memory good = op.signature;
        op.signature = "";
        _expectFailed(op, "AA24 signature error");
        op.signature = bytes.concat(good, hex"00");
        _expectFailed(op, "AA24 signature error");
        (bytes32 r, bytes32 s, uint8 v) = _split(good);
        op.signature = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : 27);
        _expectFailed(op, "AA24 signature error");
        // A raw recovery id, or an EIP-155-style `v`, in place of 27 or 28.
        uint8[2] memory others = [v - 27, v + 8];
        for (uint256 i; i < others.length; i++) {
            op.signature = abi.encodePacked(r, s, others[i]);
            _expectFailed(op, "AA24 signature error");
        }
    }

    function test_RefusesASignatureForAnotherOperation() public {
        PackedUserOperation memory op = _signed(_op(_execute(_addMembersCall())));
        op.preVerificationGas += 1;
        _expectFailed(op, "AA24 signature error");
    }

    /// Each of the paymaster's rules, applied by the real EntryPoint, with
    /// the operation correctly signed so only the paymaster refuses it.
    function test_ThePaymastersRefusalsReachTheEntryPoint() public {
        // Another call through `execute`: a transfer out of the account.
        _expectUnsponsored(
            _signed(_op(abi.encodeWithSelector(EXECUTE, address(0xD00D), uint256(0), ""))),
            RegistrationPaymaster.Refusal.CallData
        );
        // The same call as a batch of one.
        RegistrationAccountCall[] memory calls = new RegistrationAccountCall[](1);
        calls[0] = RegistrationAccountCall(address(registry), 0, _addMembersCall());
        _expectUnsponsored(
            _signed(_op(abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls))),
            RegistrationPaymaster.Refusal.CallData
        );
        // Paymaster data after the gas limits.
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.paymasterAndData = bytes.concat(op.paymasterAndData, hex"00");
        _expectUnsponsored(_signed(op), RegistrationPaymaster.Refusal.PaymasterData);
        // A fee that takes the most it could cost above the cap.
        op = _op(_execute(_addMembersCall()));
        op.gasFees = bytes32(uint256(FEE) << 128 | 100 gwei);
        _expectUnsponsored(_signed(op), RegistrationPaymaster.Refusal.Cost);
    }

    /// Another account, even one whose owner is the service's key, is
    /// never sponsored (T-52).
    function test_RefusesAnotherAccountWithTheSameOwner() public {
        RegistrationAccount other =
            new RegistrationAccount(IEntryPoint(address(entryPoint)), vm.addr(OWNER_KEY));
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.sender = address(other);
        _expectUnsponsored(_signed(op), RegistrationPaymaster.Refusal.Sender);
    }

    // --- helpers -----------------------------------------------------------------

    /// `addMembers` of two members signed by registrars 1 and 2 for group 0
    /// at its next position.
    function _addMembersCall() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            GroupRegistry.addMembers.selector,
            GroupFixture.addition(
                registry, secrets, GroupFixture.seats(1, 2), 0, GroupFixture.commitments(7, 2)
            )
        );
    }

    /// `addMembers` of two other members signed for group 0 at `position`,
    /// whatever its count is now.
    function _addMembersCallAt(uint64 position) internal view returns (bytes memory) {
        uint256[] memory commitments = GroupFixture.commitments(8, 2);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, position, commitments);
        return abi.encodeWithSelector(
            GroupRegistry.addMembers.selector,
            GroupFixture.encodeAdd(
                0, position, commitments, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d)
            )
        );
    }

    function _execute(bytes memory inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(EXECUTE, address(registry), uint256(0), inner);
    }

    /// An unsigned operation from the account, sponsored by the paymaster,
    /// at the account's next nonce. Its most possible cost is half a
    /// thousandth of an ether, below the cap.
    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.nonce = account.getNonce();
        op.callData = callData;
        op.accountGasLimits = bytes32(uint256(VERIFICATION_GAS) << 128 | CALL_GAS);
        op.preVerificationGas = PRE_VERIFICATION_GAS;
        op.gasFees = bytes32(uint256(FEE) << 128 | FEE);
        op.paymasterAndData = abi.encodePacked(address(paymaster), PAYMASTER_GAS, uint128(0));
    }

    function _signed(PackedUserOperation memory op)
        internal
        view
        returns (PackedUserOperation memory)
    {
        op.signature = _signature(OWNER_KEY, entryPoint.getUserOpHash(op));
        return op;
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        // The EntryPoint pays its beneficiary at the operation's gas price.
        vm.txGasPrice(FEE);
        entryPoint.handleOps(ops, bundler);
    }

    function _expectFailed(PackedUserOperation memory op, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
        _handle(op);
    }

    function _expectUnsponsored(PackedUserOperation memory op, RegistrationPaymaster.Refusal why)
        internal
    {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(RegistrationPaymaster.NotSponsored.selector, why)
            )
        );
        _handle(op);
    }

    /// The `UserOperationEvent`'s success flag and the cost it reports.
    function _outcome(Vm.Log[] memory logs) internal pure returns (bool success, uint256 cost) {
        bytes32 topic = IEntryPoint.UserOperationEvent.selector;
        uint256 found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != topic) continue;
            (, success, cost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            found++;
        }
        assertEq(found, 1, "one operation event");
    }
}

/// The reference account's `Call`, for `executeBatch`.
struct RegistrationAccountCall {
    address target;
    uint256 value;
    bytes data;
}
