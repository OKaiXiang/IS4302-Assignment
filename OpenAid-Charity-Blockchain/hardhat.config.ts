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

  // Hardhat Ignition builds deployments with the "production" profile.
  // Defining both profiles ensures viaIR is used for tests/builds AND deployments.
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
