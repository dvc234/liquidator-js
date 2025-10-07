# Code Architecture & Design Patterns

This document explains the architectural decisions, design patterns, and code organization of the liquidator bot.

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Design Patterns](#design-patterns)
3. [Data Flow](#data-flow)
4. [State Management](#state-management)
5. [Error Handling](#error-handling)
6. [Concurrency Control](#concurrency-control)
7. [Code Organization](#code-organization)

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Liquidator Bot                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   index.js   │  │ lib/common.js│  │  contracts/  │    │
│  │              │  │              │  │              │    │
│  │ • Position   │  │ • Blockchain │  │ • ABIs       │    │
│  │   Monitoring │  │   Utils      │  │ • Interfaces │    │
│  │ • Liquidation│  │ • Swap Logic │  │              │    │
│  │   Logic      │  │ • TX Mgmt    │  │              │    │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘    │
│         │                  │                               │
└─────────┼──────────────────┼───────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Blockchain Layer                         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  V3 Vault    │  │  Uniswap V3  │  │  Flashloan   │    │
│  │  Contract    │  │  Contracts   │  │  Liquidator  │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Arbitrum Network                           │
└─────────────────────────────────────────────────────────────┘```


### Component Responsibilities

**index.js (Main Bot Logic)**
- Position lifecycle management (load, update, monitor)
- Liquidation detection algorithm
- Liquidation execution orchestration
- Event handling and WebSocket coordination
- Periodic task scheduling

**lib/common.js (Shared Utilities)**
- Blockchain interaction layer (RPC calls, transaction management)
- Uniswap V3 integration (pools, prices, swaps)
- Price calculation and conversion
- Token utilities (decimals, symbols)
- Network configuration management
- WebSocket connection handling

**contracts/ (ABI Definitions)**
- V3Vault.json - Revert Lend vault interface
- FlashloanLiquidator.json - Flashloan liquidation contract
- Uniswap V3 contracts (Pool, Factory, NPM, Router, etc.)

### Communication Flow

```
WebSocket Events → Event Handlers → updatePosition() → positions{}
                                                           ↓
Price Changes → poolChangeCallback() → checkPosition() → Liquidation?
                                                           ↓
                                                    executeTx() → Blockchain
```

---

## Design Patterns

### 1. Event-Driven Architecture

The bot uses an event-driven architecture to respond to blockchain events in real-time.

**Pattern**: Observer Pattern
**Implementation**: WebSocket event listeners

```javascript
setupWebsocket([
  {
    filter: v3VaultContract.filters.Add(),
    handler: async (e) => { await updatePosition(tokenId) }
  },
  {
    filter: v3VaultContract.filters.Borrow(),
    handler: async (e) => { await updatePosition(tokenId) }
  }
  // ... more event listeners
])
```

**Benefits**:
- Real-time response to position changes
- Efficient resource usage (no polling)
- Decoupled event sources from handlers


### 2. Caching Strategy

The bot implements multiple caching layers to reduce RPC calls and improve performance.

**Pattern**: Cache-Aside (Lazy Loading)
**Implementation**: In-memory caches with on-demand population

```javascript
// Token decimals cache
if (cachedTokenDecimals[token0] === undefined) {
  cachedTokenDecimals[token0] = await getTokenDecimals(token0)
}

// Collateral factor cache
if (!cachedCollateralFactorX32[token0]) {
  const tokenConfig = await v3VaultContract.tokenConfigs(token0)
  cachedCollateralFactorX32[token0] = tokenConfig.collateralFactorX32
}

// Pool price cache (in lib/common.js)
if (!prices[poolAddress] || force) {
  // Fetch from blockchain
}
```

**Cached Data**:
- Token decimals (`cachedTokenDecimals`)
- Collateral factors (`cachedCollateralFactorX32`)
- Pool prices (`prices`)
- Debt exchange rate (`cachedExchangeRateX96`)

**Cache Invalidation**:
- Token decimals: Never (immutable)
- Collateral factors: Never (rarely changes)
- Pool prices: On every swap event (WebSocket)
- Exchange rate: Every 60 seconds (periodic update)

### 3. State Machine Pattern

Each position goes through a state machine to prevent concurrent operations.

**States**:
- `isUpdating`: Position data is being fetched/updated
- `isChecking`: Position is being evaluated for liquidation
- `isExecuting`: Liquidation transaction is being executed

**State Transitions**:
```
IDLE → isUpdating → IDLE
IDLE → isChecking → IDLE
IDLE → isChecking → isExecuting → IDLE
```

**Implementation**:
```javascript
async function checkPosition(position) {
  if (!position || position.isChecking || position.isExecuting || position.isUpdating) {
    return // Skip if busy
  }
  position.isChecking = true
  
  try {
    // Check logic
  } finally {
    position.isChecking = false
  }
}
```

**Benefits**:
- Prevents race conditions
- Avoids duplicate work
- Ensures data consistency

### 4. Retry Pattern with Exponential Backoff

Failed operations are retried with increasing delays.

**Implementation**:
```javascript
async function updatePosition(tokenId) {
  if (positions[tokenId] && (positions[tokenId].isChecking || ...)) {
    setTimeout(async () => await updatePosition(tokenId), 10000) // 10s retry
    return
  }
  
  try {
    // Update logic
  } catch (err) {
    setTimeout(async () => await updatePosition(tokenId), 60000) // 60s retry on error
    logWithTimestamp("Error updating position", err)
  }
}
```

**Retry Intervals**:
- Busy state: 10 seconds
- Error state: 60 seconds
- Transaction stuck: Increasing gas price every 10 seconds

### 5. Factory Pattern

Network-specific configurations are created using a factory pattern.

**Implementation** (in lib/common.js):
```javascript
function getV3VaultAddress() {
  const addresses = {
    'arbitrum': '0x74e6afef5705beb126c6d3bf46f8fad8f3e07825',
    'mainnet': '0x...',
    // ... other networks
  }
  return addresses[network]
}
```

**Benefits**:
- Easy multi-network support
- Centralized configuration
- Type-safe address management

---

## Data Flow

### Position Update Flow

```
Blockchain Event (Add/Borrow/Repay/etc.)
          ↓
Event Handler (WebSocket listener)
          ↓
updatePosition(tokenId)
          ↓
    Check if busy (isUpdating/isChecking/isExecuting)
          ↓ No
    Set isUpdating = true
          ↓
Fetch Position Data (parallel RPC calls)
  • v3VaultContract.loans(tokenId)
  • npmContract.positions(tokenId)
  • v3VaultContract.ownerOf(tokenId)
  • npmContract.callStatic.collect() [fees]
          ↓
Fetch Token Metadata (cached)
  • Token decimals
  • Collateral factors
          ↓
Update positions[tokenId] object
          ↓
    Set isUpdating = false
```

### Liquidation Detection Flow

```
checkPosition(position)
          ↓
    Check if busy (isUpdating/isChecking/isExecuting)
          ↓ No
    Set isChecking = true
          ↓
Calculate Token Amounts
  • getAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity)
  • Add accumulated fees
          ↓
Fetch Token Prices (from reference pools)
  • getTokenAssetPriceX96(token0, asset)
  • getTokenAssetPriceX96(token1, asset)
          ↓
Calculate Values
  • assetValue = price0 * amount0 + price1 * amount1
  • collateralValue = assetValue * collateralFactor
  • debtValue = debtShares * exchangeRate
          ↓
    Is debtValue > collateralValue?
          ↓ Yes
Fetch Liquidation Info (rate limited)
  • v3VaultContract.loanInfo(tokenId)
          ↓
    Is liquidationValue > 0?
          ↓ Yes
    Set isExecuting = true
          ↓
Execute Liquidation (see Liquidation Execution Flow)
          ↓
    Set isExecuting = false
          ↓
    Set isChecking = false
```


### Liquidation Execution Flow

```
Prepare Liquidation
          ↓
Calculate Available Amounts
  • amount0Available = amount0 * 0.995 * (liquidationValue / fullValue)
  • amount1Available = amount1 * 0.995 * (liquidationValue / fullValue)
          ↓
Generate Swap Routes (parallel)
  • quoteUniversalRouter(token0 → asset) [if token0 != asset]
  • quoteUniversalRouter(token1 → asset) [if token1 != asset]
          ↓
Select Flashloan Pool
  • Get flashloan pool options for asset
  • Filter out pools used in swap routes
  • Select first available pool
          ↓
Estimate Gas
  • Try: floashLoanLiquidatorContract.estimateGas.liquidate()
  • Catch: Fall back to v3VaultContract.estimateGas.liquidate()
          ↓
Build Transaction
  • Populate transaction with params
  • Add 25% gas buffer
          ↓
Execute Transaction
  • executeTx(tx, callback)
  • Monitor transaction status
  • Replace with higher gas if stuck
          ↓
Log Result
  • Success: Log reward and transaction hash
  • Failure: Log error
```

### Price Update Flow

```
Uniswap V3 Pool Swap Event
          ↓
WebSocket Listener (genericPoolContract.on('Swap'))
          ↓
Parse Event
  • Extract pool address
  • Extract tick and sqrtPriceX96
          ↓
Update Price Cache
  • prices[poolAddress] = { tick, sqrtPriceX96 }
          ↓
Trigger Pool Change Callback
  • poolChangeCallback(poolAddress)
          ↓
Find Affected Token
  • getPoolToToken(asset, poolAddress)
          ↓
Find Affected Positions
  • Filter positions where token0 or token1 matches affected token
          ↓
Check Each Affected Position
  • checkPosition(position)
```

### Transaction Execution Flow

```
executeTx(tx, callback)
          ↓
Acquire Nonce Mutex Lock
          ↓
Get Current Nonce
  • signer.getTransactionCount('pending')
          ↓
Add Gas Price Data
  • getGasPriceData() [EIP-1559 or legacy]
          ↓
Sign and Send Transaction
  • signer.sendTransaction(tx)
          ↓
Release Nonce Mutex Lock
          ↓
Monitor Transaction (checkTx)
  ↓
Check every 10 seconds
  ↓
Is transaction confirmed?
  ↓ No
Has 10 seconds passed?
  ↓ Yes
Replace with higher gas (+10%)
  ↓
Repeat up to 3 times
  ↓
If still not confirmed, send dummy transaction
  ↓
Call callback(success)
```

---

## State Management

### Global State

The bot maintains several global state variables:

```javascript
// Position registry
const positions = {}  // { [tokenId]: PositionObject }

// Caches
const cachedTokenDecimals = {}  // { [tokenAddress]: number }
const cachedCollateralFactorX32 = {}  // { [tokenAddress]: BigNumber }
let cachedExchangeRateX96  // BigNumber

// Asset information
let asset  // string (address)
let assetDecimals  // number
let assetSymbol  // string

// Health monitoring
let lastWSLifeCheck  // timestamp

// Concurrency control
let isCheckingAllPositions  // boolean
```

### Position State Object

Each position in the `positions` object has the following structure:

```javascript
{
  // Identity
  tokenId: BigNumber,
  owner: string,
  
  // Uniswap V3 Position Data
  liquidity: BigNumber,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  fee: number,
  token0: string,
  token1: string,
  decimals0: number,
  decimals1: number,
  poolAddress: string,
  
  // Revert Lend Data
  debtShares: BigNumber,
  collateralFactorX32: BigNumber,
  
  // Fees
  fees0: BigNumber,
  fees1: BigNumber,
  
  // State Flags (concurrency control)
  isUpdating: boolean,
  isChecking: boolean,
  isExecuting: boolean,
  
  // Rate Limiting
  lastLiquidationCheck: timestamp,
  lastLog: timestamp
}
```

### State Lifecycle

**Position Creation**:
1. Event: `Add` event emitted by V3 Vault
2. Handler: `updatePosition(tokenId)` called
3. State: New entry created in `positions` object

**Position Update**:
1. Triggers: Borrow, Repay, WithdrawCollateral, IncreaseLiquidity events
2. Handler: `updatePosition(tokenId)` called
3. State: Existing entry updated in `positions` object

**Position Removal**:
1. Event: `Remove` event emitted by V3 Vault
2. Handler: `updatePosition(tokenId)` called
3. State: Entry deleted from `positions` object (debtShares = 0)

**Position Check**:
1. Triggers: Price change, periodic check, manual trigger
2. Handler: `checkPosition(position)` called
3. State: Flags set/cleared, no data modification

### State Persistence

**Current Implementation**: In-memory only
- All state is lost on restart
- Positions are reloaded from blockchain on startup

**Considerations for Persistence**:
- Could add Redis/database for state persistence
- Would enable faster restarts
- Would preserve rate limiting state
- Trade-off: Added complexity and potential stale data

---

## Error Handling

### Error Handling Strategy

The bot implements a multi-layered error handling approach:

1. **Function-level try-catch**: Specific error handling
2. **Retry mechanisms**: Automatic retry with backoff
3. **Global error handlers**: Catch-all for uncaught exceptions
4. **Graceful degradation**: Continue operation despite errors

### Function-Level Error Handling

**Pattern**: Try-catch with logging and retry

```javascript
async function updatePosition(tokenId) {
  try {
    // Update logic
  } catch (err) {
    // Log error
    logWithTimestamp("Error updating position " + tokenId.toString(), err)
    
    // Retry after delay
    setTimeout(async () => await updatePosition(tokenId), 60000)
  }
}
```

**Applied to**:
- `updatePosition()`: Retry after 60 seconds
- `checkPosition()`: Log and continue
- `checkAllPositions()`: Log and continue
- `executeTx()`: Return error to caller

### Transaction Error Handling

**Pattern**: Multi-stage fallback

```javascript
try {
  // Try flashloan liquidation
  gasLimit = await floashLoanLiquidatorContract.estimateGas.liquidate(params)
} catch (err) {
  logWithTimestamp("Error trying flashloan liquidation", err)
  
  if (enableNonFlashloanLiquidation) {
    // Fallback to direct liquidation
    useFlashloan = false
    params = { /* direct liquidation params */ }
    gasLimit = await v3VaultContract.estimateGas.liquidate(params)
  } else {
    throw err
  }
}
```

**Fallback Chain**:
1. Flashloan liquidation (preferred)
2. Direct liquidation (if enabled)
3. Skip and log error

### WebSocket Error Handling

**Pattern**: Automatic reconnection with keep-alive

```javascript
// Keep-alive ping every 30 seconds
setInterval(() => {
  if (wsProvider.websocket.readyState === 1) {
    wsProvider.websocket.ping()
  }
}, 30000)

// Reconnect on disconnect
wsProvider.websocket.on('close', () => {
  logWithTimestamp('WS disconnected, reconnecting...')
  setTimeout(() => setupWebsocket(...), 5000)
})
```

**Features**:
- Automatic reconnection on disconnect
- Keep-alive pings to detect stale connections
- Event resubscription on reconnect

### Global Error Handlers

**Pattern**: Last-resort error catching

```javascript
function registerErrorHandler() {
  process.on('uncaughtException', (err) => {
    logWithTimestamp('Uncaught Exception:', err)
    // Don't exit - continue running
  })
  
  process.on('unhandledRejection', (reason, promise) => {
    logWithTimestamp('Unhandled Rejection at:', promise, 'reason:', reason)
    // Don't exit - continue running
  })
}
```

**Purpose**:
- Prevent bot crashes from unexpected errors
- Log errors for debugging
- Continue operation despite errors

### Error Categories and Responses

| Error Type | Example | Response |
|------------|---------|----------|
| **RPC Error** | Network timeout | Retry with exponential backoff |
| **Contract Error** | Revert | Log and skip operation |
| **Gas Estimation Error** | Out of gas | Try fallback method or skip |
| **Transaction Error** | Nonce too low | Replace transaction with higher gas |
| **WebSocket Error** | Connection lost | Reconnect automatically |
| **Data Error** | Invalid position | Delete from positions object |
| **Unknown Error** | Uncaught exception | Log and continue |

### Logging Strategy

**Format**: Timestamp + Message + Error details

```javascript
function logWithTimestamp(...args) {
  console.log(new Date().toISOString(), ...args)
}
```

**Log Levels** (implicit):
- Info: Normal operations (position checks, liquidations)
- Warning: Low collateral factors, retry attempts
- Error: Exceptions, failed operations

**Logged Events**:
- Bot startup and initialization
- Position loads and updates
- Liquidation attempts and results
- Errors and exceptions
- WebSocket connection status
- Periodic health checks

---

## Concurrency Control

### Concurrency Challenges

The bot faces several concurrency challenges:

1. **Multiple events for same position**: Borrow + Repay in same block
2. **Price changes during checks**: Pool price changes while checking position
3. **Transaction nonce conflicts**: Multiple liquidations at once
4. **WebSocket event floods**: Many swap events in short time

### Position-Level Locking

**Pattern**: State flags as locks

```javascript
async function updatePosition(tokenId) {
  // Check if locked
  if (positions[tokenId] && (
    positions[tokenId].isChecking || 
    positions[tokenId].isExecuting || 
    positions[tokenId].isUpdating
  )) {
    setTimeout(async () => await updatePosition(tokenId), 10000)
    return
  }
  
  // Acquire lock
  if (!positions[tokenId]) {
    positions[tokenId] = { isUpdating: true }
  } else {
    positions[tokenId].isUpdating = true
  }
  
  try {
    // Critical section
  } finally {
    // Release lock
    if (positions[tokenId]) {
      positions[tokenId].isUpdating = false
    }
  }
}
```

**Lock Types**:
- `isUpdating`: Prevents concurrent updates
- `isChecking`: Prevents concurrent checks
- `isExecuting`: Prevents concurrent liquidations

**Lock Scope**: Per-position (fine-grained)

**Deadlock Prevention**: No nested locks, always released in finally block

### Transaction Nonce Management

**Pattern**: Mutex lock with sequential nonce

```javascript
const { Mutex } = require('async-mutex')
const nonceMutex = new Mutex()

async function executeTx(tx, callback) {
  const release = await nonceMutex.acquire()
  
  try {
    const nonce = await signer.getTransactionCount('pending')
    tx.nonce = nonce
    
    const signedTx = await signer.sendTransaction(tx)
    
    // Start monitoring (async, doesn't block)
    checkTx(nonce, signer, 0, callback)
    
    return { hash: signedTx.hash }
  } catch (err) {
    return { error: err }
  } finally {
    release()
  }
}
```

**Benefits**:
- Prevents nonce conflicts
- Ensures sequential transaction submission
- Allows parallel transaction monitoring

**Trade-off**: Serializes transaction submission (but monitoring is parallel)

### Global Check Lock

**Pattern**: Boolean flag

```javascript
let isCheckingAllPositions = false

async function checkAllPositions() {
  if (isCheckingAllPositions) {
    logWithTimestamp("Regular check already in progress. Skipping.")
    return
  }
  
  isCheckingAllPositions = true
  
  try {
    for (const position of Object.values(positions)) {
      await checkPosition(position)
    }
  } finally {
    isCheckingAllPositions = false
  }
}
```

**Purpose**: Prevents overlapping periodic checks

**Scope**: Global (coarse-grained)

### Rate Limiting

**Pattern**: Timestamp-based throttling

```javascript
// In checkPosition()
if (!position.lastLiquidationCheck || 
    position.lastLiquidationCheck + 60000 < Date.now()) {
  info = await v3VaultContract.loanInfo(position.tokenId)
  position.lastLiquidationCheck = Date.now()
}
```

**Rate Limits**:
- `loanInfo()` calls: Max once per minute per position
- Position logging: Max once per minute per position
- WebSocket health check: Every 5 minutes

**Purpose**: Reduce RPC load and log spam

### Concurrency Model Summary

```
┌─────────────────────────────────────────────────────────┐
│                    Event Sources                        │
│  WebSocket Events | Periodic Timers | Price Changes    │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│              Position-Level Locks                       │
│  isUpdating | isChecking | isExecuting                 │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│           Sequential Operations                         │
│  updatePosition() → checkPosition() → executeTx()      │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│              Nonce Mutex                                │
│  Serializes transaction submission                     │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│           Parallel Monitoring                           │
│  Multiple transactions monitored concurrently          │
└─────────────────────────────────────────────────────────┘
```

---

## Code Organization

### File Structure

```
liquidator-bot/
├── index.js                 # Main bot logic
├── lib/
│   └── common.js           # Shared utilities
├── contracts/              # ABI definitions
│   ├── V3Vault.json
│   ├── FlashloanLiquidator.json
│   ├── UniswapV3Pool.json
│   ├── UniswapV3Factory.json
│   ├── NonfungiblePositionManager.json
│   └── UniversalRouter.json
├── .env                    # Environment configuration
├── package.json            # Dependencies
├── README.md              # User documentation
├── CODE_ARCHITECTURE.md   # This file
└── PERFORMANCE_OPTIMIZATION.md  # Performance guide
```

### Module Responsibilities

**index.js** (Main Module)
- Entry point and orchestration
- Position management
- Liquidation logic
- Event handling
- ~310 lines

**lib/common.js** (Utility Module)
- Blockchain interactions
- Uniswap V3 integration
- Transaction management
- Network configuration
- ~800+ lines

**contracts/** (Data Module)
- Contract ABIs
- Interface definitions
- No executable code

### Function Organization

**index.js Functions** (in order):

1. `updateDebtExchangeRate()` - Updates global exchange rate
2. `loadPositions()` - Initial position loading
3. `updatePosition(tokenId)` - Position data management
4. `checkPosition(position)` - Liquidation detection
5. `checkAllPositions()` - Batch position checking
6. `run()` - Main entry point

**lib/common.js Functions** (by category):

*Blockchain Interaction*:
- `executeTx()` - Transaction execution
- `checkTx()` - Transaction monitoring
- `getGasPriceData()` - Gas price calculation
- `getAllLogs()` - Historical event fetching
- `setupWebsocket()` - WebSocket management

*Uniswap V3*:
- `getPool()` - Pool address lookup
- `getPoolPrice()` - Pool price fetching
- `getAmounts()` - Liquidity math
- `getTickSpacing()` - Fee tier configuration

*Price Calculations*:
- `getTokenAssetPriceX96()` - Token price conversion
- `findPricePoolForTokenCached()` - Price pool discovery
- `getTokensToPools()` - Token-pool mapping
- `getPoolToToken()` - Reverse pool lookup

*Swap Routing*:
- `quoteUniversalRouter()` - Optimal route finding
- `getUniversalRouterSwapData()` - Calldata encoding
- `getUniversalRouterSwapDataSinglePool()` - Single-hop swap

*Token Utilities*:
- `getTokenDecimals()` - Token decimal fetching
- `getTokenSymbol()` - Token symbol fetching

*Network Configuration*:
- `getChainId()` - Chain ID lookup
- `getNativeTokenAddress()` - Native token address
- `getV3VaultAddress()` - Vault address
- `getFlashLoanLiquidatorAddress()` - Liquidator address
- `getFlashloanPoolOptions()` - Flashloan pool list

*Utilities*:
- `logWithTimestamp()` - Logging helper
- `sqrt()` - BigNumber square root
- `toEthersBigInt()` - Type conversion
- `getRevertUrlForDiscord()` - URL formatting
- `getExplorerUrlForDiscord()` - URL formatting
- `registerErrorHandler()` - Error handler setup

### Dependency Graph

```
index.js
  ├── ethers (external)
  ├── dotenv (external)
  └── lib/common.js
        ├── ethers (external)
        ├── @uniswap/smart-order-router (external)
        ├── @thanpolas/univ3prices (external)
        ├── async-mutex (external)
        ├── axios (external)
        └── contracts/*.json (local)
```

### Configuration Management

**Environment Variables** (.env):
```bash
NETWORK=arbitrum
RPC_URL_ARBITRUM=https://...
WS_RPC_URL_ARBITRUM=wss://...
PRIVATE_RPC_URL_ARBITRUM=https://...  # Optional
PRIVATE_KEY_LIQUIDATOR=0x...
```

**Constants** (index.js):
```javascript
const positionLogInterval = 1 * 6000  // 1 minute
const enableNonFlashloanLiquidation = false
const CHECK_INTERVAL = 15 * 60 * 1000  // 15 minutes
```

**Network Configuration** (lib/common.js):
```javascript
const network = process.env.NETWORK || 'arbitrum'
const chainIds = { 'arbitrum': 42161, ... }
const vaultAddresses = { 'arbitrum': '0x74e6...', ... }
// ... more network-specific configs
```

### Code Style and Conventions

**Naming Conventions**:
- Functions: camelCase (`updatePosition`, `checkPosition`)
- Constants: UPPER_SNAKE_CASE (`CHECK_INTERVAL`, `Q96`)
- Variables: camelCase (`positions`, `cachedExchangeRateX96`)
- Contracts: camelCase with "Contract" suffix (`v3VaultContract`)

**Async/Await**:
- All async functions use async/await (no raw promises)
- Error handling with try-catch blocks
- No unhandled promise rejections

**Comments**:
- JSDoc comments for main functions
- Inline comments for complex logic
- Block comments for major sections

**Error Handling**:
- Try-catch at function boundaries
- Logging with `logWithTimestamp()`
- Graceful degradation (continue on error)

**Code Formatting**:
- 2-space indentation
- No semicolons (mostly)
- Single quotes for strings
- Trailing commas in objects/arrays

### Testing Strategy

**Current State**: No automated tests

**Recommended Testing Approach**:

1. **Unit Tests**:
   - Price calculations (`getTokenAssetPriceX96`)
   - Amount calculations (`getAmounts`)
   - Utility functions (`sqrt`, conversions)

2. **Integration Tests**:
   - RPC interactions (with mock provider)
   - Contract calls (with test network)
   - Transaction execution (with test wallet)

3. **End-to-End Tests**:
   - Full liquidation flow (on testnet)
   - WebSocket event handling (with mock events)
   - Error recovery (with simulated failures)

4. **Manual Testing**:
   - Run on testnet with test positions
   - Monitor logs for errors
   - Verify liquidations execute correctly

### Deployment Considerations

**Environment Setup**:
1. Install Node.js (v16+)
2. Install dependencies (`npm install`)
3. Configure `.env` file
4. Fund wallet with ETH for gas

**Running the Bot**:
```bash
# Development
node index.js

# Production (with PM2)
pm2 start index.js --name liquidator-bot

# Production (with systemd)
systemctl start liquidator-bot
```

**Monitoring**:
- Log output to file
- Set up alerts for errors
- Monitor wallet balance
- Track liquidation success rate

**Security**:
- Protect private key (use environment variables, not hardcoded)
- Use dedicated wallet for bot
- Limit wallet balance (only what's needed for gas)
- Monitor for unusual activity

---

## Summary

The liquidator bot is built with a focus on:

1. **Reliability**: Event-driven architecture with automatic reconnection
2. **Performance**: Caching, parallel operations, and efficient RPC usage
3. **Safety**: Concurrency control, error handling, and graceful degradation
4. **Maintainability**: Clear code organization and separation of concerns
5. **Scalability**: Modular design allows easy addition of new features

The architecture balances simplicity with robustness, making it suitable for production use while remaining easy to understand and modify.
