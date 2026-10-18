// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {IStakeManager} from "@account-abstraction/contracts/interfaces/IStakeManager.sol";
import {
    PackedUserOperation
} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";
import {RegistrationPaymaster} from "../src/RegistrationPaymaster.sol";
import {GroupTestBase} from "./GroupRegistry.t.sol";
import {GroupFixture} from "./utils/GroupFixture.sol";
import {MockAccount, MockEntryPoint} from "./utils/MockEntryPoint.sol";
import {Vm} from "./utils/Vm.sol";
import {NullifierKeyFixture} from "./utils/NullifierKeyFixture.sol";

/// Stands in for the timelock: any contract will do, since the paymaster
/// can only check that its admin has code.
contract AdminStub {}

/// The registration paymaster (docs/spec/contracts.md, Registration paymaster):
/// it sponsors exactly the signing service's `addMembers` calls, at most
/// `maxCost` each, and its admin can only move funds.
contract RegistrationPaymasterTest is GroupTestBase {
    uint256 internal constant MAX_COST = 0.01 ether;
    /// `execute(address,uint256,bytes)`.
    bytes4 internal constant EXECUTE = 0xb61d27f6;
    /// Where `execute`'s bytes data starts in its calldata.
    uint256 internal constant INNER = 132;

    MockEntryPoint internal entryPoint;
    GroupRegistry internal registry;
    MockAccount internal service;
    address internal admin;
    RegistrationPaymaster internal paymaster;
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
        entryPoint = new MockEntryPoint();
        service = new MockAccount(address(entryPoint));
        admin = address(new AdminStub());
        paymaster =
            _deploy(address(entryPoint), address(registry), address(service), admin, MAX_COST);
        paymaster.deposit{value: 1 ether}();
    }

    // --- deployment ----------------------------------------------------------

    function test_DeploymentPinsItsParties() public view {
        assertTrue(address(paymaster.entryPoint()) == address(entryPoint), "entry point");
        assertTrue(paymaster.registry() == address(registry), "registry");
        assertTrue(paymaster.service() == address(service), "service");
        assertTrue(paymaster.admin() == admin, "admin");
        assertEq(paymaster.maxCost(), MAX_COST, "max cost");
        assertEq(paymaster.getDeposit(), 1 ether, "deposit");
    }

    function test_DeploymentRefusesAnEntryPointOrRegistryWithoutCode() public {
        _expectDeployRefused(address(0xE1), address(registry), address(service), admin, MAX_COST);
        _expectDeployRefused(address(entryPoint), address(0xE2), address(service), admin, MAX_COST);
    }

    /// T-62: no single key administers the deposit.
    function test_DeploymentRefusesASingleKeyAdmin() public {
        address eoa = vm.addr(1);
        _expectDeployRefused(
            address(entryPoint), address(registry), address(service), eoa, MAX_COST
        );
        // An EIP-7702 delegation: a key's account running another contract's code.
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(admin)));
        _expectDeployRefused(
            address(entryPoint), address(registry), address(service), eoa, MAX_COST
        );
    }

    function test_DeploymentRefusesNoServiceOrNoCap() public {
        _expectDeployRefused(address(entryPoint), address(registry), address(0), admin, MAX_COST);
        _expectDeployRefused(address(entryPoint), address(registry), address(service), admin, 0);
    }

    function test_TheServiceAccountMayBeDeployedLater() public {
        RegistrationPaymaster p =
            _deploy(address(entryPoint), address(registry), vm.addr(2), admin, MAX_COST);
        assertTrue(p.service() == vm.addr(2), "counterfactual service");
    }

    // --- sponsorship ---------------------------------------------------------

    function test_SponsorsTheServicesAddMembersCall() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        vm.prank(address(entryPoint));
        (bytes memory context, uint256 validationData) =
            paymaster.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        assertEq(context.length, 0, "context");
        assertEq(validationData, 0, "validation data");
    }

    /// The sponsored operation lands the registrars' batch, paid from the deposit.
    function test_ASponsoredOperationAddsTheBatch() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        vm.recordLogs();
        assertTrue(entryPoint.handleOp(paymaster, op, MAX_COST), "operation reverted");
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 2, "members added");
        assertEq(paymaster.getDeposit(), 1 ether - MAX_COST, "charged");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(paymaster), "the paymaster logs nothing");
        }
    }

    function test_OnlyTheEntryPointValidates() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        vm.expectRevert(abi.encodeWithSelector(RegistrationPaymaster.NotEntryPoint.selector));
        paymaster.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
    }

    /// T-52, T-13: no one but the service is sponsored, not even with the
    /// service's own valid call.
    function testFuzz_RefusesEveryOtherSender(address sender) public {
        vm.assume(sender != address(service));
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.sender = sender;
        _expectRefused(op, MAX_COST, RegistrationPaymaster.Refusal.Sender);
    }

    function test_RefusesAnAccountDeployment() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.initCode = abi.encodePacked(address(registry), hex"00");
        _expectRefused(op, MAX_COST, RegistrationPaymaster.Refusal.InitCode);
    }

    function test_RefusesPaymasterDataOfAnyOtherLength() public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        op.paymasterAndData =
            abi.encodePacked(address(paymaster), uint128(1e5), uint128(0), hex"00");
        _expectRefused(op, MAX_COST, RegistrationPaymaster.Refusal.PaymasterData);
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(1e5), uint120(0));
        _expectRefused(op, MAX_COST, RegistrationPaymaster.Refusal.PaymasterData);
    }

    /// T-52: one operation costs the deposit at most `maxCost`.
    function testFuzz_RefusesAnyCostAboveTheCap(uint256 cost) public {
        PackedUserOperation memory op = _op(_execute(_addMembersCall()));
        if (cost > MAX_COST) {
            _expectRefused(op, cost, RegistrationPaymaster.Refusal.Cost);
        } else {
            vm.prank(address(entryPoint));
            paymaster.validatePaymasterUserOp(op, bytes32(0), cost);
        }
    }

    function test_RefusesEveryOtherCall() public {
        bytes memory inner = _addMembersCall();
        bytes memory good = _execute(inner);
        bytes[] memory bad = new bytes[](16);
        // Another account function, another target, a value.
        bad[0] = _replaceWord(good, 0, bytes32(bytes4(0x47e1da2a)), 4);
        bad[1] = _replaceWord(good, 4, bytes32(uint256(uint160(address(paymaster)))), 32);
        bad[2] = _replaceWord(good, 36, bytes32(uint256(1)), 32);
        // The target with a dirty upper word: not what the account decodes.
        bad[3] =
            _replaceWord(good, 4, bytes32(uint256(uint160(address(registry))) | (1 << 160)), 32);
        // Another offset, a length past the end, trailing bytes, dirty padding.
        bad[4] = _replaceWord(good, 68, bytes32(uint256(0x80)), 32);
        bad[5] = _replaceWord(good, 100, bytes32(inner.length + 32), 32);
        bad[6] = bytes.concat(good, bytes32(0));
        bad[7] = bytes.concat(good);
        bad[7][bad[7].length - 1] = 0x01;
        // The registry's other calls, and nothing at all.
        bad[8] = _execute(abi.encodeWithSelector(GroupRegistry.removeMembers.selector, inner));
        bad[9] = _execute(abi.encodeWithSelector(GroupRegistry.createGroup.selector, uint256(0)));
        bad[10] = _execute(hex"");
        bad[11] = hex"";
        // `addMembers` not exactly encoded: bytes after the record (in the
        // same padded length, or a word more), another offset, another length.
        uint256 recordLength = uint256(_wordAt(inner, 36));
        bad[12] = _execute(bytes.concat(inner, new bytes(10)));
        bad[13] = _execute(bytes.concat(inner, bytes32(0)));
        bad[14] = _execute(_replaceWord(inner, 4, bytes32(uint256(0x40)), 32));
        bad[15] = _execute(_replaceWord(inner, 36, bytes32(recordLength - 32), 32));
        for (uint256 i; i < bad.length; i++) {
            _expectRefused(_op(bad[i]), MAX_COST, RegistrationPaymaster.Refusal.CallData);
        }
    }

    /// Changing any byte of the sponsored call outside the record's own
    /// bytes is refused: only the record is left to the registry (T-17).
    function testFuzz_RefusesAnyChangeOutsideTheRecord(uint256 at, uint8 delta) public {
        bytes memory inner = _addMembersCall();
        bytes memory c = _execute(inner);
        at = at % c.length;
        vm.assume(delta != 0 && (at < INNER + 4 || at >= INNER + inner.length));
        c[at] = bytes1(uint8(c[at]) ^ delta);
        _expectRefused(_op(c), MAX_COST, RegistrationPaymaster.Refusal.CallData);
    }

    /// The record itself is the registry's to judge: a changed record is
    /// sponsored, and refused by the registry, which costs the deposit at
    /// most `maxCost` (T-69: the residual of a seized service).
    function test_TheRegistryJudgesTheRecord() public {
        bytes memory inner = _addMembersCall();
        // A byte of the first commitment, after the selector, the offset,
        // the length and the record's 18-byte head.
        inner[4 + 64 + 18] = bytes1(uint8(inner[4 + 64 + 18]) ^ 1);
        PackedUserOperation memory op = _op(_execute(inner));
        assertTrue(!entryPoint.handleOp(paymaster, op, MAX_COST), "operation landed");
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 0, "no members");
        assertEq(paymaster.getDeposit(), 1 ether - MAX_COST, "charged");
    }

    function test_PostOpIsNeverUsed() public {
        vm.prank(address(entryPoint));
        vm.expectRevert(abi.encodeWithSelector(RegistrationPaymaster.PostOpNotUsed.selector));
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
    }

    /// Nothing the paymaster sponsors carries text (contracts skill, No PII):
    /// the call is fixed words and the registry's record.
    function test_TheSponsoredCallCarriesNoText() public view {
        assertTrue(!_looksLikeText(_execute(_addMembersCall())), "text in calldata");
    }

    // --- funds ---------------------------------------------------------------

    function test_AnyoneMayDeposit() public {
        vm.deal(address(0xD0), 1 ether);
        vm.prank(address(0xD0));
        paymaster.deposit{value: 0.5 ether}();
        assertEq(paymaster.getDeposit(), 1.5 ether, "deposit");
    }

    function test_OnlyTheAdminMovesFunds() public {
        vm.deal(address(this), 1 ether);
        address payable to = payable(address(0xBEEF));
        bytes memory notAdmin = abi.encodeWithSelector(RegistrationPaymaster.NotAdmin.selector);
        vm.expectRevert(notAdmin);
        paymaster.withdrawTo(to, 1);
        vm.expectRevert(notAdmin);
        paymaster.addStake{value: 1}(1);
        vm.expectRevert(notAdmin);
        paymaster.unlockStake();
        vm.expectRevert(notAdmin);
        paymaster.withdrawStake(to);
        vm.prank(address(service));
        vm.expectRevert(notAdmin);
        paymaster.withdrawTo(to, 1);
    }

    function test_TheAdminWithdrawsAndStakes() public {
        address payable to = payable(address(0xBEEF));
        vm.prank(admin);
        paymaster.withdrawTo(to, 0.25 ether);
        assertEq(to.balance, 0.25 ether, "withdrawn");
        assertEq(paymaster.getDeposit(), 0.75 ether, "deposit");

        vm.deal(admin, 1 ether);
        vm.prank(admin);
        paymaster.addStake{value: 1 ether}(86400);
        assertEq(entryPoint.stakeOf(address(paymaster)), 1 ether, "staked");
        vm.prank(admin);
        paymaster.unlockStake();
        vm.prank(admin);
        paymaster.withdrawStake(to);
        assertEq(to.balance, 1.25 ether, "stake withdrawn");
    }

    // --- helpers -------------------------------------------------------------

    function _deploy(address ep, address reg, address svc, address adm, uint256 cap)
        internal
        returns (RegistrationPaymaster)
    {
        return new RegistrationPaymaster(IStakeManager(ep), reg, svc, adm, cap);
    }

    function _expectDeployRefused(address ep, address reg, address svc, address adm, uint256 cap)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(RegistrationPaymaster.InvalidDeployment.selector));
        _deploy(ep, reg, svc, adm, cap);
    }

    function _expectRefused(
        PackedUserOperation memory op,
        uint256 cost,
        RegistrationPaymaster.Refusal refusal
    ) internal {
        vm.prank(address(entryPoint));
        vm.expectRevert(
            abi.encodeWithSelector(RegistrationPaymaster.NotSponsored.selector, refusal)
        );
        paymaster.validatePaymasterUserOp(op, bytes32(0), cost);
    }

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

    /// `execute(registry, 0, inner)`, ABI-encoded as the account expects.
    function _execute(bytes memory inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(EXECUTE, address(registry), uint256(0), inner);
    }

    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(service);
        op.callData = callData;
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(1e5), uint128(0));
    }

    function _wordAt(bytes memory b, uint256 at) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 32), at))
        }
    }

    function _replaceWord(bytes memory b, uint256 at, bytes32 word, uint256 len)
        internal
        pure
        returns (bytes memory out)
    {
        out = bytes.concat(b);
        for (uint256 i; i < len; i++) {
            out[at + i] = word[i];
        }
    }
}
