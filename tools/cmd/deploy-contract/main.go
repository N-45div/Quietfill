package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/contracts/testtoken"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"
	"extension-scaffold/tools/pkg/validate"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	outFile := flag.String("o", "", "write deployed address to this file (optional)")
	baseTokenF := flag.String("baseToken", os.Getenv("BASE_TOKEN"), "base (auctioned) ERC20 address, e.g. FXRP on Coston2")
	quoteTokenF := flag.String("quoteToken", os.Getenv("QUOTE_TOKEN"), "quote (payment) ERC20 address, e.g. USDT0 on Coston2")
	preflightOnly := flag.Bool("preflight-only", false, "run validation checks and exit without deploying")
	flag.Parse()

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Pre-flight validation ---
	deployer := crypto.PubkeyToAddress(testSupport.Prv.PublicKey)
	logger.Infof("Deployer:             %s", deployer.Hex())
	logger.Infof("Chain ID:             %s", testSupport.ChainID.String())
	logger.Infof("FlareTeeManager:      %s", testSupport.Addresses.FlareTeeManager.Hex())

	if err := validate.AddressNotZero(testSupport.Addresses.FlareTeeManager, "FlareTeeManager"); err != nil {
		fccutils.FatalWithCause(err)
	}
	if err := validate.AddressHasCode(testSupport.ChainClient, testSupport.Addresses.FlareTeeManager, "FlareTeeManager"); err != nil {
		fccutils.FatalWithCause(err)
	}
	if err := validate.KeyHasFunds(testSupport.ChainClient, testSupport.Prv, validate.MinDeployBalance); err != nil {
		fccutils.FatalWithCause(err)
	}

	if *preflightOnly {
		logger.Infof("Pre-flight checks passed. Exiting without deploying.")
		return
	}

	baseToken, quoteToken, err := resolveTokens(testSupport, *baseTokenF, *quoteTokenF)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("Deploying QuietFillAuction contract...")
	address, _, err := instrutils.DeployInstructionSender(testSupport, baseToken, quoteToken)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("QuietFillAuction deployed at: %s", address.Hex())

	// Optionally write address to file for script consumption
	if *outFile != "" {
		os.MkdirAll(filepath.Dir(*outFile), 0755)
		os.WriteFile(*outFile, []byte(address.Hex()), 0644)
	}

	// Machine-readable output on stdout (for scripts). The contract address
	// MUST stay the last line — pre-build.sh captures it with tail -1.
	fmt.Printf("BASE_TOKEN=%s\n", baseToken.Hex())
	fmt.Printf("QUOTE_TOKEN=%s\n", quoteToken.Hex())
	fmt.Println(address.Hex())
}

// resolveTokens returns the escrow token pair for the auction contract.
// On live networks both addresses must be supplied and must be verifiable
// ERC20s; on a local devnet, fresh mintable TestTokens are deployed when no
// addresses are given so the end-to-end flow is self-contained.
func resolveTokens(s *support.Support, baseHex, quoteHex string) (common.Address, common.Address, error) {
	if baseHex != "" && quoteHex != "" {
		base := common.HexToAddress(baseHex)
		quote := common.HexToAddress(quoteHex)
		for _, t := range []struct {
			name string
			addr common.Address
		}{{"base token", base}, {"quote token", quote}} {
			if err := validate.AddressNotZero(t.addr, t.name); err != nil {
				return common.Address{}, common.Address{}, err
			}
			if err := validate.AddressHasCode(s.ChainClient, t.addr, t.name); err != nil {
				return common.Address{}, common.Address{}, err
			}
			if err := describeToken(s, t.addr, t.name); err != nil {
				return common.Address{}, common.Address{}, err
			}
		}
		if base == quote {
			return common.Address{}, common.Address{}, errors.New("base and quote token must differ")
		}
		return base, quote, nil
	}

	if strings.EqualFold(os.Getenv("LOCAL_MODE"), "false") {
		return common.Address{}, common.Address{}, errors.New(
			"BASE_TOKEN and QUOTE_TOKEN must be set on live networks — verify the current " +
				"Coston2 FXRP and USDT0 addresses against official Flare sources before deploying")
	}

	logger.Infof("No token addresses given — deploying mintable TestTokens (local dev only)")
	base, err := deployTestToken(s, "Test FXRP", "FXRP", 6)
	if err != nil {
		return common.Address{}, common.Address{}, err
	}
	quote, err := deployTestToken(s, "Test USDT0", "USDT0", 6)
	if err != nil {
		return common.Address{}, common.Address{}, err
	}
	return base, quote, nil
}

// describeToken confirms symbol() and decimals() answer over RPC, so a wrong
// or non-ERC20 address fails here instead of surfacing later as an opaque
// escrow revert.
func describeToken(s *support.Support, addr common.Address, name string) error {
	token, err := testtoken.NewTestToken(addr, s.ChainClient)
	if err != nil {
		return errors.Errorf("failed to bind %s: %s", name, err)
	}
	symbol, err := token.Symbol(&bind.CallOpts{})
	if err != nil {
		return errors.Errorf("%s at %s does not answer symbol(): %s", name, addr.Hex(), err)
	}
	decimals, err := token.Decimals(&bind.CallOpts{})
	if err != nil {
		return errors.Errorf("%s at %s does not answer decimals(): %s", name, addr.Hex(), err)
	}
	logger.Infof("%s: %s (%s, %d decimals)", name, addr.Hex(), symbol, decimals)
	return nil
}

func deployTestToken(s *support.Support, name, symbol string, decimals uint8) (common.Address, error) {
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Address{}, errors.Errorf("failed to create transactor: %s", err)
	}
	addr, tx, _, err := testtoken.DeployTestToken(opts, s.ChainClient, name, symbol, decimals)
	if err != nil {
		return common.Address{}, errors.Errorf("failed to deploy %s: %s", symbol, err)
	}
	if _, err := support.CheckTx(tx, s.ChainClient); err != nil {
		return common.Address{}, errors.Errorf("%s deployment failed: %s", symbol, err)
	}
	logger.Infof("TestToken %s deployed at: %s", symbol, addr.Hex())
	return addr, nil
}
