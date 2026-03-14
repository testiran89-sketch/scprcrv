// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CrvFlashArb
 * @notice Aave V3 flash-loan arbitrage contract for CRV routes.
 *
 * Flow:
 * 1) Borrow `loanAsset` via flashLoanSimple.
 * 2) Buy CRV on buy DEX.
 * 3) Sell CRV on sell DEX back into loanAsset.
 * 4) Repay flash loan (+premium) within same tx.
 * 5) Keep profit in contract; owner can withdraw to `profitRecipient`.
 *
 * Security notes:
 * - Owner-only execution.
 * - Min-out checks on both swaps.
 * - No cross-chain support (single-chain atomic tx only).
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IAaveV3FlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IUniswapV2RouterLike {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IBalancerVault {
    enum SwapKind {
        GIVEN_IN,
        GIVEN_OUT
    }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address recipient;
        bool toInternalBalance;
    }

    function swap(
        SingleSwap calldata singleSwap,
        FundManagement calldata funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountCalculated);
}

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract CrvFlashArb is IAaveV3FlashLoanSimpleReceiver {
    enum DexKind {
        V2,
        V3,
        BALANCER,
        CURVE
    }

    struct SwapInstruction {
        DexKind dexKind;
        address routerOrPool;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin;
        uint24 v3Fee;
        bytes32 balancerPoolId;
        int128 curveI;
        int128 curveJ;
    }

    struct ArbParams {
        address loanAsset;
        uint256 loanAmount;
        address crvToken;
        SwapInstruction buyLeg;
        SwapInstruction sellLeg;
        uint256 minProfit;
    }

    IAaveV3Pool public immutable aavePool;
    address public owner;
    address public profitRecipient;

    event OwnerUpdated(address indexed newOwner);
    event ProfitRecipientUpdated(address indexed newRecipient);
    event ArbitrageExecuted(address indexed loanAsset, uint256 loanAmount, uint256 premium, uint256 profit);
    event ProfitWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address _aavePool, address _profitRecipient) {
        require(_aavePool != address(0), "POOL_ZERO");
        require(_profitRecipient != address(0), "RECIPIENT_ZERO");
        aavePool = IAaveV3Pool(_aavePool);
        owner = msg.sender;
        profitRecipient = _profitRecipient;
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OWNER_ZERO");
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function setProfitRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "RECIPIENT_ZERO");
        profitRecipient = newRecipient;
        emit ProfitRecipientUpdated(newRecipient);
    }

    function startArbitrage(ArbParams calldata p) external onlyOwner {
        require(p.loanAsset != address(0), "LOAN_ASSET_ZERO");
        require(p.crvToken != address(0), "CRV_ZERO");
        require(p.loanAmount > 0, "AMOUNT_ZERO");

        // Both directions supported by caller-defined buy/sell legs.
        // Example A: buy on Sushi, sell on Uni
        // Example B: buy on Uni, sell on Sushi

        bytes memory params = abi.encode(p);
        aavePool.flashLoanSimple(address(this), p.loanAsset, p.loanAmount, params, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(aavePool), "ONLY_AAVE_POOL");
        require(initiator == address(this), "BAD_INITIATOR");

        ArbParams memory p = abi.decode(params, (ArbParams));
        require(asset == p.loanAsset, "ASSET_MISMATCH");
        require(amount == p.loanAmount, "AMOUNT_MISMATCH");

        uint256 beforeLoanAsset = IERC20(asset).balanceOf(address(this));

        uint256 crvAmount = _swap(p.buyLeg);
        require(crvAmount > 0, "BUY_SWAP_ZERO");

        // Force sell-leg input to be CRV output from buy-leg.
        p.sellLeg.amountIn = crvAmount;
        uint256 finalLoanAsset = _swap(p.sellLeg);
        require(finalLoanAsset > 0, "SELL_SWAP_ZERO");

        uint256 repay = amount + premium;
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));
        require(currentBalance >= repay, "UNPROFITABLE_OR_SLIPPAGE");

        uint256 profit = currentBalance - repay;
        require(profit >= p.minProfit, "PROFIT_BELOW_MIN");

        _safeApprove(asset, address(aavePool), repay);

        emit ArbitrageExecuted(asset, amount, premium, profit);

        // keep any remaining funds in contract as profit
        require(IERC20(asset).balanceOf(address(this)) >= beforeLoanAsset + profit, "BALANCE_CHECK_FAIL");
        return true;
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "TOKEN_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(IERC20(token).transfer(profitRecipient, amount), "TRANSFER_FAIL");
        emit ProfitWithdrawn(token, profitRecipient, amount);
    }

    function _swap(SwapInstruction memory s) internal returns (uint256 amountOut) {
        require(s.routerOrPool != address(0), "DEX_ZERO");
        require(s.tokenIn != address(0) && s.tokenOut != address(0), "TOKEN_ZERO");
        require(s.amountIn > 0, "SWAP_AMOUNT_ZERO");

        if (s.dexKind == DexKind.V2) {
            _safeApprove(s.tokenIn, s.routerOrPool, s.amountIn);
            address[] memory path = new address[](2);
            path[0] = s.tokenIn;
            path[1] = s.tokenOut;
            uint256[] memory amounts = IUniswapV2RouterLike(s.routerOrPool).swapExactTokensForTokens(
                s.amountIn,
                s.amountOutMin,
                path,
                address(this),
                block.timestamp
            );
            return amounts[amounts.length - 1];
        }

        if (s.dexKind == DexKind.V3) {
            _safeApprove(s.tokenIn, s.routerOrPool, s.amountIn);
            IUniswapV3Router.ExactInputSingleParams memory p = IUniswapV3Router.ExactInputSingleParams({
                tokenIn: s.tokenIn,
                tokenOut: s.tokenOut,
                fee: s.v3Fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: s.amountIn,
                amountOutMinimum: s.amountOutMin,
                sqrtPriceLimitX96: 0
            });
            return IUniswapV3Router(s.routerOrPool).exactInputSingle(p);
        }

        if (s.dexKind == DexKind.BALANCER) {
            _safeApprove(s.tokenIn, s.routerOrPool, s.amountIn);
            IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
                poolId: s.balancerPoolId,
                kind: IBalancerVault.SwapKind.GIVEN_IN,
                assetIn: s.tokenIn,
                assetOut: s.tokenOut,
                amount: s.amountIn,
                userData: ""
            });
            IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
                sender: address(this),
                fromInternalBalance: false,
                recipient: address(this),
                toInternalBalance: false
            });
            return IBalancerVault(s.routerOrPool).swap(singleSwap, funds, s.amountOutMin, block.timestamp);
        }

        if (s.dexKind == DexKind.CURVE) {
            _safeApprove(s.tokenIn, s.routerOrPool, s.amountIn);
            return ICurvePool(s.routerOrPool).exchange(s.curveI, s.curveJ, s.amountIn, s.amountOutMin);
        }

        revert("UNSUPPORTED_DEX");
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        // reset then set to support non-standard ERC20s
        require(IERC20(token).approve(spender, 0), "APPROVE_RESET_FAIL");
        require(IERC20(token).approve(spender, amount), "APPROVE_FAIL");
    }
}
