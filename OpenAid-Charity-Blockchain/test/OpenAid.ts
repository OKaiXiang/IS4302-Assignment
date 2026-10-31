import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const BPS_50_PERCENT = 5_000;
const BPS_60_PERCENT = 6_000;

const FOOD = ethers.id("Food");
const MEDICAL = ethers.id("Medical");

const evidenceHash = (text: string) =>
  ethers.keccak256(ethers.toUtf8Bytes(text));

describe("OpenAid charity donation platform", function () {
  async function deployFixture() {
    const [
      admin,
      charity,
      donor1,
      donor2,
      donor3,
      outsider,
      supplier,
      secondSupplier,
    ] = await ethers.getSigners();

    const registry = await ethers.deployContract("CharityRegistry");
    const factory = await ethers.deployContract("CharityFactory", [
      await registry.getAddress(),
    ]);

    await registry.setVerifiedCharity(charity.address, true);

    const block = await ethers.provider.getBlock("latest");
    if (block === null) throw new Error("Latest block not found");

    const fundingDeadline = block.timestamp + 1_000;
    const votingPeriod = 1_000;
    const campaignDeadline = block.timestamp + 10_000;
    const minDonation = ethers.parseEther("0.01");

    await factory.connect(charity).createCampaign(
      "Flood Relief 2026",
      "ipfs://campaign-metadata",
      fundingDeadline,
      campaignDeadline,
      votingPeriod,
      BPS_50_PERCENT,
      BPS_60_PERCENT,
      ["Food", "Medical"],
    );

    const campaigns = await factory.getCampaigns();
    const campaign = await ethers.getContractAt("CharityCampaign", campaigns[0]);

    return {
      admin,
      charity,
      donor1,
      donor2,
      donor3,
      outsider,
      supplier,
      secondSupplier,
      registry,
      factory,
      campaign,
      fundingDeadline,
      votingPeriod,
      campaignDeadline,
      minDonation,
    };
  }

  async function donateThreeToFood() {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { campaign, donor1, donor2, donor3 } = fixture;

    await campaign.connect(donor1).donate(FOOD, {
      value: ethers.parseEther("3"),
    });
    await campaign.connect(donor2).donate(FOOD, {
      value: ethers.parseEther("2"),
    });
    await campaign.connect(donor3).donate(FOOD, {
      value: ethers.parseEther("1"),
    });

    return fixture;
  }

  async function createFoodExpense(amount = ethers.parseEther("3")) {
    const fixture = await donateThreeToFood();
    const { campaign, charity, supplier, fundingDeadline } = fixture;

    await networkHelpers.time.increaseTo(fundingDeadline);

    await campaign.connect(charity).proposeExpense(
      FOOD,
      supplier.address,
      amount,
      "Purchase emergency food packages",
      "ipfs://food-invoice-and-delivery-proof",
      evidenceHash("food-evidence-v1"),
    );

    return fixture;
  }

  describe("Charity registry and factory", function () {
    it("lets only the registry admin verify charities", async function () {
      const { registry, outsider } = await networkHelpers.loadFixture(deployFixture);

      await expect(
        registry.connect(outsider).setVerifiedCharity(outsider.address, true),
      ).to.be.revertedWith("Only admin");

      await expect(registry.setVerifiedCharity(outsider.address, true))
        .to.emit(registry, "CharityVerificationUpdated")
        .withArgs(outsider.address, true);

      expect(await registry.isVerifiedCharity(outsider.address)).to.equal(true);
    });

    it("prevents an unverified wallet from creating a campaign", async function () {
      const { factory, outsider, fundingDeadline, campaignDeadline, votingPeriod } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        factory.connect(outsider).createCampaign(
          "Fake Charity",
          "ipfs://fake",
          fundingDeadline,
          campaignDeadline,
          votingPeriod,
          BPS_50_PERCENT,
          BPS_60_PERCENT,
          ["Food"],
        ),
      ).to.be.revertedWith("Charity not verified");
    });

    it("records campaigns created by a verified charity", async function () {
      const { factory, charity, campaign } =
        await networkHelpers.loadFixture(deployFixture);

      expect(await factory.getCampaignCount()).to.equal(1n);
      const charityCampaigns = await factory.getCampaignsByCharity(charity.address);
      expect(charityCampaigns[0]).to.equal(await campaign.getAddress());
      expect(await campaign.charity()).to.equal(charity.address);
    });
  });

  describe("Donations and category segregation", function () {
    it("accepts donations into a chosen category and tracks donors", async function () {
      const { campaign, donor1 } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseEther("1");

      await expect(campaign.connect(donor1).donate(FOOD, { value: amount }))
        .to.emit(campaign, "DonationReceived")
        .withArgs(donor1.address, FOOD, amount);

      const category = await campaign.getCategory(FOOD);
      expect(category.totalDonated).to.equal(amount);
      expect(category.availableBalance).to.equal(amount);
      expect(category.donorCount).to.equal(1n);
      expect(await campaign.totalUniqueDonors()).to.equal(1n);
      expect(await campaign.categoryContribution(FOOD, donor1.address)).to.equal(
        amount,
      );
    });

    it("counts the same donor only once even if they donate repeatedly", async function () {
      const { campaign, donor1 } = await networkHelpers.loadFixture(deployFixture);

      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("1"),
      });
      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("0.5"),
      });

      const category = await campaign.getCategory(FOOD);
      expect(category.donorCount).to.equal(1n);
      expect(await campaign.totalUniqueDonors()).to.equal(1n);
    });

    it("rejects unknown categories, tiny donations, late donations, and direct transfers", async function () {
      const { campaign, donor1, charity, fundingDeadline } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        campaign.connect(charity).donate(FOOD, {
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("Charity cannot donate");

      await expect(
        campaign.connect(donor1).donate(ethers.id("Unknown"), {
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("Unknown category");

      await expect(
        campaign.connect(donor1).donate(FOOD, {
          value: ethers.parseEther("0.009"),
        }),
      ).to.be.revertedWith("Minimum donation is 0.01 ETH.");

      await expect(
        donor1.sendTransaction({
          to: await campaign.getAddress(),
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("Use donate");

      await networkHelpers.time.increaseTo(fundingDeadline);
      await expect(
        campaign.connect(donor1).donate(FOOD, {
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("Funding closed");
    });

    it("keeps category funds isolated", async function () {
      const { campaign, donor1, donor2, charity, supplier, fundingDeadline } =
        await networkHelpers.loadFixture(deployFixture);

      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("1"),
      });
      await campaign.connect(donor2).donate(MEDICAL, {
        value: ethers.parseEther("10"),
      });

      await networkHelpers.time.increaseTo(fundingDeadline);

      await expect(
        campaign.connect(charity).proposeExpense(
          FOOD,
          supplier.address,
          ethers.parseEther("2"),
          "Food expense",
          "ipfs://proof",
          evidenceHash("proof"),
        ),
      ).to.be.revertedWith("Insufficient category funds");
    });

    it("accepts exactly the fixed minimum of 0.01 ETH", async function () {
      const { campaign, donor1, minDonation } =
        await networkHelpers.loadFixture(deployFixture);

      expect(await campaign.minDonation()).to.equal(minDonation);

      await expect(
        campaign.connect(donor1).donate(FOOD, { value: minDonation }),
      )
        .to.emit(campaign, "DonationReceived")
        .withArgs(donor1.address, FOOD, minDonation);
    });

    it("rejects zero and one wei below the minimum", async function () {
      const { campaign, donor1, minDonation } =
        await networkHelpers.loadFixture(deployFixture);

      for (const value of [0n, minDonation - 1n]) {
        await expect(
          campaign.connect(donor1).donate(FOOD, { value }),
        ).to.be.revertedWith("Minimum donation is 0.01 ETH.");
      }

      expect(await campaign.totalDonated()).to.equal(0n);
      expect(await campaign.totalUniqueDonors()).to.equal(0n);
    });
  });

  describe("Expense proposals and evidence", function () {
    it("allows only the charity to propose an evidence-backed expense after funding", async function () {
      const { campaign, charity, outsider, supplier, fundingDeadline } =
        await donateThreeToFood();

      await expect(
        campaign.connect(charity).proposeExpense(
          FOOD,
          supplier.address,
          ethers.parseEther("1"),
          "Too early",
          "ipfs://proof",
          evidenceHash("proof"),
        ),
      ).to.be.revertedWith("Funding still active");

      await networkHelpers.time.increaseTo(fundingDeadline);

      await expect(
        campaign.connect(outsider).proposeExpense(
          FOOD,
          supplier.address,
          ethers.parseEther("1"),
          "Unauthorized",
          "ipfs://proof",
          evidenceHash("proof"),
        ),
      ).to.be.revertedWith("Only charity");

      await expect(
        campaign.connect(charity).proposeExpense(
          FOOD,
          supplier.address,
          ethers.parseEther("1"),
          "Valid food purchase",
          "ipfs://proof",
          evidenceHash("proof"),
        ),
      ).to.emit(campaign, "ExpenseProposed");

      const expense = await campaign.getExpense(1n);
      expect(expense.categoryId).to.equal(FOOD);
      expect(expense.recipient).to.equal(supplier.address);
      expect(expense.amount).to.equal(ethers.parseEther("1"));
      expect(expense.evidenceHash).to.equal(evidenceHash("proof"));
      expect(expense.status).to.equal(1n); // ExpenseStatus.Voting
    });

    it("reserves funds so multiple proposals cannot over-commit one category", async function () {
      const { campaign, charity, supplier, secondSupplier, fundingDeadline } =
        await donateThreeToFood();

      await networkHelpers.time.increaseTo(fundingDeadline);

      await campaign.connect(charity).proposeExpense(
        FOOD,
        supplier.address,
        ethers.parseEther("5"),
        "First purchase",
        "ipfs://first",
        evidenceHash("first"),
      );

      await expect(
        campaign.connect(charity).proposeExpense(
          FOOD,
          secondSupplier.address,
          ethers.parseEther("2"),
          "Second purchase",
          "ipfs://second",
          evidenceHash("second"),
        ),
      ).to.be.revertedWith("Insufficient category funds");
    });
  });

  describe("Donors as decentralized human oracles", function () {
    it("allows only donors from the expense category to vote", async function () {
      const { campaign, donor1, outsider } = await createFoodExpense();

      await expect(campaign.connect(outsider).voteOnExpense(1n, true)).to.be
        .revertedWith("Not a category donor");

      await expect(campaign.connect(donor1).voteOnExpense(1n, true))
        .to.emit(campaign, "ExpenseVoteCast")
        .withArgs(1n, donor1.address, true);
    });

    it("gives each donor one vote regardless of how much they donated", async function () {
      const { campaign, donor1, donor2 } = await createFoodExpense();

      // donor1 gave 3 ETH and donor2 gave 2 ETH, but both increment YES by one.
      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);

      const expense = await campaign.getExpense(1n);
      expect(expense.yesVotes).to.equal(2n);
      expect(expense.noVotes).to.equal(0n);
    });

    it("prevents double voting", async function () {
      const { campaign, donor1 } = await createFoodExpense();

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await expect(
        campaign.connect(donor1).voteOnExpense(1n, false),
      ).to.be.revertedWith("Already voted");
    });

    it("lets donors raise a transparent dispute without giving one donor veto power", async function () {
      const { campaign, donor1 } = await createFoodExpense();
      const reasonHash = evidenceHash("Invoice appears inconsistent");

      await expect(campaign.connect(donor1).raiseDispute(1n, reasonHash))
        .to.emit(campaign, "DisputeRaised")
        .withArgs(1n, donor1.address, reasonHash);

      const expense = await campaign.getExpense(1n);
      expect(expense.disputeCount).to.equal(1n);
      expect(expense.status).to.equal(1n); // still Voting: dispute alone is not a veto
    });

    it("approves an expense only when quorum and approval threshold are both met", async function () {
      const { campaign, donor1, donor2 } = await createFoodExpense();

      // 3 donors exist in this category. 50% quorum means at least 2 must vote.
      // 60% approval means 2/2 YES passes.
      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);

      const before = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(before.voteEnd));

      await expect(campaign.finalizeExpense(1n))
        .to.emit(campaign, "ExpenseFinalized")
        .withArgs(1n, true, 2n, 0n, true);

      const after = await campaign.getExpense(1n);
      expect(after.status).to.equal(2n); // ExpenseStatus.Approved
    });

    it("rejects an expense if too few donors participate", async function () {
      const { campaign, donor1 } = await createFoodExpense();

      await campaign.connect(donor1).voteOnExpense(1n, true);

      const expense = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);

      const finalized = await campaign.getExpense(1n);
      expect(finalized.status).to.equal(3n); // ExpenseStatus.Rejected

      const food = await campaign.getCategory(FOOD);
      expect(food.reservedBalance).to.equal(0n);
    });

    it("rejects an expense if the approval ratio is too low", async function () {
      const { campaign, donor1, donor2 } = await createFoodExpense();

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, false);

      const expense = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);

      expect((await campaign.getExpense(1n)).status).to.equal(3n);
    });
  });

  describe("Approved spending", function () {
    it("pays the disclosed recipient only after donor approval", async function () {
      const { campaign, donor1, donor2, outsider, supplier } =
        await createFoodExpense(ethers.parseEther("3"));

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);

      const expense = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);

      await expect(campaign.connect(outsider).executeExpense(1n))
        .to.changeEtherBalances(
          ethers,
          [await campaign.getAddress(), supplier.address],
          [-ethers.parseEther("3"), ethers.parseEther("3")],
        );

      expect((await campaign.getExpense(1n)).status).to.equal(4n); // Paid
      expect(await campaign.totalSpent()).to.equal(ethers.parseEther("3"));

      const food = await campaign.getCategory(FOOD);
      expect(food.availableBalance).to.equal(ethers.parseEther("3"));
      expect(food.reservedBalance).to.equal(0n);
    });

    it("cannot execute a rejected or already-paid expense", async function () {
      const { campaign, donor1, donor2 } = await createFoodExpense();

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);
      const expense = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);
      await campaign.executeExpense(1n);

      await expect(campaign.executeExpense(1n)).to.be.revertedWith(
        "Expense not approved",
      );
    });
  });

  describe("Campaign closure and donor refunds", function () {
    it("returns unspent category funds pro-rata to the original donors", async function () {
      const {
        campaign,
        donor1,
        donor2,
        charity,
        supplier,
        fundingDeadline,
        campaignDeadline,
      } = await networkHelpers.loadFixture(deployFixture);

      // Food pool = 4 ETH. donor1 owns 75% of contributions; donor2 owns 25%.
      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("3"),
      });
      await campaign.connect(donor2).donate(FOOD, {
        value: ethers.parseEther("1"),
      });

      await networkHelpers.time.increaseTo(fundingDeadline);

      // Spend 2 ETH, leaving a 2 ETH refund pool.
      await campaign.connect(charity).proposeExpense(
        FOOD,
        supplier.address,
        ethers.parseEther("2"),
        "Food purchase",
        "ipfs://proof",
        evidenceHash("refund-test-proof"),
      );

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);

      const expense = await campaign.getExpense(1n);
      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);
      await campaign.executeExpense(1n);

      await networkHelpers.time.increaseTo(campaignDeadline + 1);
      await campaign.closeCampaign();

      await expect(campaign.connect(donor1).claimRefund(FOOD)).to.changeEtherBalance(
        ethers,
        donor1,
        ethers.parseEther("1.5"),
      );

      await expect(campaign.connect(donor2).claimRefund(FOOD)).to.changeEtherBalance(
        ethers,
        donor2,
        ethers.parseEther("0.5"),
      );

      await expect(campaign.connect(donor1).claimRefund(FOOD)).to.be.revertedWith(
        "Refund already claimed",
      );
    });

    it("does not allow refunds before the campaign is closed", async function () {
      const { campaign, donor1 } = await networkHelpers.loadFixture(deployFixture);

      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("1"),
      });

      await expect(campaign.connect(donor1).claimRefund(FOOD)).to.be.revertedWith(
        "Campaign not closed",
      );
    });
  });
  
  describe("Charity revocation", function () {
    it("allows early closure and refunds after revocation", async function () {
      const { registry, charity, campaign, donor1, donor2 } =
        await networkHelpers.loadFixture(deployFixture);

      await campaign.connect(donor1).donate(FOOD, {
        value: ethers.parseEther("3"),
      });

      await campaign.connect(donor2).donate(FOOD, {
        value: ethers.parseEther("1"),
      });

      // A verified campaign cannot close before its deadline.
      await expect(campaign.closeCampaign())
        .to.be.revertedWith("Campaign still active");

      // The default registry signer is the admin.
      await registry.setVerifiedCharity(charity.address, false);

      expect(await campaign.isRevoked()).to.equal(true);

      await expect(
        campaign.connect(donor1).donate(FOOD, {
          value: ethers.parseEther("0.01"),
        }),
      ).to.be.revertedWith("Campaign revoked: refunds available");

      // Any account can close the revoked campaign.
      await campaign.connect(donor1).closeCampaign();

      expect(await campaign.closed()).to.equal(true);

      await expect(
        campaign.connect(donor1).claimRefund(FOOD),
      ).to.changeEtherBalance(
        ethers,
        donor1,
        ethers.parseEther("3"),
      );

      await expect(
        campaign.connect(donor2).claimRefund(FOOD),
      ).to.changeEtherBalance(
        ethers,
        donor2,
        ethers.parseEther("1"),
      );

      await expect(
        campaign.connect(donor1).claimRefund(FOOD),
      ).to.be.revertedWith("Refund already claimed");
    });

    it("blocks approved payments and does not revive old campaigns", async function () {
      const { registry, charity, campaign, donor1, donor2 } =
        await createFoodExpense();

      await campaign.connect(donor1).voteOnExpense(1n, true);
      await campaign.connect(donor2).voteOnExpense(1n, true);

      const expense = await campaign.getExpense(1n);

      await networkHelpers.time.increaseTo(Number(expense.voteEnd));
      await campaign.finalizeExpense(1n);

      await registry.setVerifiedCharity(charity.address, false);

      await expect(
        campaign.executeExpense(1n),
      ).to.be.revertedWith("Campaign revoked: refunds available");

      // Re-verification must not revive this existing campaign.
      await registry.setVerifiedCharity(charity.address, true);

      expect(await registry.isVerifiedCharity(charity.address)).to.equal(true);
      expect(await campaign.isRevoked()).to.equal(true);

      await expect(
        campaign.executeExpense(1n),
      ).to.be.revertedWith("Campaign revoked: refunds available");

      await campaign.closeCampaign();

      const food = await campaign.getCategory(FOOD);

      // All 6 ETH remain because the approved expense was never paid.
      expect(food.refundPool).to.equal(ethers.parseEther("6"));
      expect(food.reservedBalance).to.equal(0n);

      await expect(
        campaign.connect(donor1).claimRefund(FOOD),
      ).to.changeEtherBalance(
        ethers,
        donor1,
        ethers.parseEther("3"),
      );
    });
  });
});
