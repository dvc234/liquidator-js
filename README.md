# Liquidator-js for Revert Lend

This repository contains an open-source liquidation bot for the [Revert Lend](https://revert.finance/) protocol. It is designed to be a simple yet effective tool for liquidating undercollateralized positions, and also serves as a practical example for developers looking to build their own DeFi bots.

## How It Works

The bot continuously monitors positions on Revert Lend and automatically executes liquidations when a position's debt exceeds its collateral value.

### Core Logic

1.  **Position Monitoring**:
    *   On startup, the bot fetches all active positions.
    *   It uses a WebSocket connection to listen for real-time blockchain events (e.g., `Swap`, `Add`, `Remove`, `Borrow`) that might affect position values.
    *   When relevant events are detected, the affected positions are immediately re-checked.

2.  **Health Check**:
    *   For each position, the bot calculates its health factor by comparing the value of its collateral against its outstanding debt.
    *   A position is considered eligible for liquidation if its debt value is greater than its collateral value.

3.  **Liquidation Execution**:
    *   When a position is identified for liquidation, the bot can use one of two methods:
        *   **Flashloan Liquidation (Default)**: The bot borrows the required assets using a flashloan, executes the liquidation, and repays the loan in a single atomic transaction. This method does not require the liquidator to hold any upfront capital (other than ETH for gas).
        *   **Non-Flashloan Liquidation**: If enabled, the bot can use its own funds to perform the liquidation. This requires the liquidator's wallet to be funded with the necessary assets (e.g., USDC) and to have approved the Revert Lend vault contract.

4.  **Periodic Scans**:
    *   In addition to real-time monitoring, the bot performs a full scan of all active positions every 15 minutes to catch any liquidation opportunities that might have been missed by event-based checks.

## Project Structure

The repository is organized as follows:

-   `index.js`: The main entry point of the application. It contains the core logic for loading, checking, and liquidating positions.
-   `lib/common.js`: A utility module containing helper functions for interacting with the blockchain, such as executing transactions, fetching contract data, and getting quotes from Uniswap.
-   `contracts/`: Contains ABI files for the smart contracts the bot interacts with.
-   `README.md`: You are here!
-   `package.json`: Defines the project dependencies and scripts.

## Getting Started

Follow these steps to set up and run the liquidator bot.

### Prerequisites

-   [Node.js](https://nodejs.org/) (v14 or higher)
-   [npm](https://www.npmjs.com/) (v6 or higher)
-   An Ethereum wallet with some ETH on Arbitrum to cover gas fees.
-   Access to an Arbitrum RPC endpoint (both HTTP/S and WebSocket). You can get one from services like [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/).

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/revert-finance/liquidator-js.git
    cd liquidator-js
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Create and configure your `.env` file:**
    Create a file named `.env` in the root of the project and add the following environment variables:

    ```dotenv
    # Your wallet's private key.
    PRIVATE_KEY_LIQUIDATOR=your_private_key_here

    # Your Arbitrum RPC endpoint URL.
    RPC_URL_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/your_api_key

    # Your Arbitrum WebSocket endpoint URL.
    WS_RPC_URL_ARBITRUM=wss://arb-mainnet.g.alchemy.com/v2/your_api_key

    # The network to run on.
    NETWORK=arbitrum
    ```

    **Note:** The `PRIVATE_KEY_LIQUIDATOR` is used to sign and send transactions. Keep it secure and never commit it to version control.

## Running the Bot

To start the liquidator bot, run the following command from the project's root directory:

```bash
node index.js
```

The bot will start logging its activities to the console.

## Configuration

You can customize the bot's behavior by editing the constants at the top of `index.js`:

-   `positionLogInterval`: How often to log positions with a low collateral factor (default: `60000` ms or 1 minute).
-   `enableNonFlashloanLiquidation`: Set to `true` to use your own funds for liquidations instead of flashloans (default: `false`).
-   `CHECK_INTERVAL`: The interval for periodic full scans of all positions (default: `900000` ms or 15 minutes).

## Contributing

Contributions are welcome! If you have suggestions for improvements or find a bug, please feel free to open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE.txt](license.txt) file for details.

---

***Disclaimer:** This software is provided "as is", without warranty of any kind. Use it at your own risk. The authors or contributors are not responsible for any financial losses or other damages incurred from its use.*