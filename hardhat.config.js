// Configuration Hardhat 2 de SalonEscrow.
// - Solidity 0.8.24, EVM « paris » (pas d'opcode PUSH0) : fonctionne sur le plus grand nombre de testnets.
// - Les clés et URL viennent des variables d'environnement (fichier .env, jamais commité).
// - Le réseau Sepolia n'est déclaré que si son URL et sa clé de déploiement sont fournies,
//   pour que `npm test` fonctionne sans aucun secret.
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("dotenv").config();

const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

const networks = {
  hardhat: {},
  localhost: { url: "http://127.0.0.1:8545" },
};

if (SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY) {
  networks.sepolia = {
    url: SEPOLIA_RPC_URL,
    accounts: [DEPLOYER_PRIVATE_KEY],
    chainId: 11155111,
  };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "paris",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks,
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
  mocha: { timeout: 60_000 },
};
