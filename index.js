/**
 * Liquidator Bot for Revert Lend
 * 
 * This bot monitors Uniswap V3 positions that are used as collateral in the Revert Lend protocol
 * and automatically liquidates undercollateralized positions to maintain protocol solvency.
 * 
 * @module liquidator-js
 * @requires dotenv - Environment variable management
 * @requires ethers - Ethereum library for blockchain interactions
 * @requires ./lib/common - Common utility functions and blockchain helpers
 */

require('dotenv').config()
const { ethers, BigNumber } = require('ethers')
const { logWithTimestamp } = require('./lib/common')
const { quoteUniversalRouter, registerErrorHandler, npmContract, provider, signer, setupWebsocket,
  getPool, getAllLogs, getPoolPrice, getAmounts, getTokenAssetPriceX96,
  getTickSpacing, getFlashloanPoolOptions, getV3VaultAddress, getFlashLoanLiquidatorAddress,
  executeTx, getTokenDecimals, getTokenSymbol, getPoolToToken,
  getRevertUrlForDiscord, getExplorerUrlForDiscord, Q32, Q96 } = require('./lib/common')

// Contract instances
const v3VaultContract = new ethers.Contract(getV3VaultAddress(), require("./contracts/V3Vault.json").abi, provider)
const floashLoanLiquidatorContract = new ethers.Contract(getFlashLoanLiquidatorAddress(), require("./contracts/FlashloanLiquidator.json").abi, provider)

// Configuration constants
const positionLogInterval = 1 * 6000 // Log positions each 1 minute (in milliseconds)
const enableNonFlashloanLiquidation = false // Fallback to non-flashloan liquidation if flashloan fails

// State management
const positions = {} // Stores all active positions being monitored
const cachedTokenDecimals = {} // Cache for token decimal values to reduce RPC calls
const cachedCollateralFactorX32 = {} // Cache for collateral factors (Q32 format)

// Global variables
let cachedExchangeRateX96 // Current debt exchange rate in Q96 format
let asset, assetDecimals, assetSymbol // Asset token information (e.g., USDC)
let lastWSLifeCheck = new Date().getTime() // Timestamp of last WebSocket health check

let isCheckingAllPositions = false; // Flag to prevent concurrent position checks

/**
 * Updates the debt exchange rate from the v3VaultContract.
 */
async function updateDebtExchangeRate() {
  const info = await v3VaultContract.vaultInfo()
  cachedExchangeRateX96 = info.debtExchangeRateX96
}

/**
 * Loads all active positions from the blockchain.
 * It retrieves all logs of positions being added and removed.
 * It processes each add event from the newest to the oldest.
 * For each add event, it checks if there is a corresponding remove event to determine if the position is still active.
 * If the position is active, it updates the position and tracks the count of active positions.
 * Finally, it logs the number of active positions loaded.
 */
async function loadPositions() {
  let adds = await getAllLogs(v3VaultContract.filters.Add())
  let removes = await getAllLogs(v3VaultContract.filters.Remove())
  let loadedPositions = 0
  // from newest to oldest - process each event once - remove deactivated positions
  while (adds.length > 0) {
    const event = adds[adds.length - 1]
    const tokenId = v3VaultContract.interface.parseLog(event).args.tokenId
    const isActive = removes.filter(e => tokenId.eq(v3VaultContract.interface.parseLog(e).args.tokenId) && (e.blockNumber > event.blockNumber || (e.blockNumber == event.blockNumber && e.logIndex > event.logIndex))).length === 0
    if (isActive) {
      await updatePosition(tokenId)
      loadedPositions++
    }
    adds = adds.filter(e => !v3VaultContract.interface.parseLog(e).args.tokenId.eq(tokenId))
  }
  logWithTimestamp(`Loaded ${loadedPositions} active positions`)
}


/**
 * Updates the data for a specific position.
 * @param {ethers.BigNumber} tokenId - The ID of the token representing the position.
 */
async function updatePosition(tokenId) {
  // if processing - retry later
  if (positions[tokenId] && (positions[tokenId].isChecking || positions[tokenId].isExecuting || positions[tokenId].isUpdating)) {
    setTimeout(async () => await updatePosition(tokenId), 10000)
    return
  }

  if (!positions[tokenId]) {
    positions[tokenId] = { isUpdating: true }
  } else {
    positions[tokenId].isUpdating = true
  }

  /*
  Debt Shares Check: It checks if a token (tokenId) has any associated debt shares.
  Updating Positions: If the debt shares are greater than 0:
  it fetches the position details like liquidity, ticks, fee, and associated tokens.
  Retrieves tick spacing based on the fee.
  Gets the pool address and owner of the token.
  Estimates current fees.
  Caches the token decimals and collateral factors if not already cached.
  Determines the collateral factor to be used.
  Updates the positions object.
  Deleting Positions: If there are no debt shares, it removes the tokenId from the positions.
  */
  try {
    const debtShares = await v3VaultContract.loans(tokenId)
    if (debtShares.gt(0)) {
      // add or update
      const { liquidity, tickLower, tickUpper, fee, token0, token1 } = await npmContract.positions(tokenId);
      const tickSpacing = getTickSpacing(fee)
      const poolAddress = await getPool(token0, token1, fee)

      const owner = await v3VaultContract.ownerOf(tokenId)

      // get current fees - for estimation
      const fees = await npmContract.connect(v3VaultContract.address).callStatic.collect([tokenId, ethers.constants.AddressZero, BigNumber.from(2).pow(128).sub(1), BigNumber.from(2).pow(128).sub(1)])

      if (cachedTokenDecimals[token0] === undefined) {
        cachedTokenDecimals[token0] = await getTokenDecimals(token0)
      }
      if (cachedTokenDecimals[token1] === undefined) {
        cachedTokenDecimals[token1] = await getTokenDecimals(token1)
      }
      const decimals0 = cachedTokenDecimals[token0]
      const decimals1 = cachedTokenDecimals[token1]

      if (!cachedCollateralFactorX32[token0]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token0)
        cachedCollateralFactorX32[token0] = tokenConfig.collateralFactorX32
      }
      if (!cachedCollateralFactorX32[token1]) {
        const tokenConfig = await v3VaultContract.tokenConfigs(token1)
        cachedCollateralFactorX32[token1] = tokenConfig.collateralFactorX32
      }

      const collateralFactorX32 = cachedCollateralFactorX32[token0] < cachedCollateralFactorX32[token1] ? cachedCollateralFactorX32[token0] : cachedCollateralFactorX32[token1]

      positions[tokenId] = { ...positions[tokenId], tokenId, liquidity, tickLower, tickUpper, tickSpacing, fee, token0: token0.toLowerCase(), token1: token1.toLowerCase(), decimals0, decimals1, poolAddress, debtShares, owner, collateralFactorX32, fees0: fees.amount0, fees1: fees.amount1 }

    } else {
      delete positions[tokenId]
    }
  } catch (err) {
    // retry on error after 1 min
    setTimeout(async () => await updatePosition(tokenId), 60000)
    logWithTimestamp("Error updating position " + tokenId.toString(), err)
  }

  if (positions[tokenId]) {
    positions[tokenId].isUpdating = false
  }
}

/**
 * Checks a position to determine if it needs to be liquidated.
 * 
 * This function performs a two-step liquidation check:
 * Step I: Estimates if liquidation is needed based on collateral vs debt value
 * Step II: If liquidation is needed, prepares and executes the liquidation transaction
 * 
 * The liquidation process:
 * 1. Calculates the current value of the position's tokens
 * 2. Compares collateral value (adjusted by collateral factor) against debt value
 * 3. If undercollateralized, prepares swap routes to convert tokens to the asset
 * 4. Executes liquidation using flashloan (or direct liquidation as fallback)
 * 
 * @param {object} position - The position object to check containing:
 *   - tokenId: The NFT token ID representing the position
 *   - liquidity: Current liquidity in the position
 *   - tickLower/tickUpper: Price range boundaries
 *   - token0/token1: Token addresses in the pool
 *   - debtShares: Amount of debt shares
 *   - collateralFactorX32: Collateral factor in Q32 format
 *   - fees0/fees1: Accumulated fees
 */
async function checkPosition(position) {

  if (!position || position.isChecking || position.isExecuting || position.isUpdating) {
    return
  }
  position.isChecking = true

  let info, amount0, amount1

  // Step I: Check if liquidation is needed
  try {
    const poolPrice = await getPoolPrice(position.poolAddress)
    /* If position.liquidity is greater than 0, it calls the getAmounts function
    with the parameters poolPrice.sqrtPriceX96, position.tickLower, position.tickUpper,
    and position.liquidity to compute the amounts of token 0 and token 1.
    If position.liquidity is not greater than 0,
    it sets amounts to an object with amount0 and amount1 both initialized to zero.
    */
    const amounts = position.liquidity.gt(0) ? getAmounts(poolPrice.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity) : { amount0: BigNumber.from(0), amount1: BigNumber.from(0) }
    amount0 = amounts.amount0.add(position.fees0)
    amount1 = amounts.amount1.add(position.fees1)

    // Fetching the price with 2^96 format
    const price0X96 = await getTokenAssetPriceX96(position.token0, asset)
    const price1X96 = await getTokenAssetPriceX96(position.token1, asset)

    const assetValue = price0X96.mul(amount0).div(Q96).add(price1X96.mul(amount1).div(Q96))
    const collateralValue = assetValue.mul(position.collateralFactorX32).div(Q32)
    const debtValue = position.debtShares.mul(cachedExchangeRateX96).div(Q96)

    // Debt > collateralValue
    if (debtValue.gt(collateralValue)) {
      // only call this once per minute to update position (&fees)
      if (!position.lastLiquidationCheck || position.lastLiquidationCheck + 60000 < Date.now()) {
        // it retrieves loan information
        info = await v3VaultContract.loanInfo(position.tokenId) // TODO check what this function does
        position.lastLiquidationCheck = Date.now()
      }
    }

    // It checks health factor of the position
    if (debtValue.gt(0) && (!position.lastLog || position.lastLog + positionLogInterval < Date.now())) {
      // collateralValue * 100 / debt / 100 --> factor = collateralValue / debt
      const factor = collateralValue.mul(100).div(debtValue).toNumber() / 100
      if (factor < 1.1) {
        const msg = `Low collateral factor ${factor.toFixed(2)} for ${getRevertUrlForDiscord(position.tokenId)} with debt ${ethers.utils.formatUnits(debtValue, assetDecimals)} ${assetSymbol}`
        logWithTimestamp(msg)
        position.lastLog = Date.now()
      }
    }

  } catch (err) {
    logWithTimestamp("Error checking position " + position.tokenId.toString(), err)
    info = null
  }

  // Step II: Execute liquidation if position is undercollateralized
  if (info && info.liquidationValue.gt(0)) {

    // Prepare and execute liquidation transaction
    try {
      // amount that will be available to the contract - remove a bit for withdrawal slippage
      // setup to remove 99,5% liquidity of the pair (i.e. ETH/USDT)
      const amount0Available = amount0.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)
      const amount1Available = amount1.mul(995).div(1000).mul(info.liquidationValue).div(info.fullValue)

      const deadline = Math.floor(Date.now() / 1000 + 1800) // 3 mins deadline

      /*
       * Prepare swap routes to convert position tokens to the asset token (e.g., USDC)
       * 
       * For each token in the position that differs from the asset:
       * 1. Get a quote from Uniswap's Universal Router for the optimal swap route
       * 2. Store the swap calldata
       * 3. Track all pools involved in the swap to avoid using them for flashloans
       * 
       * This ensures we can convert the liquidated collateral to the debt asset
       * to repay the loan and capture any liquidation reward.
       */
      let amount0In = BigNumber.from(0)
      let swapData0 = "0x"
      let pools = []

      // Prepare swap for token0 if it's not the asset token
      const liquidityPresent = amount0Available.gt(0);
      const notTheSameAssets = position.token0 != asset;
      const liquidityPresentAndTokensNotEqual = notTheSameAssets && liquidityPresent;
      if (liquidityPresentAndTokensNotEqual) {
        amount0In = amount0Available
        const quote = await quoteUniversalRouter(
          position.token0, asset, position.decimals0,
          assetDecimals, amount0In, floashLoanLiquidatorContract.address,
          100, deadline, 0, ethers.constants.AddressZero
        )
        swapData0 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      // Prepare swap for token1 if it's not the asset token
      let amount1In = BigNumber.from(0)
      let swapData1 = "0x"
      if (position.token1 != asset && amount1Available.gt(0)) {
        amount1In = amount1Available
        const quote = await quoteUniversalRouter(position.token1, asset, position.decimals1, assetDecimals, amount1In, floashLoanLiquidatorContract.address, 100, deadline, 0, ethers.constants.AddressZero)
        swapData1 = quote.data
        pools.push(...quote.pools.map(p => p.toLowerCase()))
      }

      pools.push(position.poolAddress)

      // Select a flashloan pool that's not involved in the swap routes
      // This prevents circular dependencies and ensures the flashloan can be executed
      const flashLoanPoolOptions = getFlashloanPoolOptions(asset)
      const flashLoanPool = flashLoanPoolOptions.filter(o => !pools.includes(o.toLowerCase()))[0]

      const reward = info.liquidationValue.sub(info.liquidationCost)

      // Minimum reward threshold (set to 0 for flashloan liquidation since we don't risk our own capital)
      const minReward = BigNumber.from(0)

      // Prepare liquidation parameters
      let params = { tokenId: position.tokenId, debtShares: position.debtShares, vault: v3VaultContract.address, flashLoanPool, amount0In, swapData0, amount1In, swapData1, minReward, deadline }

      let useFlashloan = true
      let gasLimit
      try {
        // Estimate gas for flashloan liquidation
        gasLimit = await floashLoanLiquidatorContract.connect(signer).estimateGas.liquidate(params)
      } catch (err) {
        logWithTimestamp("Error trying flashloan liquidation for " + position.tokenId.toString(), err)

        if (enableNonFlashloanLiquidation) {
          // Fallback to direct liquidation (requires liquidator to have the asset tokens)
          useFlashloan = false
          params = { tokenId: position.tokenId, amount0Min: BigNumber.from(0), amount1Min: BigNumber.from(0), recipient: signer.address, permitData: "0x", deadline }
          gasLimit = await v3VaultContract.connect(signer).estimateGas.liquidate(params)
        } else {
          throw err
        }
      }

      // Build transaction with 25% gas buffer to account for price changes
      const tx = useFlashloan ?
        await floashLoanLiquidatorContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) }) :
        await v3VaultContract.populateTransaction.liquidate(params, { gasLimit: gasLimit.mul(125).div(100) })

      position.isExecuting = true
      const { hash, error } = await executeTx(tx, async (success) => {
        position.isExecuting = false
      })

      if (hash) {
        const msg = `Executing liquidation ${useFlashloan ? "with" : "without"} flashloan for ${getRevertUrlForDiscord(position.tokenId)} with reward of ${ethers.utils.formatUnits(reward, assetDecimals)} ${assetSymbol} - ${getExplorerUrlForDiscord(hash)}`
        logWithTimestamp(msg)
      } else {
        throw error
      }
    } catch (err) {
      logWithTimestamp("Error liquidating position " + position.tokenId.toString(), err)
    }
  } else if (info) {
    // update values if not liquidatable - but estimation indicated it was
    position.isChecking = false
    await updatePosition(position.tokenId)
  }

  position.isChecking = false
}

/**
 * Checks all positions to determine if they need to be liquidated.
 */
async function checkAllPositions() {
  if (isCheckingAllPositions) {
    logWithTimestamp("Regular check of all positions is already in progress. Skipping this execution.");
    return;
  }

  isCheckingAllPositions = true;
  logWithTimestamp("Performing regular check of all positions");

  try {
    for (const position of Object.values(positions)) {
      await checkPosition(position);
    }
    logWithTimestamp("Regular check of all positions completed successfully");
  } catch (error) {
    logWithTimestamp("Error during regular position check:", error);
  } finally {
    isCheckingAllPositions = false;
  }
}

/**
 * Main entry point for the liquidator bot.
 * 
 * Initialization sequence:
 * 1. Sets up error handlers for uncaught exceptions
 * 2. Loads asset token information from the V3 Vault
 * 3. Fetches the current debt exchange rate
 * 4. Sets up WebSocket listeners for real-time position updates
 * 5. Loads all existing positions from blockchain history
 * 6. Starts periodic tasks (exchange rate updates, position checks)
 * 
 * The bot then runs continuously, monitoring positions and executing liquidations as needed.
 */
async function run() {

  registerErrorHandler()

  // Load asset token information (the token used for lending, e.g., USDC)
  asset = (await v3VaultContract.asset()).toLowerCase()
  assetDecimals = await getTokenDecimals(asset)
  assetSymbol = await getTokenSymbol(asset)

  await updateDebtExchangeRate()

  // Setup WebSocket listeners for real-time monitoring of position changes
  setupWebsocket([
    {
      filter: v3VaultContract.filters.Add(),
      handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
    },
    {
      filter: v3VaultContract.filters.Remove(),
      handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
    },
    {
      filter: v3VaultContract.filters.Borrow(),
      handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
    },
    {
      filter: v3VaultContract.filters.Repay(),
      handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
    },
    {
      filter: v3VaultContract.filters.WithdrawCollateral(),
      handler: async (e) => { await updatePosition(v3VaultContract.interface.parseLog(e).args.tokenId) }
    },
    {
      filter: npmContract.filters.IncreaseLiquidity(),
      handler: async (e) => {
        const tokenId = npmContract.interface.parseLog(e).args.tokenId
        if (positions[tokenId]) {
          await updatePosition(tokenId)
        }
      }
    }
  ], async function (poolAddress) {

    // WebSocket health check every 5 minutes
    const time = new Date()
    if (time.getTime() > lastWSLifeCheck + 300000) {
      logWithTimestamp("WS Live check", time.toISOString())
      lastWSLifeCheck = time.getTime()
    }

    // When a price reference pool changes, check all positions containing that token
    // This ensures we quickly detect positions that may have become undercollateralized
    const affectedToken = getPoolToToken(asset, poolAddress)
    if (affectedToken) {
      const toCheckPositions = Object.values(positions).filter(p => p.token0 === affectedToken || p.token1 === affectedToken)
      for (const position of toCheckPositions) {
        await checkPosition(position)
      }
    }
  })

  await loadPositions()

  // Update debt exchange rate every minute
  setInterval(async () => { await updateDebtExchangeRate() }, 60000)

  // Perform comprehensive check of all positions every 15 minutes
  // This acts as a safety net in case any WebSocket events were missed
  const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
  setInterval(async () => {
    await checkAllPositions();
  }, CHECK_INTERVAL);

  // Graceful shutdown handler
  process.on('SIGINT', () => {
    logWithTimestamp('Received SIGINT. Shutting down gracefully...');
    process.exit(0);
  });
}

// Start the bot

run()