// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {QuietFillAuction} from "../contracts/InstructionSender.sol";
import {IERC20} from "../contracts/interfaces/IERC20.sol";
import {ITeeExtensionRegistry} from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../contracts/interfaces/ITeeMachineRegistry.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert() external;
}

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals) {
        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockExtensionRegistry is ITeeExtensionRegistry {
    uint256 public constant EXTENSION_ID = 0x10000;
    uint256 public instructionNonce;
    mapping(uint256 => address) public senders;
    bytes32 public lastOpType;
    bytes32 public lastOpCommand;
    bytes public lastMessage;
    address public lastClaimBackAddress;

    function registerSender(address sender) external {
        senders[EXTENSION_ID] = sender;
    }

    function sendInstructions(address[] calldata, TeeInstructionParams calldata params)
        external
        payable
        returns (bytes32 instructionId)
    {
        require(msg.sender == senders[EXTENSION_ID], "wrong sender");
        lastOpType = params.opType;
        lastOpCommand = params.opCommand;
        lastMessage = params.message;
        lastClaimBackAddress = params.claimBackAddress;
        instructionId = keccak256(abi.encode(++instructionNonce, params.opCommand));
    }

    function nextPublicExtensionId() external pure returns (uint256) {
        return EXTENSION_ID + 1;
    }

    function getTeeExtensionInstructionsSender(uint256 extensionId) external view returns (address) {
        return senders[extensionId];
    }
}

contract MockMachineRegistry is ITeeMachineRegistry {
    address public activeTee;

    function setActiveTee(address tee) external {
        activeTee = tee;
    }

    function getRandomTeeIds(uint256, uint256 count) external view returns (address[] memory teeIds) {
        require(activeTee != address(0) && count == 1, "no tee");
        teeIds = new address[](1);
        teeIds[0] = activeTee;
    }
}

contract QuietFillAuctionTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant TEE_PRIVATE_KEY = 0xA11CE;
    uint256 private constant LOT = 1_000e6;
    uint256 private constant FLOOR = 2e18;
    uint256 private constant CEILING = 2.5e18;
    uint256 private constant CLEAR_PRICE = 2.2e18;

    address private seller = address(0x5100);
    address private bidder = address(0xB100);
    address private loser = address(0xB200);
    address private teeSigner;

    MockERC20 private fxrp;
    MockERC20 private usdt0;
    MockExtensionRegistry private extensionRegistry;
    MockMachineRegistry private machineRegistry;
    QuietFillAuction private quietFill;

    function setUp() public {
        fxrp = new MockERC20("Test FXRP", "FXRP", 6);
        usdt0 = new MockERC20("Test USDT0", "USDT0", 6);
        extensionRegistry = new MockExtensionRegistry();
        machineRegistry = new MockMachineRegistry();
        quietFill = new QuietFillAuction(extensionRegistry, machineRegistry, fxrp, usdt0);

        extensionRegistry.registerSender(address(quietFill));
        quietFill.setExtensionId();
        teeSigner = vm.addr(TEE_PRIVATE_KEY);
        machineRegistry.setActiveTee(teeSigner);

        fxrp.mint(seller, 10_000e6);
        usdt0.mint(bidder, 10_000e6);
        usdt0.mint(loser, 10_000e6);

        vm.prank(seller);
        fxrp.approve(address(quietFill), type(uint256).max);
        vm.prank(bidder);
        usdt0.approve(address(quietFill), type(uint256).max);
        vm.prank(loser);
        usdt0.approve(address(quietFill), type(uint256).max);
    }

    function testHappyPathSettlesFromTeeSignatureAndRefundsSpread() public {
        uint256 auctionId = _createAuction();
        _submitBid(auctionId, bidder);
        _submitBid(auctionId, loser);
        _requestClear(auctionId);

        QuietFillAuction.ClearResult memory result = _winningResult(auctionId, bidder);
        bytes memory signature = _sign(auctionId, result, TEE_PRIVATE_KEY);
        quietFill.settleAuction(auctionId, result, signature);

        QuietFillAuction.Auction memory auction = quietFill.getAuction(auctionId);
        require(auction.state == QuietFillAuction.AuctionState.Settled, "not settled");
        require(auction.winner == bidder, "wrong winner");
        require(auction.quotePaid == 2_200e6, "wrong quote paid");
        require(fxrp.balanceOf(bidder) == LOT, "winner missing FXRP");
        require(usdt0.balanceOf(seller) == 2_200e6, "seller missing USDT0");
        require(usdt0.balanceOf(bidder) == 10_000e6 - 2_200e6, "winner spread not refunded");

        vm.prank(loser);
        quietFill.withdrawQuote(auctionId);
        require(usdt0.balanceOf(loser) == 10_000e6, "loser not refunded");
    }

    function testEncryptedBidEscrowsCeilingOnlyOnce() public {
        uint256 auctionId = _createAuction();
        _submitBid(auctionId, bidder);
        uint256 escrow = quietFill.quoteEscrow(auctionId, bidder);
        require(escrow == 2_500e6, "wrong ceiling escrow");

        _submitBid(auctionId, bidder);
        require(quietFill.quoteEscrow(auctionId, bidder) == escrow, "replacement re-escrowed");
        require(usdt0.balanceOf(address(quietFill)) == escrow, "unexpected token balance");
        require(extensionRegistry.lastOpCommand() == bytes32("PRIVATE_BID"), "wrong FCC command");
    }

    function testForgedTeeSignatureCannotSettle() public {
        uint256 auctionId = _readyAuction();
        QuietFillAuction.ClearResult memory result = _winningResult(auctionId, bidder);
        bytes memory forgedSignature = _sign(auctionId, result, 0xBAD);

        vm.expectRevert();
        quietFill.settleAuction(auctionId, result, forgedSignature);
    }

    function testSignedResultCannotBeTamperedByRelayer() public {
        uint256 auctionId = _readyAuction();
        QuietFillAuction.ClearResult memory result = _winningResult(auctionId, bidder);
        bytes memory signature = _sign(auctionId, result, TEE_PRIVATE_KEY);
        result.unitPriceWei = 2.3e18;

        vm.expectRevert();
        quietFill.settleAuction(auctionId, result, signature);
    }

    function testUnescrowedWinnerCannotSettleEvenWithTeeSignature() public {
        uint256 auctionId = _readyAuction();
        QuietFillAuction.ClearResult memory result = _winningResult(auctionId, address(0xDEAD));
        bytes memory signature = _sign(auctionId, result, TEE_PRIVATE_KEY);

        vm.expectRevert();
        quietFill.settleAuction(auctionId, result, signature);
    }

    function testNoFillReturnsSellerAssetAndUnlocksRefunds() public {
        uint256 auctionId = _createAuction();
        _submitBid(auctionId, bidder);
        _requestClear(auctionId);

        QuietFillAuction.ClearResult memory result = QuietFillAuction.ClearResult({
            contractAddr: address(quietFill),
            auctionId: auctionId,
            winner: address(0),
            unitPriceWei: 0,
            winningNonce: 0,
            winningCommitment: bytes32(0),
            submittedBidCount: 1,
            eligibleBidCount: 0
        });
        quietFill.settleAuction(auctionId, result, _sign(auctionId, result, TEE_PRIVATE_KEY));

        require(fxrp.balanceOf(seller) == 10_000e6, "seller asset not returned");
        vm.prank(bidder);
        quietFill.withdrawQuote(auctionId);
        require(usdt0.balanceOf(bidder) == 10_000e6, "bidder not refunded");
    }

    function testTimeoutRecoveryDoesNotDependOnTee() public {
        uint256 auctionId = _createAuction();
        _submitBid(auctionId, bidder);
        QuietFillAuction.Auction memory auction = quietFill.getAuction(auctionId);
        vm.warp(uint256(auction.settleDeadline) + 1);

        quietFill.cancelTimedOutAuction(auctionId);
        require(fxrp.balanceOf(seller) == 10_000e6, "seller asset stuck");
        vm.prank(bidder);
        quietFill.withdrawQuote(auctionId);
        require(usdt0.balanceOf(bidder) == 10_000e6, "quote stuck");
    }

    function testLateBidIsRejected() public {
        uint256 auctionId = _createAuction();
        QuietFillAuction.Auction memory auction = quietFill.getAuction(auctionId);
        vm.warp(auction.bidDeadline);

        vm.prank(bidder);
        vm.expectRevert();
        quietFill.submitPrivateBid(auctionId, hex"1234");
    }

    function testAuctionPinsRegistrySelectedTee() public {
        uint256 auctionId = _createAuction();
        require(quietFill.getAuction(auctionId).teeId == teeSigner, "TEE not pinned");
    }

    function testSignedResultCannotBeReplayed() public {
        uint256 auctionId = _readyAuction();
        QuietFillAuction.ClearResult memory result = _winningResult(auctionId, bidder);
        bytes memory signature = _sign(auctionId, result, TEE_PRIVATE_KEY);
        quietFill.settleAuction(auctionId, result, signature);

        vm.expectRevert();
        quietFill.settleAuction(auctionId, result, signature);
    }

    function _createAuction() private returns (uint256) {
        uint64 bidDeadline = uint64(block.timestamp + 1 hours);
        uint64 settleDeadline = uint64(block.timestamp + 2 hours);
        vm.prank(seller);
        return quietFill.createAuction(LOT, FLOOR, CEILING, bidDeadline, settleDeadline);
    }

    function _submitBid(uint256 auctionId, address from) private {
        vm.prank(from);
        quietFill.submitPrivateBid(auctionId, hex"01020304");
    }

    function _requestClear(uint256 auctionId) private {
        QuietFillAuction.Auction memory auction = quietFill.getAuction(auctionId);
        vm.warp(auction.bidDeadline);
        quietFill.requestClear(auctionId);
        require(extensionRegistry.lastOpCommand() == bytes32("CLEAR"), "wrong clear command");
    }

    function _readyAuction() private returns (uint256 auctionId) {
        auctionId = _createAuction();
        _submitBid(auctionId, bidder);
        _requestClear(auctionId);
    }

    function _winningResult(uint256 auctionId, address winner)
        private
        view
        returns (QuietFillAuction.ClearResult memory)
    {
        return QuietFillAuction.ClearResult({
            contractAddr: address(quietFill),
            auctionId: auctionId,
            winner: winner,
            unitPriceWei: CLEAR_PRICE,
            winningNonce: 1,
            winningCommitment: keccak256("private bid"),
            submittedBidCount: 1,
            eligibleBidCount: 1
        });
    }

    function _sign(uint256 auctionId, QuietFillAuction.ClearResult memory result, uint256 privateKey)
        private
        returns (bytes memory)
    {
        bytes32 digest = quietFill.teeClearDigest(auctionId, result);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
