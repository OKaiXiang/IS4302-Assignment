import { ethers } from "ethers";

const FACTORY_ABI = [
  "function registry() view returns (address)",
  "function getCampaigns() view returns (address[])",
  "function getCampaignCount() view returns (uint256)",
  "function createCampaign(string title,string descriptionURI,uint256 fundingDeadline,uint256 campaignDeadline,uint256 votingPeriod,uint256 quorumBps,uint256 approvalBps,uint256 minDonation,string[] categoryNames) returns (address campaignAddress)",
];

const REGISTRY_ABI = [
  "function admin() view returns (address)",
  "function isVerifiedCharity(address charity) view returns (bool)",
  "function setVerifiedCharity(address charity,bool verified)",
];

const CAMPAIGN_ABI = [
  "function charity() view returns (address)",
  "function title() view returns (string)",
  "function descriptionURI() view returns (string)",
  "function fundingDeadline() view returns (uint256)",
  "function campaignDeadline() view returns (uint256)",
  "function votingPeriod() view returns (uint256)",
  "function quorumBps() view returns (uint256)",
  "function approvalBps() view returns (uint256)",
  "function minDonation() view returns (uint256)",
  "function totalDonated() view returns (uint256)",
  "function totalSpent() view returns (uint256)",
  "function totalUniqueDonors() view returns (uint256)",
  "function expenseCount() view returns (uint256)",
  "function closed() view returns (bool)",
  "function getCategoryIds() view returns (bytes32[])",
  "function getCategory(bytes32 categoryId) view returns (tuple(string name,uint256 totalDonated,uint256 availableBalance,uint256 reservedBalance,uint256 donorCount,uint256 refundPool,bool exists))",
  "function getExpense(uint256 expenseId) view returns (tuple(bytes32 categoryId,address recipient,uint256 amount,string description,string evidenceURI,bytes32 evidenceHash,uint256 voteEnd,uint256 yesVotes,uint256 noVotes,uint256 disputeCount,uint8 status))",
  "function categoryContribution(bytes32 categoryId,address donor) view returns (uint256)",
  "function hasVoted(uint256 expenseId,address donor) view returns (bool)",
  "function hasRaisedDispute(uint256 expenseId,address donor) view returns (bool)",
  "function refundClaimed(bytes32 categoryId,address donor) view returns (bool)",
  "function donate(bytes32 categoryId) payable",
  "function proposeExpense(bytes32 categoryId,address recipient,uint256 amount,string description,string evidenceURI,bytes32 evidenceHash) returns (uint256 expenseId)",
  "function voteOnExpense(uint256 expenseId,bool support)",
  "function raiseDispute(uint256 expenseId,bytes32 reasonHash)",
  "function finalizeExpense(uint256 expenseId)",
  "function executeExpense(uint256 expenseId)",
  "function closeCampaign()",
  "function claimRefund(bytes32 categoryId)",
];

const STATUS_NAMES = ["None", "Voting", "Approved", "Rejected", "Paid"];
const HARDHAT_CHAIN_ID = 31337n;
const RPC_URL = "http://127.0.0.1:8545";
const ROLE_NAMES = ["Admin", "Charity", "Alice · Donor", "Bob · Donor", "Charlie · Donor", "Supplier"];

let provider;
let signer;
let account = "";
let accountIndex = 0;
let factory;
let registry;
let factoryAddress = "";
let selectedCampaign;
let selectedCampaignAddress = "";
let selectedCampaignData;

const $ = (id) => document.getElementById(id);

function setStatus(message, type = "info") {
  const box = $("status");
  box.textContent = message;
  box.className = `status ${type}`;
}

function shortAddress(value) {
  if (!value || value.length < 12) return value || "—";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatEth(value) {
  return `${Number(ethers.formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 5 })} ETH`;
}

function formatDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

async function refreshBlockTime() {
  if (!provider) return null;

  // Get the latest block directly from Hardhat
  const latestBlock = await provider.send(
    "eth_getBlockByNumber",
    ["latest", false]
  );

  if (!latestBlock) {
    throw new Error("Could not read the latest Hardhat block.");
  }

  const timestamp = Number(BigInt(latestBlock.timestamp));

  $("blockTimestamp").textContent = String(timestamp);
  $("blockTime").textContent = formatDate(timestamp);

  return timestamp;
}

function toEvidenceHash(value) {
  const trimmed = value.trim();
  if (ethers.isHexString(trimmed, 32)) return trimmed;
  return ethers.keccak256(ethers.toUtf8Bytes(trimmed));
}

function evidenceLink(uri) {
  if (!uri) return "#";
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}

function getErrorMessage(error) {
  const candidates = [
    error?.shortMessage,
    error?.reason,
    error?.info?.error?.message,
    error?.message,
  ].filter(Boolean);
  const raw = candidates[0] || "Unknown transaction error";
  return raw.replace(/^execution reverted:\s*/i, "");
}

async function connectLocalHardhat() {
  try {
    setStatus("Connecting directly to Hardhat localhost…");
    provider = new ethers.JsonRpcProvider(window.OPENAID_CONFIG?.rpcUrl || RPC_URL);
    const network = await provider.getNetwork();
    if (network.chainId !== HARDHAT_CHAIN_ID) {
      throw new Error(`Expected Hardhat chain 31337, but RPC returned chain ${network.chainId}.`);
    }

    const accounts = await provider.send("eth_accounts", []);
    if (!accounts.length) throw new Error("Hardhat node returned no unlocked accounts.");

    const select = $("accountSelect");
    select.innerHTML = accounts.slice(0, 10).map((address, index) => {
      const role = ROLE_NAMES[index] || `Hardhat Account ${index}`;
      return `<option value="${index}">${escapeHtml(role)} — ${escapeHtml(shortAddress(address))}</option>`;
    }).join("");

    accountIndex = Math.min(Number(select.value || 0), accounts.length - 1);
    select.value = String(accountIndex);
    await switchAccount(accountIndex, false);
    await refreshBlockTime();

    $("networkBadge").textContent = `Hardhat ${network.chainId}`;
    setStatus("Connected directly to the local Hardhat node. No MetaMask required.", "success");

    if ($("factoryAddressInput").value.trim()) await loadFactory();
  } catch (error) {
    setStatus(`Could not connect to Hardhat: ${getErrorMessage(error)}. Make sure "npx hardhat node" is running.`, "error");
  }
}

async function switchAccount(index, refresh = true) {
  if (!provider) throw new Error("Connect to Hardhat first.");
  accountIndex = Number(index);
  signer = await provider.getSigner(accountIndex);
  account = await signer.getAddress();
  const balance = await provider.getBalance(account);
  $("walletAddress").textContent = account;
  $("accountBalance").textContent = formatEth(balance);
  $("activeRole").textContent = ROLE_NAMES[accountIndex] || `Hardhat Account ${accountIndex}`;

  await refreshBlockTime();

  if (factoryAddress) {
    factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);
    const registryAddress = await factory.registry();
    registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
    const admin = await registry.admin();
    const verified = await registry.isVerifiedCharity(account);
    $("adminInfo").textContent = `Registry admin: ${admin}. Current account verified as charity: ${verified ? "yes" : "no"}.`;
    if (selectedCampaignAddress) {
      selectedCampaign = new ethers.Contract(selectedCampaignAddress, CAMPAIGN_ABI, signer);
    }
  }

  if (refresh) {
    setStatus(`Now acting as ${ROLE_NAMES[accountIndex] || `Account ${accountIndex}`} (${shortAddress(account)}).`, "success");
    if (factory) await refreshCampaigns();
    if (selectedCampaign) await refreshSelectedCampaign();
  }
}

async function advanceTime(seconds) {
  if (!provider) return setStatus("Connect to Hardhat first.", "error");
  try {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
    await refreshBlockTime();
    setStatus(`Advanced local Hardhat time by ${Math.round(seconds / 60)} minute(s).`, "success");
    if (selectedCampaign) await refreshSelectedCampaign();
    if (factory) await refreshCampaigns();
  } catch (error) {
    setStatus(`Advance time failed: ${getErrorMessage(error)}`, "error");
  }
}

async function loadFactory() {
  try {
    const value = $("factoryAddressInput").value.trim();
    if (!ethers.isAddress(value)) throw new Error("Enter a valid factory contract address.");

    factoryAddress = ethers.getAddress(value);
    localStorage.setItem("openaid.factoryAddress", factoryAddress);
    factory = new ethers.Contract(factoryAddress, FACTORY_ABI, signer);

    const code = await provider.getCode(factoryAddress);
    if (code === "0x") throw new Error("No contract exists at that address on the connected network.");

    const registryAddress = await factory.registry();
    registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
    $("registryAddress").textContent = registryAddress;

    const admin = await registry.admin();
    const verified = await registry.isVerifiedCharity(account);
    $("adminInfo").textContent = `Registry admin: ${admin}. Current wallet verified as charity: ${verified ? "yes" : "no"}.`;

    setStatus(`Loaded OpenAid factory ${shortAddress(factoryAddress)}.`, "success");
    await refreshCampaigns();
  } catch (error) {
    factory = undefined;
    registry = undefined;
    setStatus(getErrorMessage(error), "error");
  }
}

async function runTransaction(label, action, after) {
  try {
    setStatus(`${label}: sending transaction from ${shortAddress(account)}…`);
    const tx = await action();
    setStatus(`${label}: transaction submitted (${shortAddress(tx.hash)}).`);
    await tx.wait();
    await refreshBlockTime();
    setStatus(`${label}: confirmed.`, "success");
    if (after) await after();
  } catch (error) {
    setStatus(`${label}: ${getErrorMessage(error)}`, "error");
  }
}

async function updateCharityVerification(verified) {
  if (!registry) return setStatus("Load the factory first.", "error");
  const address = $("verifyCharityAddress").value.trim() || account;
  if (!ethers.isAddress(address)) return setStatus("Enter a valid charity address.", "error");

  await runTransaction(
    verified ? "Verify charity" : "Remove charity verification",
    () => registry.setVerifiedCharity(address, verified),
    loadFactory,
  );
}

async function createCampaign() {
  if (!factory) return setStatus("Load the factory first.", "error");
  const now = await refreshBlockTime();

  if (now === null) {
    return setStatus("Connect to Hardhat first.", "error");
  }
  const fundingMinutes = Number($("fundingMinutes").value);
  const campaignMinutes = Number($("campaignMinutes").value);
  const votingMinutes = Number($("votingMinutes").value);
  const categories = $("categoryNames").value.split(",").map((v) => v.trim()).filter(Boolean);

  if (!categories.length) return setStatus("Add at least one category.", "error");

  const args = [
    $("campaignTitle").value.trim(),
    $("campaignDescription").value.trim(),
    now + Math.round(fundingMinutes * 60),
    now + Math.round(campaignMinutes * 60),
    Math.round(votingMinutes * 60),
    Math.round(Number($("quorumPercent").value) * 100),
    Math.round(Number($("approvalPercent").value) * 100),
    ethers.parseEther($("minDonation").value),
    categories,
  ];

  await runTransaction("Create campaign", () => factory.createCampaign(...args), refreshCampaigns);
}

async function refreshCampaigns() {
  if (!factory) return;
  const container = $("campaignList");
  container.className = "campaign-list";
  container.innerHTML = "";

  try {
    const addresses = await factory.getCampaigns();
    if (!addresses.length) {
      container.className = "campaign-list empty-state";
      container.textContent = "No campaigns have been created yet.";
      return;
    }

    for (const address of addresses) {
      const campaign = new ethers.Contract(address, CAMPAIGN_ABI, signer);
      const [title, charity, totalDonated, totalSpent, closed] = await Promise.all([
        campaign.title(), campaign.charity(), campaign.totalDonated(), campaign.totalSpent(), campaign.closed(),
      ]);
      const item = document.createElement("article");
      item.className = "campaign-item";
      item.innerHTML = `
        <div>
          <h3>${escapeHtml(title)}</h3>
          <div class="campaign-meta">
            <span>${shortAddress(address)}</span>
            <span>Charity ${shortAddress(charity)}</span>
            <span>${formatEth(totalDonated)} donated</span>
            <span>${formatEth(totalSpent)} spent</span>
            <span>${closed ? "Closed" : "Active"}</span>
          </div>
        </div>
        <button class="button primary">Open</button>`;
      item.querySelector("button").addEventListener("click", () => selectCampaign(address));
      container.appendChild(item);
    }
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

async function selectCampaign(address) {
  selectedCampaignAddress = ethers.getAddress(address);
  selectedCampaign = new ethers.Contract(selectedCampaignAddress, CAMPAIGN_ABI, signer);
  $("campaignPanel").classList.remove("hidden");
  await refreshSelectedCampaign();
  $("campaignPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function refreshSelectedCampaign() {
  if (!selectedCampaign) return;
  try {
    const [
      title, charity, descriptionURI, fundingDeadline, campaignDeadline, votingPeriod,
      quorumBps, approvalBps, minDonation, totalDonated, totalSpent, totalUniqueDonors,
      expenseCount, closed, categoryIds,
    ] = await Promise.all([
      selectedCampaign.title(),
      selectedCampaign.charity(),
      selectedCampaign.descriptionURI(),
      selectedCampaign.fundingDeadline(),
      selectedCampaign.campaignDeadline(),
      selectedCampaign.votingPeriod(),
      selectedCampaign.quorumBps(),
      selectedCampaign.approvalBps(),
      selectedCampaign.minDonation(),
      selectedCampaign.totalDonated(),
      selectedCampaign.totalSpent(),
      selectedCampaign.totalUniqueDonors(),
      selectedCampaign.expenseCount(),
      selectedCampaign.closed(),
      selectedCampaign.getCategoryIds(),
    ]);

    const categories = [];
    for (const id of categoryIds) {
      const category = await selectedCampaign.getCategory(id);
      categories.push({
        id,
        name: category.name,
        totalDonated: category.totalDonated,
        availableBalance: category.availableBalance,
        reservedBalance: category.reservedBalance,
        donorCount: category.donorCount,
        refundPool: category.refundPool,
        exists: category.exists,
      });
    }

    selectedCampaignData = {
      title, charity, descriptionURI, fundingDeadline, campaignDeadline, votingPeriod,
      quorumBps, approvalBps, minDonation, totalDonated, totalSpent, totalUniqueDonors,
      expenseCount, closed, categories,
    };

    $("selectedCampaignTitle").textContent = title;
    $("selectedCampaignAddress").textContent = selectedCampaignAddress;

    const now = await refreshBlockTime();
    const phase = closed ? "Closed" : now < Number(fundingDeadline) ? "Funding" : now <= Number(campaignDeadline) ? "Spending / voting" : "Expired — ready to close";
    $("campaignStats").innerHTML = [
      ["Phase", phase],
      ["Total donated", formatEth(totalDonated)],
      ["Total spent", formatEth(totalSpent)],
      ["Unique donors", totalUniqueDonors.toString()],
      ["Funding deadline", formatDate(fundingDeadline)],
      ["Campaign deadline", formatDate(campaignDeadline)],
      ["Min donation", formatEth(minDonation)],
      ["Voting period", `${Math.round(Number(votingPeriod) / 60)} min`],
      ["Quorum", `${Number(quorumBps) / 100}%`],
      ["Approval", `${Number(approvalBps) / 100}%`],
      ["Charity", shortAddress(charity)],
      ["Metadata", descriptionURI || "—"],
    ].map(([label, value]) => `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("");

    renderCategories(categories);
    populateCategorySelects(categories);
    await renderExpenses(Number(expenseCount), now);
  } catch (error) {
    setStatus(getErrorMessage(error), "error");
  }
}

function renderCategories(categories) {
  const container = $("categoryCards");
  container.innerHTML = "";
  for (const c of categories) {
    const card = document.createElement("div");
    card.className = "category-card";
    card.innerHTML = `
      <h4>${escapeHtml(c.name)}</h4>
      <div class="category-line"><span>Donated</span><strong>${formatEth(c.totalDonated)}</strong></div>
      <div class="category-line"><span>Available</span><strong>${formatEth(c.availableBalance)}</strong></div>
      <div class="category-line"><span>Reserved</span><strong>${formatEth(c.reservedBalance)}</strong></div>
      <div class="category-line"><span>Donors</span><strong>${c.donorCount.toString()}</strong></div>
      <div class="category-line"><span>Refund pool</span><strong>${formatEth(c.refundPool)}</strong></div>`;
    container.appendChild(card);
  }
}

function populateCategorySelects(categories) {
  for (const id of ["donateCategory", "refundCategory", "expenseCategory"]) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  }
}

async function donate() {
  if (!selectedCampaign) return;
  const categoryId = $("donateCategory").value;
  const amount = ethers.parseEther($("donationAmount").value);
  await runTransaction("Donate", () => selectedCampaign.donate(categoryId, { value: amount }), async () => {
    await refreshSelectedCampaign();
    await refreshCampaigns();
  });
}

async function proposeExpense() {
  if (!selectedCampaign) return;
  const recipient = $("expenseRecipient").value.trim();
  if (!ethers.isAddress(recipient)) return setStatus("Enter a valid expense recipient wallet.", "error");
  const evidence = $("evidenceHash").value;
  if (!evidence.trim()) return setStatus("Enter evidence hash/text.", "error");

  await runTransaction(
    "Propose expense",
    () => selectedCampaign.proposeExpense(
      $("expenseCategory").value,
      recipient,
      ethers.parseEther($("expenseAmount").value),
      $("expenseDescription").value.trim(),
      $("evidenceUri").value.trim(),
      toEvidenceHash(evidence),
    ),
    refreshSelectedCampaign,
  );
}

async function renderExpenses(count, now) {
  const container = $("expenseList");
  container.innerHTML = "";
  container.className = "expense-list";
  if (!count) {
    container.className = "expense-list empty-state";
    container.textContent = "No expenses have been proposed yet.";
    return;
  }

  const categoriesById = new Map(selectedCampaignData.categories.map((c) => [c.id.toLowerCase(), c]));

  for (let id = 1; id <= count; id++) {
    const expense = await selectedCampaign.getExpense(id);
    const category = categoriesById.get(expense.categoryId.toLowerCase());
    const contribution = account ? await selectedCampaign.categoryContribution(expense.categoryId, account) : 0n;
    const voted = account ? await selectedCampaign.hasVoted(id, account) : false;
    const disputed = account ? await selectedCampaign.hasRaisedDispute(id, account) : false;
    const totalVotes = Number(expense.yesVotes + expense.noVotes);
    const yesPercent = totalVotes ? Math.round(Number(expense.yesVotes) * 100 / totalVotes) : 0;
    const status = STATUS_NAMES[Number(expense.status)] || "Unknown";

    const node = $("expenseTemplate").content.firstElementChild.cloneNode(true);
    const statusNode = node.querySelector(".expense-status");
    statusNode.textContent = status;
    statusNode.classList.add(status.toLowerCase());
    node.querySelector(".expense-title").textContent = `#${id} · ${expense.description}`;
    node.querySelector(".expense-amount").textContent = formatEth(expense.amount);

    const detailGrid = node.querySelector(".detail-grid");
    detailGrid.innerHTML = [
      ["Category", category?.name || expense.categoryId],
      ["Recipient", expense.recipient],
      ["Vote ends", formatDate(expense.voteEnd)],
      ["Disputes", expense.disputeCount.toString()],
      ["Evidence", `<a href="${escapeAttribute(evidenceLink(expense.evidenceURI))}" target="_blank" rel="noreferrer">${escapeHtml(expense.evidenceURI)}</a>`],
      ["Evidence hash", expense.evidenceHash],
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${label === "Evidence" ? value : escapeHtml(String(value))}</dd></div>`).join("");

    node.querySelector(".vote-copy").innerHTML = `<span>YES ${expense.yesVotes} · NO ${expense.noVotes}</span><span>${yesPercent}% approval among votes cast</span>`;
    node.querySelector(".meter span").style.width = `${yesPercent}%`;

    const actions = node.querySelector(".expense-actions");
    const eligibleDonor = contribution > 0n && account.toLowerCase() !== expense.recipient.toLowerCase();

    if (Number(expense.status) === 1 && now < Number(expense.voteEnd) && eligibleDonor && !voted) {
      actions.appendChild(actionButton("Vote YES", "primary", () => expenseAction(`Vote YES on #${id}`, () => selectedCampaign.voteOnExpense(id, true))));
      actions.appendChild(actionButton("Vote NO", "danger", () => expenseAction(`Vote NO on #${id}`, () => selectedCampaign.voteOnExpense(id, false))));
    }
    if (Number(expense.status) === 1 && now < Number(expense.voteEnd) && contribution > 0n && !disputed) {
      actions.appendChild(actionButton("Raise dispute", "secondary", async () => {
        const reason = prompt("Brief dispute reason (stored as a hash on-chain):");
        if (!reason) return;
        await expenseAction(`Dispute expense #${id}`, () => selectedCampaign.raiseDispute(id, toEvidenceHash(reason)));
      }));
    }
    if (Number(expense.status) === 1 && now >= Number(expense.voteEnd)) {
      actions.appendChild(actionButton("Finalize vote", "secondary", () => expenseAction(`Finalize expense #${id}`, () => selectedCampaign.finalizeExpense(id))));
    }
    if (Number(expense.status) === 2 && now <= Number(selectedCampaignData.campaignDeadline)) {
      actions.appendChild(actionButton("Execute payment", "primary", () => expenseAction(`Pay expense #${id}`, () => selectedCampaign.executeExpense(id))));
    }

    if (!actions.children.length) {
      const note = document.createElement("span");
      note.className = "hint";
      note.textContent = contribution > 0n ? (voted ? "Your vote is recorded." : "No action available in the current phase.") : "You did not fund this category, so you cannot vote on this expense.";
      actions.appendChild(note);
    }

    container.appendChild(node);
  }
}

function actionButton(text, style, handler) {
  const button = document.createElement("button");
  button.className = `button ${style} small-btn`;
  button.textContent = text;
  button.addEventListener("click", handler);
  return button;
}

async function expenseAction(label, action) {
  await runTransaction(label, action, refreshSelectedCampaign);
}

async function closeCampaign() {
  if (!selectedCampaign) return;
  await runTransaction("Close campaign", () => selectedCampaign.closeCampaign(), refreshSelectedCampaign);
}

async function claimRefund() {
  if (!selectedCampaign) return;
  await runTransaction("Claim refund", () => selectedCampaign.claimRefund($("refundCategory").value), refreshSelectedCampaign);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

$("connectLocalBtn").addEventListener("click", connectLocalHardhat);
$("accountSelect").addEventListener("change", (event) => switchAccount(Number(event.target.value)));
$("advance2Btn").addEventListener("click", () => advanceTime(2 * 60));
$("advance10Btn").addEventListener("click", () => advanceTime(10 * 60));
$("loadFactoryBtn").addEventListener("click", loadFactory);
$("verifyCharityBtn").addEventListener("click", () => updateCharityVerification(true));
$("unverifyCharityBtn").addEventListener("click", () => updateCharityVerification(false));
$("createCampaignBtn").addEventListener("click", createCampaign);
$("refreshCampaignsBtn").addEventListener("click", refreshCampaigns);
$("refreshCampaignBtn").addEventListener("click", refreshSelectedCampaign);
$("donateBtn").addEventListener("click", donate);
$("proposeExpenseBtn").addEventListener("click", proposeExpense);
$("closeCampaignBtn").addEventListener("click", closeCampaign);
$("claimRefundBtn").addEventListener("click", claimRefund);

const configuredAddress = window.OPENAID_CONFIG?.factoryAddress || localStorage.getItem("openaid.factoryAddress") || "";
if (configuredAddress) $("factoryAddressInput").value = configuredAddress;

connectLocalHardhat();
