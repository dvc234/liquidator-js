/**
 * Common Utilities for Liquidator Bot
 * 
 * This module provides shared functionality for interacting with Ethereum blockchain,
 * Uniswap V3 protocol, and the Revert Lend protocol. It includes:
 * 
 * - Blockchain connection management (RPC, WebSocket)
 * - Transaction execution with nonce management and gas price optimization
 * - Uniswap V3 pool and pricing utilities
 * - Token price calculations and conversions
 * - Network-specific contract addresses and configurations
 * - Swap route generation using Uniswap's Universal Router
 * 
 * @module lib/common
 */

const axios = require('axios');
const ethers = require("ethers");
const univ3prices = require('@thanpolas/univ3prices')
const Mutex = require('async-mutex').Mutex
const mutex = new Mutex()
const fs = require('fs')

const { AlphaRouter, SwapType } = require('@uniswap/smart-order-router')
const { Token, CurrencyAmount, TradeType, Percent, ChainId } = require('@uniswap/sdk-core')

// Bot configuration
const mode = "LIQUIDATOR"
const network = process.env.NETWORK
const exchange = "uniswap-v3"

const IERC20_ABI = require("../contracts/IERC20.json")
const POOL_ABI = require("../contracts/IUniswapV3Pool.json")
const FACTORY_RAW = require("../contracts/IUniswapV3Factory.json")
const NPM_RAW = require("../contracts/INonfungiblePositionManager.json")

const BigNumber = ethers.BigNumber

// Fixed-point math constants (Q notation for precision)
const Q32 = BigNumber.from(2).pow(32)  // Used for collateral factors
const Q64 = BigNumber.from(2).pow(64)  // Used for intermediate calculations
const Q96 = BigNumber.from(2).pow(96)  // Used for prices and exchange rates (Uniswap V3 standard)

// Generic pool contract for event filtering
const genericPoolContract = new ethers.Contract(ethers.constants.AddressZero, POOL_ABI)

// Caches to reduce RPC calls
const pricePoolCache = {} // Cache for price reference pools
const observationCardinalityIncreases = {} // Track oracle cardinality increases
const prices = {} // Current pool prices (tick and sqrtPriceX96)

// Blockchain providers and signers
const provider = new ethers.providers.JsonRpcProvider(process.env["RPC_URL_" + network.toUpperCase()])
const privateProvider = process.env["PRIVATE_RPC_URL_" + network.toUpperCase()] ? new ethers.providers.JsonRpcProvider(process.env["PRIVATE_RPC_URL_" + network.toUpperCase()]) : provider
const signer = new ethers.Wallet(process.env["PRIVATE_KEY_" + mode], provider)
const privateSigner = new ethers.Wallet(process.env["PRIVATE_KEY_" + mode], privateProvider)

// Uniswap V3 Non-fungible Position Manager contract
const npmContract = new ethers.Contract(getNPMAddress(), NPM_RAW.abi, provider)

// WebSocket provider (replaced on disconnect for auto-reconnection)
let wsProvider;

// Transaction management
let lastNonce; // Last used nonce for transaction ordering
const pendingTxs = {}; // Pending transactions awaiting confirmation

/**
 * Retrieves gas price data for a transaction.
 * @returns {Promise<object>} An object containing either `maxFeePerGas` and `maxPriorityFeePerGas` (for EIP-1559 networks) or `gasPrice`.
 */
async function getGasPriceData() {
    if (network == "mainnet" || network == "arbitrum") {
        // mainnet EIP-1559 handling
        const { maxFeePerGas, maxPriorityFeePerGas } = await provider.getFeeData()
        return { maxFeePerGas, maxPriorityFeePerGas }
    } else {
        return { gasPrice: await provider.getGasPrice() }
    }
}

/**
 * Executes a transaction with automatic nonce management and gas price optimization.
 * 
 * This function:
 * 1. Manages nonces sequentially using a mutex to prevent conflicts
 * 2. Adds current gas price data (EIP-1559 or legacy)
 * 3. Tracks pending transactions for monitoring
 * 4. Automatically retries with higher gas prices if transaction is stuck
 * 
 * The transaction is monitored by checkTx() which will replace it with higher gas
 * if it doesn't confirm within 10 seconds.
 * 
 * @param {object} tx - The transaction object to be executed.
 * @param {function} callback - A callback function invoked after transaction completes (success: boolean).
 * @returns {Promise<object>} An object containing either { hash } or { error }.
 */
async function executeTx(tx, callback) {
    const release = await mutex.acquire()
    try {
        let nonce
        // Initialize nonce on first transaction
        if (!lastNonce) {
            nonce = await provider.getTransactionCount(signer.address)
        } else {
            nonce = lastNonce + 1
        }
        const gasPriceData = await getGasPriceData()
        tx = { ...tx, ...gasPriceData, nonce }

        // Store pending transaction BEFORE sending (for retry logic)
        pendingTxs[nonce] = tx
        lastNonce = nonce
        
        // Start monitoring transaction after 10 seconds
        setTimeout(async () => await checkTx(nonce, signer, 0, callback), 10000)

        const result = await privateSigner.sendTransaction(tx)

        return { hash: result.hash }
    } catch (err) {
        console.log(err)
        await callback(false)
        return { error: err }
    } finally {
        release();
    }
}

/**
 * Retrieves all logs for a given filter. This is particularly useful for avoiding the need for subgraphs for smaller contracts.
 * @param {object} filter - The filter to be applied when querying logs.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of log objects.
 */
async function getAllLogs(filter) {

    let finished = false
    let from = 0
    let to = "latest"

    const logs = []

    while (!finished) {
        try {
            let events = await provider.getLogs({
                fromBlock: from,
                toBlock: to,
                ...filter
            })
            logs.push(...events)

            if (to == "latest") {
                finished = true
            } else {
                // continue from here
                from = to + 1
                to = "latest"
            }
        } catch (err) {
            const values = err.body.match("this block range should work: \\[(0x.*), (0x.*)\\]")
            if (values && values.length === 3) {
                const newTo = parseInt(values[2], 16)
                if (newTo == to) {
                    throw new Error("Invalid block range reached.")
                } else {
                    to = newTo
                }
            } else {
                throw err
            }
        }
    }
    return logs
}

/**
 * Creates a dummy transaction object.
 * @param {number} nonce - The nonce for the transaction.
 * @returns {object} A dummy transaction object.
 */
function getDummyTx(nonce) {
    return { value: 0, nonce, to: ethers.utils.AddressZero }
}

/**
 * Monitors a transaction and replaces it with higher gas if stuck.
 * 
 * This function implements a transaction acceleration strategy:
 * - Checks every 10 seconds if the transaction has been confirmed
 * - If stuck (nonce not advanced), resends with current (higher) gas price
 * - After 3 failed attempts, sends a dummy transaction to clear the nonce
 * 
 * This ensures transactions don't get stuck during periods of high network congestion
 * or rapidly rising gas prices.
 * 
 * @param {number} nonce - The nonce of the transaction to monitor.
 * @param {object} signer - The ethers signer object.
 * @param {number} intents - The number of replacement attempts made.
 * @param {function} callback - Callback invoked when transaction completes (success: boolean).
 */
async function checkTx(nonce, signer, intents, callback) {
    try {
        // Get current confirmed transaction count
        const currentNonce = await provider.getTransactionCount(signer.address)

        console.log("Checking nonce", nonce, "current", currentNonce, "intent", intents)

        if (currentNonce > nonce) {
            // Transaction confirmed
            console.log("Tx with nonce", nonce, "complete")
            
            delete pendingTxs[nonce]

            // Callback with success=true only if confirmed within 3 attempts
            await callback(intents <= 3)

            return
        } else if (currentNonce === nonce) {
            // Transaction still pending - replace with higher gas price
            const gasPriceData = await getGasPriceData()

            console.log("Replacing tx with gas", gasPriceData)

            // After 3 attempts, give up and send dummy tx to clear nonce
            const txToSend = intents < 3 ? pendingTxs[nonce] : getDummyTx(nonce)
            const newTx = { ...txToSend, ...gasPriceData }

            intents++

            const result = await signer.sendTransaction(newTx)

            console.log("Replacement TX for nonce " + nonce + " " + result.hash)
        } else {
            // Earlier transactions still pending - keep waiting
        }
    } catch (err) {
        // Continue monitoring even if error occurs
        console.log("error in checkTx", nonce, intents, err)
    }
    
    // Check again in 10 seconds
    setTimeout(async () => await checkTx(nonce, signer, intents, callback), 10000)
}

/**
 * Finds the price pool for a given token address, using a cache if available.
 * @param {string} address - The address of the token.
 * @returns {Promise<object>} An object containing the price pool address and a boolean indicating if token1 is WETH.
 */
async function findPricePoolForTokenCached(address) {

    if (pricePoolCache[address]) {
        return pricePoolCache[address]
    }

    const minimalBalanceETH = BigNumber.from(10).pow(18)
    let maxBalanceETH = BigNumber.from(0)
    let pricePoolAddress = null
    let isToken1WETH = null

    const nativeTokenAddress = getNativeTokenAddress()
    const nativeToken = new ethers.Contract(nativeTokenAddress, IERC20_ABI, provider)

    for (let fee of [100, 500, 3000, 10000]) {
        const candidatePricePoolAddress = await getPool(address, nativeTokenAddress, fee)
        if (candidatePricePoolAddress > 0) {
            const poolContract = new ethers.Contract(candidatePricePoolAddress, POOL_ABI, provider)

            const balanceETH = (await nativeToken.balanceOf(candidatePricePoolAddress))
            if (balanceETH.gt(maxBalanceETH) && balanceETH.gte(minimalBalanceETH)) {
                pricePoolAddress = candidatePricePoolAddress
                maxBalanceETH = balanceETH
                if (isToken1WETH === null) {
                    isToken1WETH = (await poolContract.token1()).toLowerCase() == nativeTokenAddress;
                }
            }

        }
    }

    pricePoolCache[address] = { address: pricePoolAddress, isToken1WETH }

    return pricePoolCache[address]
}

/**
 * Retrieves the number of decimals for a given token.
 * @param {string} token - The address of the token.
 * @returns {Promise<number>} The number of decimals for the token.
 */
async function getTokenDecimals(token) {
    const tokenContract = new ethers.Contract(token, IERC20_ABI, provider)
    return await tokenContract.decimals()
}

/**
 * Retrieves the symbol for a given token.
 * @param {string} token - The address of the token.
 * @returns {Promise<string>} The symbol of the token.
 */
async function getTokenSymbol(token) {
    const tokenContract = new ethers.Contract(token, IERC20_ABI, provider)
    return await tokenContract.symbol()
}

/**
 * Retrieves the price of a pool, using a cache if available.
 * @param {string} poolAddress - The address of the pool.
 * @param {boolean} force - Whether to force a refresh of the price.
 * @returns {Promise<object>} An object containing the tick and sqrtPriceX96 of the pool.
 */
async function getPoolPrice(poolAddress, force) {
    let price = prices[poolAddress]
    if (!force && price) {
        return price
    }
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider)
    const slot0 = await poolContract.slot0()
    prices[poolAddress] = { tick: slot0.tick, sqrtPriceX96: slot0.sqrtPriceX96 }
    return prices[poolAddress]
}

/**
 * Retrieves the address of a pool for a given pair of tokens and fee.
 * @param {string} token0 - The address of the first token.
 * @param {string} token1 - The address of the second token.
 * @param {number} fee - The fee for the pool.
 * @returns {Promise<string>} The address of the pool.
 */
async function getPool(token0, token1, fee) {
    const factoryContract = new ethers.Contract(getFactoryAddress(), FACTORY_RAW.abi, provider)
    const poolAddress = await factoryContract.getPool(token0, token1, fee)
    return poolAddress.toLowerCase()
}

/**
 * Converts a CurrencyAmount to an ethers BigInt.
 * @param {CurrencyAmount} ca - The CurrencyAmount to convert.
 * @returns {ethers.BigNumber} The converted BigInt.
 */
function toEthersBigInt(ca) {
    return ethers.utils.parseUnits(ca.toFixed(), ca.currency.decimals)
}

/**
 * Gets an optimal swap quote from Uniswap's Universal Router.
 * 
 * This function uses Uniswap's AlphaRouter to find the best swap route across
 * all available V3 pools, then encodes the swap data for the Universal Router.
 * 
 * The Universal Router allows for complex multi-hop swaps with minimal gas costs
 * and supports additional commands like fee collection and token sweeping.
 * 
 * @param {string} tokenIn - The input token address.
 * @param {string} tokenOut - The output token address.
 * @param {number} tokenInDecimals - The number of decimals for the input token.
 * @param {number} tokenOutDecimals - The number of decimals for the output token.
 * @param {ethers.BigNumber} amountIn - The amount of the input token to swap.
 * @param {string} recipient - The recipient address for the swapped tokens.
 * @param {number} slippageX10000 - The slippage tolerance in basis points (e.g., 100 = 1%).
 * @param {number} deadline - The Unix timestamp deadline for the transaction.
 * @param {number} feeX10000 - Optional fee in basis points (0 for no fee).
 * @param {string} feeRecipient - The recipient address for the fee.
 * @returns {Promise<object>} An object containing:
 *   - amountIn: Input amount
 *   - amountFee: Fee amount deducted
 *   - amountOut: Expected output amount (after fee)
 *   - amountOutMin: Minimum output with slippage
 *   - data: Encoded calldata for the Universal Router
 *   - pools: Array of pool addresses used in the route
 */
async function quoteUniversalRouter(tokenIn, tokenOut, tokenInDecimals, tokenOutDecimals, amountIn, recipient, slippageX10000, deadline, feeX10000, feeRecipient) {

    const chainId = getChainId(network)

    const router = new AlphaRouter({ chainId: chainId, provider: provider })

    const inputToken = new Token(chainId, tokenIn, tokenInDecimals, 'I', 'I')
    const outputToken = new Token(chainId, tokenOut, tokenOutDecimals, 'O', 'O')

    const inputAmount = CurrencyAmount.fromRawAmount(inputToken, amountIn.toString())

    // collect all used pools
    const pools = []

    // get quote from smart order router
    const route = await router.route(
        inputAmount,
        outputToken,
        TradeType.EXACT_INPUT,
        {
            type: SwapType.UNIVERSAL_ROUTER,
            recipient: recipient,
            slippageTolerance: new Percent(slippageX10000, 10000),
            deadline: deadline
        },
        { 
            protocols: ["V3"]
        }
    )

    // subtract fee from output token amount - if present
    let commands = "0x"
    let inputs = []

    const universalRouterAddress = getUniversalRouterAddress()

    for (const routePart of route.route) {
        const routeTypes = []
        const routeData = []
        for (const [i, token] of routePart.tokenPath.entries()) {
            if (i > 0) {
                routeTypes.push("uint24")
                routeData.push(routePart.route.pools[i - 1].fee)
            }
            routeTypes.push("address")
            routeData.push(token.address)
        }

        pools.push(...(routePart.poolAddresses || routePart.poolIdentifiers))

        const packedRoute = ethers.utils.solidityPack(routeTypes, routeData)
        const amountIn = toEthersBigInt(routePart.amount)
        const amountOutMin = toEthersBigInt(routePart.quote).mul(10000 - slippageX10000).div(10000)

        // exact input command
        commands += "00"

        inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "uint256", "uint256", "bytes", "bool"], [universalRouterAddress, amountIn, amountOutMin, packedRoute, false]));
    }

    let amountFee = ethers.BigNumber.from(0)
    let amountOut = toEthersBigInt(route.quote)

    if (feeX10000 > 0) {
        // add fee transfer command for input token
        amountFee = amountOut.mul(feeX10000).div(10000) // estimate amount fee here - depends on the swap
        commands += "06"
        inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenOut, feeRecipient, feeX10000]))
    }


    // sweep commands for input and output tokens
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenIn, recipient, 0]))
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenOut, recipient, 0]))


    const data = getUniversalRouterSwapData(commands, inputs, deadline)

    return {
        amountIn: amountIn,
        amountFee: amountFee,
        amountOut: amountOut.sub(amountFee),
        amountOutMin: amountOut.mul(10000 - slippageX10000).div(10000),
        data: data,
        pools: pools
    }
}

/**
 * Generates swap data for a single pool using the Universal Router.
 * @param {string} tokenIn - The input token address.
 * @param {string} tokenOut - The output token address.
 * @param {number} fee - The pool fee.
 * @param {ethers.BigNumber} amountIn - The amount of the input token.
 * @param {ethers.BigNumber} amountOutMin - The minimum amount of the output token to receive.
 * @param {string} recipient - The recipient of the swapped tokens.
 * @param {number} deadline - The deadline for the transaction.
 * @returns {object} An object containing the swap data.
 */
function getUniversalRouterSwapDataSinglePool(tokenIn, tokenOut, fee, amountIn, amountOutMin, recipient, deadline) {
    let commands = "0x"
    let inputs = []

    const packedRoute = ethers.utils.solidityPack(["address", "uint24", "address"], [tokenIn, fee, tokenOut])

    // exact input command
    commands += "00"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "uint256", "uint256", "bytes", "bool"], [recipient, amountIn, amountOutMin, packedRoute, false]));

    // sweep command for input token (if not all swapped)
    commands += "04"
    inputs.push(ethers.utils.defaultAbiCoder.encode(["address", "address", "uint256"], [tokenIn, recipient, 0]))

    const data = getUniversalRouterSwapData(commands, inputs, deadline)

    return { data }
}

/**
 * Generates swap data for the Universal Router.
 * @param {string} commands - The commands for the router.
 * @param {Array<string>} inputs - The inputs for the commands.
 * @param {number} deadline - The deadline for the transaction.
 * @returns {string} The encoded swap data.
 */
function getUniversalRouterSwapData(commands, inputs, deadline) {
    const universalRouterAddress = getUniversalRouterAddress()
    const universalRouterData = ethers.utils.defaultAbiCoder.encode(["tuple(bytes,bytes[],uint256)"], [[commands, inputs, deadline]])
    return ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [universalRouterAddress, universalRouterData])
}

/**
 * Calculates the square root of a BigNumber.
 * @param {ethers.BigNumber} bn - The BigNumber to calculate the square root of.
 * @returns {ethers.BigNumber} The square root of the BigNumber.
 */
function sqrt(bn) {
    x = BigNumber.from(bn)
    let z = x.add(1).div(2)
    let y = x
    while (z.sub(y).isNegative()) {
        y = z
        z = x.div(z).add(z).div(2)
    }
    return y
}

/**
 * Gets the chain ID for the current network.
 * @returns {number} The chain ID.
 */
function getChainId() {
    return {
        "mainnet": ChainId.MAINNET,
        "polygon": ChainId.POLYGON,
        "optimism": ChainId.OPTIMISM,
        "arbitrum": ChainId.ARBITRUM_ONE,
        "bnb": ChainId.BNB,
        "evmos": 9001,
        "base": ChainId.BASE
    }[network];
}

/**
 * Gets the address of the native token for the current network.
 * @returns {string} The native token address.
 */
function getNativeTokenAddress() {
    return {
        "mainnet": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "polygon": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        "optimism": "0x4200000000000000000000000000000000000006",
        "arbitrum": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        "bnb": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        "evmos": "0xd4949664cd82660aae99bedc034a0dea8a0bd517",
        "base": "0x4200000000000000000000000000000000000006"
    }[network];
}
/**
 * Gets the symbol of the native token for the current network.
 * @returns {string} The native token symbol.
 */
function getNativeTokenSymbol() {
    return network === "evmos" ? "EVMOS" : (network === "polygon" ? "MATIC" : (network === "bnb" ? "BNB" : "ETH"))
}
/**
 * Gets the address of the factory contract for the current network.
 * @returns {string} The factory contract address.
 */
function getFactoryAddress() {
    return {
        "mainnet": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "polygon": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "optimism": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "arbitrum": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "bnb": (exchange === "uniswap-v3" ? "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7" : "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
        "evmos": "0xf544365e7065966f190155f629ce0182fc68eaa2",
        "base": "0x33128a8fc17869897dce68ed026d694621f6fdfd"
    }[network];
}
/**
 * Gets the address of the Non-fungible Position Manager (NPM) contract for the current network.
 * @returns {string} The NPM contract address.
 */
function getNPMAddress() {
    return {
        "mainnet": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "polygon": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "optimism": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "arbitrum": "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        "bnb": (exchange === "uniswap-v3" ? "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613" : "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
        "evmos": "0x5fe5daaa011673289847da4f76d63246ddb2965d",
        "base": "0x03a520b32c04bf3beef7beb72e919cf822ed34f1"
    }[network];
}
/**
 * Gets the address of the Universal Router contract for the current network.
 * @returns {string} The Universal Router contract address.
 */
function getUniversalRouterAddress() {
    return {
        "mainnet": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        "polygon": "0x643770E279d5D0733F21d6DC03A8efbABf3255B4",
        "optimism": "0xeC8B0F7Ffe3ae75d7FfAb09429e3675bb63503e4",
        "arbitrum": "0x5E325eDA8064b456f4781070C0738d849c824258",
        "bnb": "0xeC8B0F7Ffe3ae75d7FfAb09429e3675bb63503e4",
        "evmos": "",
        "base": "0xeC8B0F7Ffe3ae75d7FfAb09429e3675bb63503e4"
    }[network];
}
/**
 * Gets the address of the V3 Vault contract for the current network.
 * @returns {string} The V3 Vault contract address.
 */
function getV3VaultAddress() {
    return {
        "mainnet": "",
        "polygon": "",
        "optimism": "",
        "arbitrum": "0x74e6afef5705beb126c6d3bf46f8fad8f3e07825", // revert lending protocol contract
        "bnb": "",
        "evmos": "",
        "base": ""
    }[network];
}
/**
 * Gets the address of the Flash Loan Liquidator contract for the current network.
 * @returns {string} The Flash Loan Liquidator contract address.
 */
function getFlashLoanLiquidatorAddress() {
    return {
        "mainnet": "",
        "polygon": "",
        "optimism": "",
        "arbitrum": "0x5b94d444dfba48780524a1f0cd116f8a57bfefc2",
        "bnb": "",
        "evmos": "",
        "base": ""
    }[network];
}

/**
 * Generates a Revert Finance URL for a given position ID.
 * @param {number} id - The position ID.
 * @returns {string} The Revert Finance URL.
 */
function getRevertUrlForDiscord(id) {
    const exchangeName = network === "evmos" ? "forge-position" : (exchange === "pancakeswap-v3" ? "pancake-position" : "uniswap-position")
    return `<https://revert.finance/#/${exchangeName}/${network}/${id.toString()}>`
}

/**
 * Generates a block explorer URL for a given transaction hash.
 * @param {string} hash - The transaction hash.
 * @returns {string} The block explorer URL.
 */
function getExplorerUrlForDiscord(hash) {
    const url = {
        "mainnet": "https://etherscan.io/tx/",
        "polygon": "https://polygonscan.com/tx/",
        "optimism": "https://optimistic.etherscan.io/tx/",
        "arbitrum": "https://arbiscan.io/tx/",
        "bnb": "https://bscscan.com/tx/",
        "evmos": "https://www.mintscan.io/evmos/tx/",
        "base": "https://basescan.org/tx/"
    }[network]

    return `[${hash}](<${url}${hash}>)`
}

/**
 * Gets the flash loan pool options for a given asset.
 * @param {string} asset - The asset address.
 * @returns {Array<string>} An array of flash loan pool addresses.
 */
function getFlashloanPoolOptions(asset) {
    return {
        "arbitrum": {
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831": ["0xc6962004f452be9203591991d15f6b388e09e8d0", "0xbe3ad6a5669dc0b8b12febc03608860c31e2eef6", "0xc473e2aee3441bf9240be85eb122abb059a3b57c"]
        }
    }[network][asset];
}

/**
 * Sets up a WebSocket provider with automatic reconnection and event monitoring.
 * 
 * This function creates a resilient WebSocket connection that:
 * 1. Monitors blockchain events in real-time (much faster than polling)
 * 2. Implements keep-alive pings to detect connection issues
 * 3. Automatically reconnects if the connection drops
 * 4. Tracks pool price changes for liquidation monitoring
 * 5. Handles custom event filters (position changes, borrows, repays, etc.)
 * 
 * The WebSocket connection is critical for the bot's responsiveness - it allows
 * detecting undercollateralized positions within seconds of price changes.
 * 
 * @param {Array<object>} filters - Array of event filters, each containing:
 *   - filter: ethers event filter object
 *   - handler: async function to handle the event
 * @param {function} poolChangeCallback - Callback invoked when a pool's price changes.
 */
function setupWebsocket(filters, poolChangeCallback) {

    console.log("WS Provider created")

    wsProvider = new ethers.providers.WebSocketProvider(process.env["WS_RPC_URL_" + network.toUpperCase()])

    let pingTimeout = null
    let keepAliveInterval = null

    wsProvider._websocket.on('open', () => {

        console.log("WS Provider connected")

        // Keep-alive mechanism: ping every 7.5 seconds, expect pong within 15 seconds
        keepAliveInterval = setInterval(() => {
            wsProvider._websocket.ping()
            pingTimeout = setTimeout(() => {
                try {
                    wsProvider._websocket.terminate()
                } catch (err) {
                    console.log(err)
                    // If termination fails, connection is likely still alive
                }
            }, 15000)
        }, 7500)

        // Monitor all Uniswap V3 pool swap events to track price changes
        if (poolChangeCallback) {
            const filter = genericPoolContract.filters.Swap(null, null)
            filter.address = null // Listen to all pools
            wsProvider.on(filter, async (...args) => {
                try {
                    const event = args[args.length - 1]
                    const a = genericPoolContract.interface.parseLog(event).args
                    // Update cached price immediately
                    prices[event.address.toLowerCase()] = { tick: a.tick, sqrtPriceX96: a.sqrtPriceX96 }
                    await poolChangeCallback(event.address.toLowerCase())
                } catch (err) {
                    console.log("Error processing swap event", err)
                }
            })
        }

        // Register custom event filters (position changes, borrows, repays, etc.)
        for (const filter of filters) {
            wsProvider.on(filter.filter, async (...args) => {
                const event = args[args.length - 1]
                await filter.handler(event)
            })
        }
    })

    wsProvider._websocket.on('close', () => {

        console.log("WS Provider disconnected")

        // Clean up timers and reconnect
        clearInterval(keepAliveInterval)
        clearTimeout(pingTimeout)
        setupWebsocket(filters, poolChangeCallback)
    })

    wsProvider._websocket.on('pong', () => {
        // Connection still alive, clear timeout
        clearInterval(pingTimeout)
    })
}

/**
 * Calculates the amounts of two tokens for a given liquidity range.
 * @param {ethers.BigNumber} sqrtPriceX96 - The square root of the price.
 * @param {number} lowerTick - The lower tick of the range.
 * @param {number} upperTick - The upper tick of the range.
 * @param {ethers.BigNumber} liquidity - The liquidity in the range.
 * @returns {object} An object containing the amounts of the two tokens.
 */
function getAmounts(sqrtPriceX96, lowerTick, upperTick, liquidity) {
    const lowerSqrtPriceX96 = BigNumber.from(univ3prices.tickMath.getSqrtRatioAtTick(lowerTick).toString())
    const upperSqrtPriceX96 = BigNumber.from(univ3prices.tickMath.getSqrtRatioAtTick(upperTick).toString())
    const amounts = univ3prices.getAmountsForLiquidityRange(sqrtPriceX96, lowerSqrtPriceX96, upperSqrtPriceX96, liquidity)
    return { amount0: BigNumber.from(amounts[0].toString()), amount1: BigNumber.from(amounts[1].toString()) }
}

/**
 * Gets the price of a token in terms of an asset, represented as a Q96 number.
 * @param {string} token - The address of the token.
 * @param {string} asset - The address of the asset.
 * @returns {Promise<ethers.BigNumber>} The price of the token in terms of the asset, as a Q96 number.
 */
async function getTokenAssetPriceX96(token, asset) {
    if (token === asset) {
        return BigNumber.from(2).pow(96)
    }

    const tokensToPools = getTokensToPools(asset)

    let priceToken = await getPoolPrice(tokensToPools[token].address)
    let priceTokenX96 = priceToken.sqrtPriceX96.mul(priceToken.sqrtPriceX96).div(Q96)
    if (tokensToPools[token].isToken0) {
        priceTokenX96 = Q96.mul(Q96).div(priceTokenX96)
    }

    return priceTokenX96
}

/**
 * Gets the mapping of tokens to pools for a given asset.
 * @param {string} asset - The address of the asset.
 * @returns {object} A mapping of tokens to pools.
 */
function getTokensToPools(asset) {
    return {
        "arbitrum": {
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
                "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { // DAI with USDC
                    address: "0x7cf803e8d82a50504180f417b8bc7a493c0a0503",
                    isToken0: true
                },
                "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { // WETH with USDC
                    address: "0xc6962004f452be9203591991d15f6b388e09e8d0",
                    isToken0: false
                },
                "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { // WBTC with USDC
                    address: "0x0e4831319a50228b9e450861297ab92dee15b44f",
                    isToken0: false
                },
                "0x912ce59144191c1204e64559fe8253a0e49e6548": { // ARB with USDC
                    address: "0xb0f6ca40411360c03d41c5ffc5f179b8403cdcf8",
                    isToken0: false
                },
                "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { // USDC.e with USDC
                    address: "0x8e295789c9465487074a65b1ae9Ce0351172393f",
                    isToken0: true
                },
                "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { // USDT with USDC
                    address: "0xbe3ad6a5669dc0b8b12febc03608860c31e2eef6",
                    isToken0: true
                },
                "0x5979d7b546e38e414f7e9822514be443a4800529": { // wstETH with USDC.e (no USDC pool available)
                    address: "0xc7341e85996eeb05897d3dec79448b6e4ccc09cf",
                    isToken0: false
                }
            }
        }
    }[network][asset];
}

/**
 * Logs a message with a timestamp.
 * @param {...any} args - The arguments to log.
 */
function logWithTimestamp(...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

/**
 * Gets the token address for a given pool address.
 * @param {string} asset - The asset address.
 * @param {string} pool - The pool address.
 * @returns {string} The token address.
 */
function getPoolToToken(asset, pool) {
    const tokensToPools = getTokensToPools(asset)
    const lowerCasePool = pool.toLowerCase()
    return Object.keys(tokensToPools).filter(x => tokensToPools[x].address.toLowerCase() === lowerCasePool)[0]
}

module.exports = {
    provider,
    signer,
    npmContract,
    
    getNativeTokenAddress,
    getNPMAddress,
    getFactoryAddress,
    getV3VaultAddress,
    getFlashLoanLiquidatorAddress,
    getNativeTokenSymbol,
    getFlashloanPoolOptions,
    getTokenAssetPriceX96,
    getRevertUrlForDiscord,
    getExplorerUrlForDiscord,
    registerErrorHandler: function () {
        process.on('uncaughtException', (err) => handleGlobalError(err))
        process.on('unhandledRejection', (err) => handleGlobalError(err))

        function handleGlobalError(err) {
            console.log("Global error", err)
        }
    },
    getAmounts,
    getPoolPrice,
    getPool,
    getPoolToToken,
    setupWebsocket,
    executeTx,
    getGasPriceData,
    getAllLogs,
    quoteUniversalRouter,
    getUniversalRouterSwapDataSinglePool,
    getTokenDecimals,
    getTokenSymbol,
    getTickSpacing: function (fee) {
        return fee == 100 ? 1 : (fee == 500 ? 10 : (fee == 3000 ? 60 : (fee == 2500 ? 50 : 200)))
    },
    Q32,
    Q64,
    Q96,
    network,
    exchange,
    sqrt,
    POOL_ABI,
    logWithTimestamp
}