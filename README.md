# Liquidator Bot for Revert Lend

A sophisticated automated liquidation bot for the Revert Lend protocol on Arbitrum. This bot monitors Uniswap V3 positions used as collateral and automatically liquidates undercollateralized positions to maintain protocol solvency while capturing liquidation rewards.

## Overview

The Revert Lend protocol allows users to borrow assets against their Uniswap V3 LP positions. When the value of the collateral falls below a certain threshold relative to the debt, the position becomes eligible for liquidation. This bot:

- Monitors all active lending positions in real-time via WebSocket
- Calculates collateral value vs debt value continuously
- Detects undercollateralized positions instantly
- Executes liquidations using flashloans (no upfront capital required)
- Optimizes swap routes for maximum efficiency
- Handles transaction management with automatic gas price adjustments

## Architecture

### Core Components

1. **index.js** - Main bot logic
   - Position monitoring and management
   - Liquidation detection and execution
   - Event handling and state management

2. **lib/common.js** - Shared utilities
   - Blockchain interaction helpers
   - Uniswap V3 integration
   - Transaction management
   - Price calculations
   - Network configurations

3. **contracts/** - ABI definitions
   - V3Vault.json - Revert Lend vault contract
   - FlashloanLiquidator.json - Flashloan liquidation contract
   - Uniswap V3 contracts (Pool, Factory, NPM, etc.)

## How It Works

### 1. Initialization

```
┌─────────────────────────────────────────┐
│  Load Environment Variables             │
│  - Network (arbitrum)                   │
│  - RPC URLs (HTTP + WebSocket)          │
│  - Private key                          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Initialize Contracts                   │
│  - V3 Vault (Revert Lend)              │
│  - Flashloan Liquidator                 │
│  - Uniswap V3 Position Manager          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Load Asset Information                 │
│  - Asset token (e.g., USDC)            │
│  - Decimals and symbol                  │
│  - Current debt exchange rate           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Setup WebSocket Listeners              │
│  - Position changes (Add/Remove)        │
│  - Debt changes (Borrow/Repay)          │
│  - Collateral changes (Withdraw)        │
│  - Pool price changes (Swap events)     │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Load All Active Positions              │
│  - Query historical events              │
│  - Filter for active positions          │
│  - Cache position details               │
└─────────────────────────────────────────┘
```

### 2. Position Monitoring

The bot maintains a real-time view of all positions:

```javascript
positions = {
  [tokenId]: {
    tokenId,           // NFT token ID
    liquidity,         // Current liquidity
    tickLower,         // Lower price bound
    tickUpper,         // Upper price bound
    fee,               // Pool fee tier
    token0, token1,    // Token addresses
    decimals0, decimals1,
    poolAddress,       // Uniswap V3 pool
    debtShares,        // Borrowed amount (in shares)
    owner,             // Position owner
    collateralFactorX32, // Collateral factor (Q32)
    fees0, fees1       // Accumulated fees
  }
}
```

### 3. Liquidation Detection

For each position, the bot continuously calculates:

```
Collateral Value = (amount0 * price0 + amount1 * price1) * collateralFactor
Debt Value = debtShares * exchangeRate

If Debt Value > Collateral Value → LIQUIDATE
```

**Key Calculations:**

- **Amount Calculation**: Uses Uniswap V3 math to calculate token amounts from liquidity and tick range
- **Price Fetching**: Gets token prices from reference pools (e.g., WETH/USDC)
- **Collateral Factor**: Applied to account for liquidation incentive and price volatility
- **Exchange Rate**: Converts debt shares to actual debt amount

### 4. Liquidation Execution

When a position is undercollateralized:

```
┌─────────────────────────────────────────┐
│  1. Calculate Available Amounts         │
│     - Token0 and Token1 from position   │
│     - Apply 99.5% factor for slippage   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  2. Generate Swap Routes                │
│     - Use Uniswap AlphaRouter           │
│     - Find optimal path to asset token  │
│     - Encode Universal Router calldata  │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  3. Select Flashloan Pool               │
│     - Choose pool not in swap route     │
│     - Ensure sufficient liquidity       │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  4. Execute Flashloan Liquidation       │
│     - Borrow asset via flashloan        │
│     - Liquidate position                │
│     - Swap collateral to asset          │
│     - Repay flashloan + fee             │
│     - Keep profit                       │
└─────────────────────────────────────────┘
```

**Flashloan Liquidation Flow:**

1. **Borrow** asset tokens via Uniswap V3 flashloan
2. **Liquidate** the undercollateralized position
3. **Receive** the position's tokens (token0, token1)
4. **Swap** tokens to the asset token using optimal routes
5. **Repay** the flashloan with fee
6. **Profit** from the liquidation reward

### 5. Transaction Management

The bot implements sophisticated transaction handling:

- **Nonce Management**: Sequential nonce tracking with mutex locks
- **Gas Price Optimization**: Automatic adjustment for EIP-1559 networks
- **Transaction Monitoring**: Checks every 10 seconds for confirmation
- **Automatic Replacement**: Resends with higher gas if stuck
- **Fallback Strategy**: Sends dummy transaction after 3 failed attempts

## Main Functions

### index.js

#### `updateDebtExchangeRate()`
Updates the cached debt exchange rate from the V3 Vault contract. This rate converts debt shares to actual debt amounts and changes over time as interest accrues.

#### `loadPositions()`
Loads all active positions from blockchain history by:
1. Fetching all Add and Remove events
2. Filtering for positions that haven't been removed
3. Updating position details for each active position

#### `updatePosition(tokenId)`
Updates or adds a position to the monitoring system:
- Fetches position details from Uniswap V3 Position Manager
- Retrieves debt information from V3 Vault
- Caches token decimals and collateral factors
- Estimates current accumulated fees
- Handles concurrent update prevention with flags

#### `checkPosition(position)`
**The core liquidation logic:**

**Step I - Detection:**
- Calculates token amounts from liquidity and price range
- Adds accumulated fees to amounts
- Fetches token prices in terms of the asset
- Calculates collateral value (with collateral factor applied)
- Calculates debt value (from shares and exchange rate)
- Determines if position is undercollateralized

**Step II - Execution:**
- Calculates available amounts (99.5% of actual for slippage)
- Generates optimal swap routes using Uniswap AlphaRouter
- Selects appropriate flashloan pool
- Estimates gas for transaction
- Executes flashloan liquidation
- Falls back to direct liquidation if flashloan fails (optional)

#### `checkAllPositions()`
Performs a comprehensive check of all positions. This runs every 15 minutes as a safety net to catch any positions that might have been missed by WebSocket events.

#### `run()`
**Main entry point:**
1. Registers global error handlers
2. Loads asset token information
3. Updates debt exchange rate
4. Sets up WebSocket event listeners
5. Loads all active positions
6. Starts periodic tasks (exchange rate updates, position checks)
7. Runs continuously until interrupted

### lib/common.js

#### Blockchain Interaction

**`executeTx(tx, callback)`**
Executes a transaction with automatic nonce management and gas optimization:
- Manages nonces sequentially using mutex
- Adds current gas price data
- Monitors transaction and replaces with higher gas if stuck
- Calls callback when transaction completes

**`checkTx(nonce, signer, intents, callback)`**
Monitors a pending transaction:
- Checks every 10 seconds if confirmed
- Replaces with higher gas price if stuck
- Sends dummy transaction after 3 failed attempts
- Ensures transactions don't get permanently stuck

**`getGasPriceData()`**
Returns appropriate gas price data:
- EIP-1559 networks: `maxFeePerGas` and `maxPriorityFeePerGas`
- Legacy networks: `gasPrice`

**`getAllLogs(filter)`**
Fetches all historical logs for a filter:
- Handles block range limitations
- Automatically adjusts range on errors
- Returns complete event history

**`setupWebsocket(filters, poolChangeCallback)`**
Creates resilient WebSocket connection:
- Monitors real-time blockchain events
- Implements keep-alive pings
- Auto-reconnects on disconnect
- Tracks pool price changes
- Handles custom event filters

#### Uniswap V3 Integration

**`getPool(token0, token1, fee)`**
Returns the Uniswap V3 pool address for a token pair and fee tier.

**`getPoolPrice(poolAddress, force)`**
Gets current pool price (tick and sqrtPriceX96):
- Uses cache unless force refresh
- Returns Q96 format price

**`getAmounts(sqrtPriceX96, lowerTick, upperTick, liquidity)`**
Calculates token amounts for a liquidity position:
- Uses Uniswap V3 math library
- Returns amount0 and amount1

**`getTickSpacing(fee)`**
Returns tick spacing for a fee tier:
- 100 (0.01%) → 1
- 500 (0.05%) → 10
- 3000 (0.3%) → 60
- 10000 (1%) → 200

#### Price Calculations

**`getTokenAssetPriceX96(token, asset)`**
Gets token price in terms of asset (Q96 format):
- Returns Q96 (2^96) if token equals asset
- Uses reference pools for price conversion
- Handles token0/token1 ordering

**`findPricePoolForTokenCached(address)`**
Finds the best price reference pool for a token:
- Checks all fee tiers (100, 500, 3000, 10000)
- Selects pool with highest liquidity
- Requires minimum 1 ETH liquidity
- Caches results

**`getTokensToPools(asset)`**
Returns mapping of tokens to their price reference pools for a given asset. Network and asset specific.

**`getPoolToToken(asset, pool)`**
Reverse lookup: finds token address for a given pool address.

#### Swap Route Generation

**`quoteUniversalRouter(...)`**
Generates optimal swap quote using Uniswap's Universal Router:
- Uses AlphaRouter to find best route across all V3 pools
- Supports multi-hop swaps
- Encodes calldata for Universal Router
- Handles slippage tolerance
- Supports optional fee deduction
- Returns swap data and expected amounts

**`getUniversalRouterSwapDataSinglePool(...)`**
Generates swap data for a single pool swap (simpler case).

**`getUniversalRouterSwapData(commands, inputs, deadline)`**
Encodes Universal Router calldata from commands and inputs.

#### Token Utilities

**`getTokenDecimals(token)`**
Returns the number of decimals for a token.

**`getTokenSymbol(token)`**
Returns the symbol for a token.

#### Network Configuration

**`getChainId()`**
Returns the chain ID for the current network.

**`getNativeTokenAddress()`**
Returns the wrapped native token address (WETH, WMATIC, etc.).

**`getNativeTokenSymbol()`**
Returns the native token symbol (ETH, MATIC, BNB, etc.).

**`getFactoryAddress()`**
Returns the Uniswap V3 Factory contract address.

**`getNPMAddress()`**
Returns the Uniswap V3 Non-fungible Position Manager address.

**`getUniversalRouterAddress()`**
Returns the Uniswap Universal Router address.

**`getV3VaultAddress()`**
Returns the Revert Lend V3 Vault contract address.

**`getFlashLoanLiquidatorAddress()`**
Returns the Flashloan Liquidator contract address.

**`getFlashloanPoolOptions(asset)`**
Returns available flashloan pool addresses for an asset.

#### Utility Functions

**`logWithTimestamp(...args)`**
Logs messages with ISO timestamp prefix.

**`sqrt(bn)`**
Calculates square root of a BigNumber.

**`toEthersBigInt(ca)`**
Converts CurrencyAmount to ethers BigNumber.

**`getRevertUrlForDiscord(id)`**
Generates Revert Finance URL for a position (Discord format).

**`getExplorerUrlForDiscord(hash)`**
Generates block explorer URL for a transaction (Discord format).

**`registerErrorHandler()`**
Registers global error handlers for uncaught exceptions and unhandled rejections.

## Configuration

### Environment Variables

Create a `.env` file with the following variables:

```bash
# Network selection
NETWORK=arbitrum

# RPC endpoints
RPC_URL_ARBITRUM=https://arb1.arbitrum.io/rpc
WS_RPC_URL_ARBITRUM=wss://arb1.arbitrum.io/ws

# Optional: Private RPC for transaction submission
PRIVATE_RPC_URL_ARBITRUM=https://your-private-rpc.com

# Bot private key (must have ETH for gas)
PRIVATE_KEY_LIQUIDATOR=0x...
```

### Supported Networks

Currently configured for:
- **Arbitrum** (primary)
- Mainnet
- Polygon
- Optimism
- BNB Chain
- Base
- Evmos

### Contract Addresses

The bot uses the following contracts on Arbitrum:

- **V3 Vault**: `0x74e6afef5705beb126c6d3bf46f8fad8f3e07825`
- **Flashloan Liquidator**: `0x5b94d444dfba48780524a1f0cd116f8a57bfefc2`
- **Uniswap V3 Factory**: `0x1F98431c8aD98523631AE4a59f267346ea31F984`
- **Position Manager**: `0xc36442b4a4522e871399cd717abdd847ab11fe88`
- **Universal Router**: `0x5E325eDA8064b456f4781070C0738d849c824258`

## Installation

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env with your configuration
nano .env

# Run the bot
node index.js
```

## Dependencies

- **ethers** (v5.5.4) - Ethereum library for blockchain interactions
- **@uniswap/smart-order-router** (3.47.0) - Optimal swap route finding
- **@thanpolas/univ3prices** (^3.0.2) - Uniswap V3 price calculations
- **async-mutex** (^0.4.0) - Mutex for transaction nonce management
- **axios** (^0.27.2) - HTTP client
- **dotenv** (^16.0.1) - Environment variable management

## Operation

### Startup

```
[2025-10-08T12:00:00.000Z] WS Provider created
[2025-10-08T12:00:00.100Z] WS Provider connected
[2025-10-08T12:00:01.000Z] Loaded 42 active positions
```

### Normal Operation

The bot monitors positions silently. When a position approaches liquidation:

```
[2025-10-08T12:15:30.000Z] Low collateral factor 1.05 for <https://revert.finance/#/uniswap-position/arbitrum/12345> with debt 1000.50 USDC
```

### Liquidation

When a liquidation is executed:

```
[2025-10-08T12:16:00.000Z] Executing liquidation with flashloan for <https://revert.finance/#/uniswap-position/arbitrum/12345> with reward of 25.50 USDC - [0xabc...def](<https://arbiscan.io/tx/0xabc...def>)
```

### Health Checks

```
[2025-10-08T12:20:00.000Z] WS Live check 2025-10-08T12:20:00.000Z
[2025-10-08T12:30:00.000Z] Performing regular check of all positions
[2025-10-08T12:31:00.000Z] Regular check of all positions completed successfully
```

## Safety Features

1. **Concurrent Operation Prevention**: Flags prevent checking/updating the same position simultaneously
2. **Transaction Monitoring**: Automatic gas price increases for stuck transactions
3. **WebSocket Reconnection**: Automatic reconnection on disconnect
4. **Regular Position Checks**: Every 15 minutes as backup to WebSocket events
5. **Error Handling**: Global error handlers prevent crashes
6. **Graceful Shutdown**: SIGINT handler for clean exit

## Performance Optimizations

1. **Caching**: Token decimals, collateral factors, and prices are cached
2. **WebSocket Events**: Real-time monitoring instead of polling
3. **Batch Processing**: Efficient event log fetching
4. **Mutex Locks**: Prevents nonce conflicts in concurrent scenarios
5. **Gas Estimation**: Accurate gas limits with 25% buffer

## Risks and Considerations

1. **Gas Costs**: Each liquidation costs gas; ensure profitability
2. **Competition**: Other bots may liquidate positions first
3. **Slippage**: Large liquidations may experience significant slippage
4. **Network Congestion**: High gas prices may reduce profitability
5. **Smart Contract Risk**: Relies on Revert Lend and Uniswap contracts
6. **Private Key Security**: Protect your private key carefully

## Troubleshooting

### Bot Not Starting

- Check `.env` file exists and has correct values
- Verify RPC URLs are accessible
- Ensure private key has ETH for gas

### No Positions Loaded

- Verify V3 Vault address is correct
- Check RPC endpoint is synced
- Ensure network is set correctly

### WebSocket Disconnecting

- Check WS RPC URL is valid
- Verify firewall allows WebSocket connections
- Consider using a dedicated RPC provider

### Transactions Failing

- Ensure wallet has sufficient ETH for gas
- Check gas price settings
- Verify flashloan pools have liquidity

## License

See `license.txt` for details.

## Disclaimer

This bot is provided as-is for educational purposes. Use at your own risk. The authors are not responsible for any losses incurred through the use of this software. Always test thoroughly on testnets before deploying to mainnet.
