# OpenAid — Transparent Charity Donation Prototype

OpenAid is a Hardhat 3 + Ethers.js smart-contract prototype for transparent charity donations.

## Core model

1. A platform administrator verifies a real-world charity wallet in `CharityRegistry`.
2. A verified charity creates a `CharityCampaign` through `CharityFactory`.
3. During the funding phase, donors donate ETH into a chosen category such as Food or Medical.
4. Once funding closes, the charity proposes an expense and provides:
   - recipient wallet,
   - category,
   - requested amount,
   - human-readable purpose,
   - off-chain evidence URI,
   - cryptographic hash of that evidence.
5. Only donors who funded that category can act as human oracles and vote.
6. Each donor address gets one vote per expense. A proposal must satisfy both participation quorum and approval percentage.
7. Donors can also raise a public dispute by committing a hash of their reason.
8. If approved, anyone may execute the payment to the exact recipient disclosed in the proposal.
9. After the campaign deadline, remaining money is refundable pro-rata to donors within each category.

## Why the funding phase closes before voting

This freezes the donor set before an expense vote begins. Without this rule, someone could wait to see a proposal and then create/donate from extra wallets to manipulate its oracle vote.

## Important oracle limitation

The blockchain can prove that evidence was submitted, who voted, and where approved money moved. It cannot independently prove that a PDF, photo, invoice, or delivery claim is truthful. Donors are therefore the human oracle layer in this prototype.

## Anti-Sybil limitation

One-wallet-one-vote can still be attacked by one person controlling many wallets. The prototype makes this more costly with a minimum donation, but a production system would likely combine this mechanism with privacy-preserving proof-of-personhood/KYC, donor credentials, or another identity/reputation layer.

## Project structure

```text
contracts/
  CharityRegistry.sol
  CharityFactory.sol
  CharityCampaign.sol

test/
  OpenAid.ts

ignition/modules/
  OpenAid.ts

hardhat.config.ts
package.json
```

## Setup

Hardhat 3 currently requires a modern Node.js version. From this folder:

```bash
npm install
npx hardhat build
npx hardhat test
```

To run only the Mocha/Ethers tests:

```bash
npx hardhat test mocha
```

## Test coverage included

The test suite covers:

- charity verification permissions;
- blocking unverified campaign creators;
- category-specific donations;
- minimum donation and funding deadlines;
- prevention of direct/unclassified transfers;
- category fund segregation;
- expense evidence requirements and fund reservation;
- donor-only oracle voting;
- one-donor-one-vote behavior;
- double-vote protection;
- dispute raising;
- quorum and approval thresholds;
- approved payment execution;
- double-execution protection;
- campaign closure; and
- proportional refunds of unspent funds.

## Suggested demo configuration

For a classroom demo, a campaign can use:

- quorum: `5000` basis points = 50% of donors in the relevant category;
- approval threshold: `6000` basis points = 60% of votes cast;
- minimum donation: `0.1 ETH` on the local Hardhat network;
- categories: `Food`, `Medical`, `Shelter`, etc.

These are prototype parameters, not recommendations for handling real charitable funds.

## Simple frontend

A browser frontend is included under `frontend/`. It uses MetaMask + ethers.js and can:

- connect to a wallet and add the local Hardhat network;
- load the deployed `CharityFactory` and `CharityRegistry`;
- verify/unverify charity addresses (registry admin only);
- create charity campaigns;
- browse campaigns and category balances;
- donate to a selected category;
- propose evidence-backed expenses (charity only);
- vote YES/NO as a donor oracle;
- raise disputes;
- finalize votes and execute approved payouts;
- close expired campaigns and claim proportional refunds.

### Run the full local demo

Use three terminals.

**Terminal 1 — local blockchain**

```bash
npm install
npx hardhat node
```

Hardhat will print funded development accounts and private keys. Import one or more of these **development-only** accounts into MetaMask when you want to act as the registry admin, charity, donor, or recipient. Never reuse these test keys on a real network.

**Terminal 2 — deploy contracts and configure frontend**

```bash
npx hardhat ignition deploy ignition/modules/OpenAid.ts --network localhost
npm run frontend:config
```

The second command reads `ignition/deployments/chain-31337/deployed_addresses.json` and writes the local factory address into `frontend/config.js`.

**Terminal 3 — frontend**

```bash
npm run frontend
```

Open the URL printed by Vite (normally `http://127.0.0.1:5173`). Click **Add Hardhat Network** and **Connect MetaMask**.

### Suggested demo roles

The first Hardhat account that deploys `CharityRegistry` is the registry admin. A simple demonstration is:

1. Connect with the admin account and verify a second account as a charity.
2. Switch MetaMask to the charity account and create a campaign.
3. Switch to several donor accounts and donate to the same category.
4. After the funding deadline, switch to the charity and propose an expense with an evidence URI/hash.
5. Switch to donor accounts and vote YES/NO or raise a dispute.
6. After the voting deadline, finalize the vote and execute an approved expense.
7. After the campaign deadline, close the campaign and let donors claim unused funds.

Because the Solidity contract intentionally uses real block timestamps, use short funding/voting periods for a live UI demo. Your unit tests can still use Hardhat network helpers to jump time instantly.
