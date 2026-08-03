// run-test drives one real QuietFill auction end to end against a running
// FCC stack: escrow, an ECIES-encrypted private bid, the TEE clear, and
// settlement of the TEE-signed result on-chain. Nothing is mocked — the bid
// is encrypted to the live TEE's public key and settlement only succeeds if
// the proxy returns the genuine chain-bound TEE signature.
package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"flag"
	"math/big"
	"os"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/contracts/quietfill"
	"extension-scaffold/tools/pkg/contracts/testtoken"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teenodetypes "github.com/flare-foundation/tee-node/pkg/types"
	teenodeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"github.com/pkg/errors"
)

// instructionFeeWei must match the registry's required instruction fee.
const instructionFeeWei = 1000000

const (
	auctionStateSettled = 3
)

var (
	bidTupleArgs    abi.Arguments
	bidReceiptArgs  abi.Arguments
	clearResultArgs abi.Arguments
)

type privateBid struct {
	Bidder       common.Address
	ContractAddr common.Address
	AuctionId    *big.Int
	Nonce        uint64
	UnitPriceWei *big.Int
	Salt         [32]byte
}

func mustType(t string, components []abi.ArgumentMarshaling) abi.Type {
	ty, err := abi.NewType(t, "", components)
	if err != nil {
		panic(err)
	}
	return ty
}

func init() {
	bidTuple := mustType("tuple", []abi.ArgumentMarshaling{
		{Name: "bidder", Type: "address"},
		{Name: "contractAddr", Type: "address"},
		{Name: "auctionId", Type: "uint256"},
		{Name: "nonce", Type: "uint64"},
		{Name: "unitPriceWei", Type: "uint256"},
		{Name: "salt", Type: "bytes32"},
	})
	bidTupleArgs = abi.Arguments{{Type: bidTuple}}

	addressTy := mustType("address", nil)
	uint256Ty := mustType("uint256", nil)
	uint64Ty := mustType("uint64", nil)
	bytes32Ty := mustType("bytes32", nil)

	bidReceiptArgs = abi.Arguments{
		{Name: "contractAddr", Type: addressTy},
		{Name: "auctionId", Type: uint256Ty},
		{Name: "bidder", Type: addressTy},
		{Name: "nonce", Type: uint64Ty},
		{Name: "bidCommitment", Type: bytes32Ty},
	}
	clearResultArgs = abi.Arguments{
		{Name: "contractAddr", Type: addressTy},
		{Name: "auctionId", Type: uint256Ty},
		{Name: "winner", Type: addressTy},
		{Name: "unitPriceWei", Type: uint256Ty},
		{Name: "winningNonce", Type: uint64Ty},
		{Name: "winningCommitment", Type: bytes32Ty},
		{Name: "submittedBidCount", Type: uint256Ty},
		{Name: "eligibleBidCount", Type: uint256Ty},
	}
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "QuietFillAuction address")
	baseTokenF := flag.String("baseToken", os.Getenv("BASE_TOKEN"), "base (auctioned) ERC20 address")
	quoteTokenF := flag.String("quoteToken", os.Getenv("QUOTE_TOKEN"), "quote (payment) ERC20 address")
	lotF := flag.String("lot", "100000000", "base amount to auction (token units)")
	floorF := flag.String("floor", "2000000000000000000", "floor price (1e18 = 1 quote per base unit)")
	ceilingF := flag.String("ceiling", "2500000000000000000", "ceiling price")
	bidPriceF := flag.String("bidPrice", "2200000000000000000", "dealer's private bid price")
	bidWindowF := flag.Int64("bidWindow", 90, "seconds the bid window stays open")
	flag.Parse()

	senderAddr := common.HexToAddress(*instructionSenderF)
	lot := mustBig(*lotF, "lot")
	floor := mustBig(*floorF, "floor")
	ceiling := mustBig(*ceilingF, "ceiling")
	bidPrice := mustBig(*bidPriceF, "bidPrice")

	if *baseTokenF == "" || *quoteTokenF == "" {
		fccutils.FatalWithCause(errors.New(
			"baseToken and quoteToken are required (pre-build.sh writes them into config/extension.env)"))
	}
	baseAddr := common.HexToAddress(*baseTokenF)
	quoteAddr := common.HexToAddress(*quoteTokenF)

	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	sellerPrv := s.Prv
	sellerAddr := crypto.PubkeyToAddress(sellerPrv.PublicKey)
	dealerPrv := dealerKey(sellerPrv)
	dealerAddr := crypto.PubkeyToAddress(dealerPrv.PublicKey)
	logger.Infof("Seller: %s", sellerAddr.Hex())
	logger.Infof("Dealer: %s", dealerAddr.Hex())

	sender, err := quietfill.NewQuietFillAuction(senderAddr, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Step 0: extension ID must be cached on the contract ---
	logger.Infof("Setting extension ID on QuietFillAuction...")
	if err := instrutils.SetExtensionId(s, senderAddr); err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "ExtensionIdAlreadySet") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed. Error: %s", err))
		}
	}

	// --- Step 1: fetch the live TEE's public key from the proxy ---
	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("cannot fetch TEE info from %s: %s", *pf, err))
	}
	teePub, err := teenodetypes.ParsePubKey(teeInfo.TeeInfo.PublicKey)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("cannot parse TEE public key: %s", err))
	}
	teeID := crypto.PubkeyToAddress(*teePub)
	logger.Infof("Live TEE: %s", teeID.Hex())

	// --- Step 2: fund and approve escrows ---
	baseToken, err := testtoken.NewTestToken(baseAddr, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	quoteToken, err := testtoken.NewTestToken(quoteAddr, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	maxQuote, err := sender.QuoteAmount(&bind.CallOpts{}, lot, ceiling)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("quoteAmount call failed: %s", err))
	}

	ensureFunds(s, baseToken, "base", sellerAddr, sellerPrv, lot)
	ensureFunds(s, quoteToken, "quote", dealerAddr, dealerPrv, maxQuote)

	sendTx(s, "approve base escrow", func(opts *bind.TransactOpts) (txn, error) {
		return baseToken.Approve(opts, senderAddr, lot)
	}, sellerPrv, nil)
	sendTx(s, "approve quote escrow", func(opts *bind.TransactOpts) (txn, error) {
		return quoteToken.Approve(opts, senderAddr, maxQuote)
	}, dealerPrv, nil)

	// --- Step 3: seller creates the auction ---
	now := time.Now().Unix()
	bidDeadline := uint64(now + *bidWindowF)
	settleDeadline := bidDeadline + 1800

	receipt := sendTx(s, "createAuction", func(opts *bind.TransactOpts) (txn, error) {
		return sender.CreateAuction(opts, lot, floor, ceiling, bidDeadline, settleDeadline)
	}, sellerPrv, nil)

	var auctionID *big.Int
	for _, l := range receipt.Logs {
		if ev, err := sender.ParseAuctionCreated(*l); err == nil {
			auctionID = ev.AuctionId
			break
		}
	}
	if auctionID == nil {
		fccutils.FatalWithCause(errors.New("AuctionCreated event not found"))
	}
	logger.Infof("Auction %s created (bid deadline %d, settle deadline %d)", auctionID, bidDeadline, settleDeadline)

	auction, err := sender.GetAuction(&bind.CallOpts{}, auctionID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if auction.TeeId != teeID {
		fccutils.FatalWithCause(errors.Errorf(
			"auction pinned TEE %s but the proxy serves TEE %s — bids encrypted to this proxy cannot clear this auction",
			auction.TeeId.Hex(), teeID.Hex()))
	}
	logger.Infof("Registry-pinned TEE matches the live proxy TEE")

	// --- Step 4: dealer encrypts and submits the private bid ---
	var salt [32]byte
	if _, err := rand.Read(salt[:]); err != nil {
		fccutils.FatalWithCause(err)
	}
	plaintext, err := bidTupleArgs.Pack(privateBid{
		Bidder:       dealerAddr,
		ContractAddr: senderAddr,
		AuctionId:    auctionID,
		Nonce:        1,
		UnitPriceWei: bidPrice,
		Salt:         salt,
	})
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("failed to ABI-encode bid: %s", err))
	}
	ciphertext, err := teenodeutils.Encrypt(plaintext, teePub)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("ECIES encryption failed: %s", err))
	}
	logger.Infof("Bid encrypted to the TEE public key (%d bytes ciphertext)", len(ciphertext))

	receipt = sendTx(s, "submitPrivateBid", func(opts *bind.TransactOpts) (txn, error) {
		return sender.SubmitPrivateBid(opts, auctionID, ciphertext)
	}, dealerPrv, big.NewInt(instructionFeeWei))

	var bidInstructionID common.Hash
	for _, l := range receipt.Logs {
		if ev, err := sender.ParsePrivateBidSubmitted(*l); err == nil {
			bidInstructionID = ev.InstructionId
			break
		}
	}
	if bidInstructionID == (common.Hash{}) {
		fccutils.FatalWithCause(errors.New("PrivateBidSubmitted event not found"))
	}
	logger.Infof("Bid instruction sent: %s", bidInstructionID.Hex())

	// --- Step 5: the TEE acknowledges the bid with a price-free receipt ---
	bidResp := pollResult(*pf, bidInstructionID)
	if bidResp.Result.Status != 1 {
		fccutils.FatalWithCause(errors.Errorf("TEE rejected the bid: %s", bidResp.Result.Log))
	}
	receiptVals, err := bidReceiptArgs.Unpack(bidResp.Result.Data)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("cannot decode bid receipt: %s", err))
	}
	if got := receiptVals[2].(common.Address); got != dealerAddr {
		fccutils.FatalWithCause(errors.Errorf("bid receipt names bidder %s, want %s", got.Hex(), dealerAddr.Hex()))
	}
	commitment := receiptVals[4].([32]byte)
	logger.Infof("Bid receipt verified: commitment %s (no price in receipt)", common.Hash(commitment).Hex())

	// --- Step 6: wait out the bid window, then anyone requests the clear ---
	wait := time.Until(time.Unix(int64(bidDeadline)+2, 0))
	if wait > 0 {
		logger.Infof("Waiting %s for the bid window to close...", wait.Round(time.Second))
		time.Sleep(wait)
	}

	receipt = sendTxRetry(s, "requestClear", func(opts *bind.TransactOpts) (txn, error) {
		return sender.RequestClear(opts, auctionID)
	}, sellerPrv, big.NewInt(instructionFeeWei), 5)

	var clearInstructionID common.Hash
	for _, l := range receipt.Logs {
		if ev, err := sender.ParseClearRequested(*l); err == nil {
			clearInstructionID = ev.InstructionId
			break
		}
	}
	if clearInstructionID == (common.Hash{}) {
		fccutils.FatalWithCause(errors.New("ClearRequested event not found"))
	}
	logger.Infof("Clear instruction sent: %s", clearInstructionID.Hex())

	// --- Step 7: fetch the TEE-signed clear result from the proxy ---
	clearResp := pollResult(*pf, clearInstructionID)
	if clearResp.Result.Status != 1 {
		fccutils.FatalWithCause(errors.Errorf("TEE clear failed: %s", clearResp.Result.Log))
	}
	if clearResp.Result.SubmissionTag != teenodetypes.Threshold {
		fccutils.FatalWithCause(errors.Errorf(
			"clear result carries submission tag %q, need %q — the contract only verifies threshold-tagged signatures",
			clearResp.Result.SubmissionTag, teenodetypes.Threshold))
	}
	if len(clearResp.Signature) != 65 {
		fccutils.FatalWithCause(errors.Errorf("proxy returned %d-byte TEE signature, want 65", len(clearResp.Signature)))
	}

	clearVals, err := clearResultArgs.Unpack(clearResp.Result.Data)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("cannot decode clear result: %s", err))
	}
	result := quietfill.QuietFillAuctionClearResult{
		ContractAddr:      clearVals[0].(common.Address),
		AuctionId:         clearVals[1].(*big.Int),
		Winner:            clearVals[2].(common.Address),
		UnitPriceWei:      clearVals[3].(*big.Int),
		WinningNonce:      clearVals[4].(uint64),
		WinningCommitment: clearVals[5].([32]byte),
		SubmittedBidCount: clearVals[6].(*big.Int),
		EligibleBidCount:  clearVals[7].(*big.Int),
	}
	if result.Winner != dealerAddr || result.UnitPriceWei.Cmp(bidPrice) != 0 {
		fccutils.FatalWithCause(errors.Errorf(
			"unexpected clear outcome: winner %s at %s (submitted %s, eligible %s)",
			result.Winner.Hex(), result.UnitPriceWei, result.SubmittedBidCount, result.EligibleBidCount))
	}
	logger.Infof("TEE cleared auction: winner %s at unit price %s", result.Winner.Hex(), result.UnitPriceWei)

	// --- Step 8: relay the signed result into settleAuction ---
	receipt = sendTx(s, "settleAuction", func(opts *bind.TransactOpts) (txn, error) {
		return sender.SettleAuction(opts, auctionID, result, clearResp.Signature)
	}, sellerPrv, nil)

	settled := false
	for _, l := range receipt.Logs {
		if ev, err := sender.ParseAuctionSettled(*l); err == nil {
			logger.Infof("AuctionSettled: winner %s, clearing price %s, quote paid %s",
				ev.Winner.Hex(), ev.ClearingPriceWei, ev.QuotePaid)
			settled = true
			break
		}
	}
	if !settled {
		fccutils.FatalWithCause(errors.New("AuctionSettled event not found"))
	}

	// --- Step 9: verify final on-chain state and balances ---
	auction, err = sender.GetAuction(&bind.CallOpts{}, auctionID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if auction.State != auctionStateSettled {
		fccutils.FatalWithCause(errors.Errorf("auction state is %d, want Settled", auction.State))
	}
	dealerBase, _ := baseToken.BalanceOf(&bind.CallOpts{}, dealerAddr)
	sellerQuote, _ := quoteToken.BalanceOf(&bind.CallOpts{}, sellerAddr)
	logger.Infof("Dealer base balance:  %s", dealerBase)
	logger.Infof("Seller quote balance: %s", sellerQuote)

	logger.Infof("========================================")
	logger.Infof(" QuietFill end-to-end auction PASSED")
	logger.Infof("   contract:          %s", senderAddr.Hex())
	logger.Infof("   auction:           %s", auctionID)
	logger.Infof("   TEE:               %s", teeID.Hex())
	logger.Infof("   bid instruction:   %s", bidInstructionID.Hex())
	logger.Infof("   clear instruction: %s", clearInstructionID.Hex())
	logger.Infof("   settlement tx:     %s", receipt.TxHash.Hex())
	logger.Infof("========================================")
}

type txn = *types.Transaction

func mustBig(v, name string) *big.Int {
	n, ok := new(big.Int).SetString(v, 10)
	if !ok || n.Sign() <= 0 {
		fccutils.FatalWithCause(errors.Errorf("invalid %s: %q", name, v))
	}
	return n
}

func dealerKey(fallback *ecdsa.PrivateKey) *ecdsa.PrivateKey {
	raw := strings.TrimPrefix(strings.TrimPrefix(os.Getenv("DEALER_PRIVATE_KEY"), "0x"), "0X")
	if raw == "" {
		logger.Infof("DEALER_PRIVATE_KEY not set — the deployer account plays both seller and dealer")
		return fallback
	}
	key, err := crypto.HexToECDSA(raw)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("invalid DEALER_PRIVATE_KEY: %s", err))
	}
	return key
}

// ensureFunds tops the holder up from the token's mint function when the
// balance is short. Real tokens have no public mint — in that case the holder
// must already be funded (e.g. from the Coston2 faucet).
func ensureFunds(s *support.Support, token *testtoken.TestToken, name string, holder common.Address, holderPrv *ecdsa.PrivateKey, needed *big.Int) {
	balance, err := token.BalanceOf(&bind.CallOpts{}, holder)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("balanceOf(%s token) failed: %s", name, err))
	}
	if balance.Cmp(needed) >= 0 {
		return
	}
	logger.Infof("Minting %s %s tokens to %s (test token)", needed, name, holder.Hex())
	opts, err := bind.NewKeyedTransactorWithChainID(holderPrv, s.ChainID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	tx, err := token.Mint(opts, holder, needed)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf(
			"%s token balance %s is below the required %s and mint() failed (%s) — fund the account from a faucet",
			name, balance, needed, err))
	}
	if _, err := support.CheckTx(tx, s.ChainClient); err != nil {
		fccutils.FatalWithCause(err)
	}
}

func sendTx(s *support.Support, label string, call func(*bind.TransactOpts) (txn, error), key *ecdsa.PrivateKey, value *big.Int) *types.Receipt {
	return sendTxRetry(s, label, call, key, value, 1)
}

func sendTxRetry(s *support.Support, label string, call func(*bind.TransactOpts) (txn, error), key *ecdsa.PrivateKey, value *big.Int, attempts int) *types.Receipt {
	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(5 * time.Second)
		}
		opts, err := bind.NewKeyedTransactorWithChainID(key, s.ChainID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		opts.Value = value
		tx, err := call(opts)
		if err != nil {
			reason := fccutils.DecodeRevertReason(err)
			if reason != "" {
				lastErr = errors.Errorf("%s reverted: %s", label, reason)
			} else {
				lastErr = errors.Errorf("%s failed: %s", label, err)
			}
			continue
		}
		receipt, err := support.CheckTx(tx, s.ChainClient)
		if err != nil {
			lastErr = errors.Errorf("%s: %s", label, err)
			continue
		}
		logger.Infof("%s mined: %s", label, tx.Hash().Hex())
		return receipt
	}
	fccutils.FatalWithCause(lastErr)
	return nil
}

// pollResult keeps asking the proxy for an action result until it stops being
// pending. fccutils.ActionResult itself retries transport errors.
func pollResult(proxyURL string, id common.Hash) *teenodetypes.ActionResponse {
	var last *teenodetypes.ActionResponse
	for i := 0; i < 20; i++ {
		resp, err := fccutils.ActionResult(proxyURL, id)
		if err == nil {
			if resp.Result.Status != 2 {
				return resp
			}
			last = resp
		}
		time.Sleep(3 * time.Second)
	}
	if last != nil {
		fccutils.FatalWithCause(errors.Errorf("result for %s still pending after polling", id.Hex()))
	}
	fccutils.FatalWithCause(errors.Errorf("no result for %s from proxy", id.Hex()))
	return nil
}
