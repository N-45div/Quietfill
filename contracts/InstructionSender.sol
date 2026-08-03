// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";

/// @title QuietFillAuction
/// @notice Escrowed fixed-lot auctions whose encrypted bids are cleared by a
/// Flare Confidential Compute extension. A relayer may submit a clear result,
/// but settlement only accepts the chain-bound signature of an active TEE.
/// The contract is permissionless: anyone can create auctions, bid, request
/// clears, relay results, and recover funds. There are no admin keys.
contract QuietFillAuction {
    bytes32 public constant OP_TYPE_QUIETFILL = bytes32("QUIETFILL");
    bytes32 public constant OP_COMMAND_PRIVATE_BID = bytes32("PRIVATE_BID");
    bytes32 public constant OP_COMMAND_CLEAR = bytes32("CLEAR");

    bytes32 private constant TEE_ACTION_RESULT = bytes32("TEE_ACTION_RESULT");
    bytes32 private constant THRESHOLD_TAG_HASH = keccak256("threshold");
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;
    uint256 private constant SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant MAX_COMPONENT = 1e36;
    uint256 public constant MAX_ENCRYPTED_BID_BYTES = 4096;

    enum AuctionState {
        None,
        Open,
        ClearRequested,
        Settled,
        NoFill,
        Cancelled
    }

    struct Auction {
        address seller;
        address teeId;
        uint256 baseAmount;
        uint256 floorPriceWei;
        uint256 ceilingPriceWei;
        uint256 maxQuoteAmount;
        uint64 bidDeadline;
        uint64 settleDeadline;
        bytes32 clearInstructionId;
        address winner;
        uint256 clearingPriceWei;
        uint256 quotePaid;
        uint256 submittedBidCount;
        uint256 eligibleBidCount;
        AuctionState state;
    }

    /// @dev Must remain byte-for-byte aligned with the TypeScript FCC codec.
    struct ClearResult {
        address contractAddr;
        uint256 auctionId;
        address winner;
        uint256 unitPriceWei;
        uint64 winningNonce;
        bytes32 winningCommitment;
        uint256 submittedBidCount;
        uint256 eligibleBidCount;
    }

    error AuctionNotOpen();
    error AuctionNotClearable();
    error AuctionNotSettleable();
    error AuctionNotTerminal();
    error BidWindowClosed();
    error BidWindowOpen();
    error ComponentTooLarge();
    error EncryptedBidInvalid();
    error ExtensionIdAlreadySet();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();
    error NoActiveTee();
    error InvalidAddress();
    error InvalidAuction();
    error InvalidCollar();
    error InvalidDeadline();
    error InvalidResult();
    error InvalidSignature();
    error NoRefund();
    error ReentrantCall();
    error SafeTransferFailed();
    error SettlementWindowClosed();
    error SettlementWindowOpen();
    error WinnerNotEscrowed();

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        uint256 baseAmount,
        uint256 floorPriceWei,
        uint256 ceilingPriceWei,
        uint256 maxQuoteAmount,
        uint64 bidDeadline,
        uint64 settleDeadline
    );
    event PrivateBidSubmitted(
        uint256 indexed auctionId, address indexed bidder, bytes32 indexed instructionId, bool escrowCreated
    );
    event ClearRequested(uint256 indexed auctionId, bytes32 indexed instructionId);
    event AuctionSettled(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 clearingPriceWei,
        uint256 quotePaid,
        bytes32 winningCommitment,
        uint64 winningNonce
    );
    event AuctionNoFill(uint256 indexed auctionId, uint256 submittedBidCount);
    event AuctionCancelled(uint256 indexed auctionId);
    event QuoteRefunded(uint256 indexed auctionId, address indexed bidder, uint256 amount);

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;
    IERC20 public immutable BASE_TOKEN;
    IERC20 public immutable QUOTE_TOKEN;

    uint256 public nextAuctionId = 1;

    uint256 private _extensionId;
    uint256 private _entered = 1;

    mapping(uint256 auctionId => Auction auction) public auctions;
    mapping(uint256 auctionId => mapping(address bidder => uint256 amount)) public quoteEscrow;

    modifier nonReentrant() {
        if (_entered != 1) revert ReentrantCall();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(
        ITeeExtensionRegistry teeExtensionRegistry,
        ITeeMachineRegistry teeMachineRegistry,
        IERC20 baseToken,
        IERC20 quoteToken
    ) {
        if (
            address(teeExtensionRegistry) == address(0) || address(teeMachineRegistry) == address(0)
                || address(baseToken) == address(0) || address(quoteToken) == address(0)
        ) revert InvalidAddress();
        if (
            address(teeExtensionRegistry).code.length == 0 || address(teeMachineRegistry).code.length == 0
                || address(baseToken).code.length == 0 || address(quoteToken).code.length == 0
        ) revert InvalidAddress();

        TEE_EXTENSION_REGISTRY = teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = teeMachineRegistry;
        BASE_TOKEN = baseToken;
        QUOTE_TOKEN = quoteToken;
    }

    /// @notice Finds and caches this sender's registered public extension ID.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();

        uint256 nextId = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 id = FIRST_PUBLIC_EXTENSION_ID; id < nextId; ++id) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(id) == address(this)) {
                _extensionId = id;
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    function extensionId() external view returns (uint256) {
        return _getExtensionId();
    }

    function createAuction(
        uint256 baseAmount,
        uint256 floorPriceWei,
        uint256 ceilingPriceWei,
        uint64 bidDeadline,
        uint64 settleDeadline
    ) external nonReentrant returns (uint256 auctionId) {
        if (baseAmount == 0) revert InvalidAuction();
        if (floorPriceWei == 0 || ceilingPriceWei < floorPriceWei) revert InvalidCollar();
        if (baseAmount > MAX_COMPONENT || floorPriceWei > MAX_COMPONENT || ceilingPriceWei > MAX_COMPONENT) {
            revert ComponentTooLarge();
        }
        if (bidDeadline <= block.timestamp || settleDeadline <= bidDeadline) {
            revert InvalidDeadline();
        }

        uint256 maxQuoteAmount = _quoteFor(baseAmount, ceilingPriceWei);
        address teeId = _selectTee();
        auctionId = nextAuctionId++;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            teeId: teeId,
            baseAmount: baseAmount,
            floorPriceWei: floorPriceWei,
            ceilingPriceWei: ceilingPriceWei,
            maxQuoteAmount: maxQuoteAmount,
            bidDeadline: bidDeadline,
            settleDeadline: settleDeadline,
            clearInstructionId: bytes32(0),
            winner: address(0),
            clearingPriceWei: 0,
            quotePaid: 0,
            submittedBidCount: 0,
            eligibleBidCount: 0,
            state: AuctionState.Open
        });

        _safeTransferFrom(BASE_TOKEN, msg.sender, address(this), baseAmount);
        emit AuctionCreated(
            auctionId,
            msg.sender,
            baseAmount,
            floorPriceWei,
            ceilingPriceWei,
            maxQuoteAmount,
            bidDeadline,
            settleDeadline
        );
    }

    /// @notice Escrows the public ceiling amount once and sends only ciphertext
    /// to FCC. Replacement bids reuse the existing escrow. The instruction
    /// wraps the ciphertext with the auction ID and the caller, so the TEE can
    /// reject a plaintext that claims a different bidder or auction.
    function submitPrivateBid(uint256 auctionId, bytes calldata encryptedBid)
        external
        payable
        nonReentrant
        returns (bytes32 instructionId)
    {
        Auction storage auction = auctions[auctionId];
        if (auction.state != AuctionState.Open) revert AuctionNotOpen();
        if (block.timestamp >= auction.bidDeadline) revert BidWindowClosed();
        if (encryptedBid.length == 0 || encryptedBid.length > MAX_ENCRYPTED_BID_BYTES) {
            revert EncryptedBidInvalid();
        }

        bool escrowCreated = quoteEscrow[auctionId][msg.sender] == 0;
        if (escrowCreated) {
            quoteEscrow[auctionId][msg.sender] = auction.maxQuoteAmount;
            _safeTransferFrom(QUOTE_TOKEN, msg.sender, address(this), auction.maxQuoteAmount);
        }

        bytes memory bidMessage = abi.encode(auctionId, msg.sender, encryptedBid);
        instructionId = _sendInstruction(auction.teeId, OP_COMMAND_PRIVATE_BID, bidMessage, msg.sender);
        emit PrivateBidSubmitted(auctionId, msg.sender, instructionId, escrowCreated);
    }

    function requestClear(uint256 auctionId) external payable nonReentrant returns (bytes32 instructionId) {
        Auction storage auction = auctions[auctionId];
        if (auction.state != AuctionState.Open) revert AuctionNotClearable();
        if (block.timestamp < auction.bidDeadline) revert BidWindowOpen();
        if (block.timestamp > auction.settleDeadline) revert SettlementWindowClosed();

        bytes memory clearMessage = abi.encode(auctionId, address(this), auction.floorPriceWei, auction.ceilingPriceWei);
        instructionId = _sendInstruction(auction.teeId, OP_COMMAND_CLEAR, clearMessage, msg.sender);
        auction.clearInstructionId = instructionId;
        auction.state = AuctionState.ClearRequested;
        emit ClearRequested(auctionId, instructionId);
    }

    /// @notice Settles an auction from a proxy-polled FCC result. Any account
    /// may relay it; only the active TEE's signature grants authority.
    function settleAuction(uint256 auctionId, ClearResult calldata result, bytes calldata signature)
        external
        nonReentrant
    {
        Auction storage auction = auctions[auctionId];
        if (auction.state != AuctionState.ClearRequested) revert AuctionNotSettleable();
        if (block.timestamp > auction.settleDeadline) revert SettlementWindowClosed();
        if (
            result.contractAddr != address(this) || result.auctionId != auctionId
                || result.eligibleBidCount > result.submittedBidCount
        ) revert InvalidResult();

        bytes32 digest = teeClearDigest(auctionId, result);
        if (_recover(digest, signature) != auction.teeId) revert InvalidSignature();

        auction.submittedBidCount = result.submittedBidCount;
        auction.eligibleBidCount = result.eligibleBidCount;

        if (result.winner == address(0)) {
            if (
                result.unitPriceWei != 0 || result.winningNonce != 0 || result.winningCommitment != bytes32(0)
                    || result.eligibleBidCount != 0
            ) revert InvalidResult();

            auction.state = AuctionState.NoFill;
            _safeTransfer(BASE_TOKEN, auction.seller, auction.baseAmount);
            emit AuctionNoFill(auctionId, result.submittedBidCount);
            return;
        }

        if (
            result.unitPriceWei < auction.floorPriceWei || result.unitPriceWei > auction.ceilingPriceWei
                || result.winningNonce == 0 || result.winningCommitment == bytes32(0) || result.eligibleBidCount == 0
        ) revert InvalidResult();
        if (quoteEscrow[auctionId][result.winner] != auction.maxQuoteAmount) {
            revert WinnerNotEscrowed();
        }

        uint256 quotePaid = _quoteFor(auction.baseAmount, result.unitPriceWei);
        uint256 winnerRefund = auction.maxQuoteAmount - quotePaid;
        quoteEscrow[auctionId][result.winner] = 0;
        auction.winner = result.winner;
        auction.clearingPriceWei = result.unitPriceWei;
        auction.quotePaid = quotePaid;
        auction.state = AuctionState.Settled;

        _safeTransfer(BASE_TOKEN, result.winner, auction.baseAmount);
        _safeTransfer(QUOTE_TOKEN, auction.seller, quotePaid);
        if (winnerRefund != 0) _safeTransfer(QUOTE_TOKEN, result.winner, winnerRefund);

        emit AuctionSettled(
            auctionId, result.winner, result.unitPriceWei, quotePaid, result.winningCommitment, result.winningNonce
        );
    }

    function cancelTimedOutAuction(uint256 auctionId) external nonReentrant {
        Auction storage auction = auctions[auctionId];
        if (auction.state != AuctionState.Open && auction.state != AuctionState.ClearRequested) {
            revert AuctionNotClearable();
        }
        if (block.timestamp <= auction.settleDeadline) revert SettlementWindowOpen();

        auction.state = AuctionState.Cancelled;
        _safeTransfer(BASE_TOKEN, auction.seller, auction.baseAmount);
        emit AuctionCancelled(auctionId);
    }

    function withdrawQuote(uint256 auctionId) external nonReentrant {
        Auction storage auction = auctions[auctionId];
        if (
            auction.state != AuctionState.Settled && auction.state != AuctionState.NoFill
                && auction.state != AuctionState.Cancelled
        ) revert AuctionNotTerminal();

        uint256 amount = quoteEscrow[auctionId][msg.sender];
        if (amount == 0) revert NoRefund();
        quoteEscrow[auctionId][msg.sender] = 0;
        _safeTransfer(QUOTE_TOKEN, msg.sender, amount);
        emit QuoteRefunded(auctionId, msg.sender, amount);
    }

    /// @notice Reproduces Flare tee-node's pinned ActionResult signature hash:
    /// keccak(data), instruction ID, keccak("threshold"), status=1, then the
    /// chain-bound TEE_ACTION_RESULT payload and EIP-191 wrapper.
    function teeClearDigest(uint256 auctionId, ClearResult calldata result) public view returns (bytes32) {
        Auction storage auction = auctions[auctionId];
        if (auction.clearInstructionId == bytes32(0)) revert InvalidResult();

        bytes memory data = abi.encode(
            result.contractAddr,
            result.auctionId,
            result.winner,
            result.unitPriceWei,
            result.winningNonce,
            result.winningCommitment,
            result.submittedBidCount,
            result.eligibleBidCount
        );
        bytes32 actionResultHash = keccak256(
            abi.encodePacked(keccak256(data), auction.clearInstructionId, THRESHOLD_TAG_HASH, bytes1(uint8(1)))
        );
        bytes32 payloadHash = keccak256(abi.encode(TEE_ACTION_RESULT, block.chainid, actionResultHash));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
    }

    function quoteAmount(uint256 baseAmount, uint256 unitPriceWei) external pure returns (uint256) {
        if (baseAmount > MAX_COMPONENT || unitPriceWei > MAX_COMPONENT) {
            revert ComponentTooLarge();
        }
        return _quoteFor(baseAmount, unitPriceWei);
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return auctions[auctionId];
    }

    function _sendInstruction(address teeId, bytes32 command, bytes memory message, address claimant)
        private
        returns (bytes32)
    {
        address[] memory teeIds = new address[](1);
        teeIds[0] = teeId;
        address[] memory cosigners = new address[](0);
        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_QUIETFILL,
            opCommand: command,
            message: message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: claimant
        });
        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    function _selectTee() private view returns (address teeId) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        if (teeIds.length != 1 || teeIds[0] == address(0)) revert NoActiveTee();
        return teeIds[0];
    }

    function _getExtensionId() private view returns (uint256) {
        if (_extensionId == 0) revert ExtensionIdNotSet();
        return _extensionId;
    }

    function _quoteFor(uint256 baseAmount, uint256 unitPriceWei) private pure returns (uint256) {
        uint256 product = baseAmount * unitPriceWei;
        return product == 0 ? 0 : ((product - 1) / PRICE_SCALE) + 1;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER) revert InvalidSignature();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        (bool success, bytes memory returnData) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) {
            revert SafeTransferFailed();
        }
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) private {
        (bool success, bytes memory returnData) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) {
            revert SafeTransferFailed();
        }
    }
}
