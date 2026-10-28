import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const compilerSettings = {
  optimizer: {
    enabled: true,
    runs: 200,
  },
  viaIR: true,
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],

  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        settings: compilerSettings,
      },

      production: {
        version: "0.8.34",
        settings: compilerSettings,
      },
    },
  },

  test: {
    mocha: {
      timeout: 20_000,
    },
  },
});