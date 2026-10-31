// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title CharityCampaign
 * @notice Holds donor funds in escrow and releases them only after donors approve
 *         a charity's evidence-backed expense proposal.
 *
 * Design choices:
 * - Donations happen only during a funding phase.
 * - Spending proposals happen only after funding closes, so donor eligibility is frozen.
 * - Donors vote only on expenses from categories they funded.
 * - One donor address gets one vote per expense, regardless of donation size.
 * - Each expense needs both voter quorum and an approval threshold.
 * - Evidence itself remains off-chain; a URI and content hash are stored on-chain.
 * - Unspent money is refundable pro-rata after the campaign deadline.
 */
contract CharityCampaign {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_CATEGORIES = 20;

    enum ExpenseStatus {
        None,
        Voting,
        Approved,
        Rejected,
        Paid
    }

    struct Category {
        string name;
        uint256 totalDonated;
        uint256 availableBalance;
        uint256 reservedBalance;
        uint256 donorCount;
        uint256 refundPool;
        bool exists;
    }

    struct Expense {
        bytes32 categoryId;
        address payable recipient;
        uint256 amount;
        string description;
        string evidenceURI;
        bytes32 evidenceHash;
        uint256 voteEnd;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 disputeCount;
        ExpenseStatus status;
    }

    address public immutable charity;
    string public title;
    string public descriptionURI;

    uint256 public immutable fundingDeadline;
    uint256 public immutable campaignDeadline;
    uint256 public immutable votingPeriod;
    uint256 public immutable quorumBps;
    uint256 public immutable approvalBps;
    uint256 public constant minDonation = 0.01 ether;

    uint256 public totalDonated;
    uint256 public totalSpent;
    uint256 public totalUniqueDonors;
    uint256 public expenseCount;
    bool public closed;

    mapping(bytes32 => Category) private _categories;
    bytes32[] private _categoryIds;

    // category => donor => amount contributed to that category
    mapping(bytes32 => mapping(address => uint256)) public categoryContribution;
    mapping(address => uint256) public totalContributionByDonor;

    // expense => donor => voted/disputed flags
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => bool)) public hasRaisedDispute;

    // category => donor => refund claimed
    mapping(bytes32 => mapping(address => bool)) public refundClaimed;

    mapping(uint256 => Expense) private _expenses;

    bool private _entered;

    event DonationReceived(
        address indexed donor,
        bytes32 indexed categoryId,
        uint256 amount
    );

    event ExpenseProposed(
        uint256 indexed expenseId,
        bytes32 indexed categoryId,
        address indexed recipient,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 voteEnd
    );

    event ExpenseVoteCast(
        uint256 indexed expenseId,
        address indexed donor,
        bool support
    );

    event DisputeRaised(
        uint256 indexed expenseId,
        address indexed donor,
        bytes32 indexed reasonHash
    );

    event ExpenseFinalized(
        uint256 indexed expenseId,
        bool approved,
        uint256 yesVotes,
        uint256 noVotes,
        bool quorumMet
    );

    event ExpensePaid(
        uint256 indexed expenseId,
        address indexed recipient,
        uint256 amount
    );

    event CampaignClosed(uint256 totalRefundable);

    event RefundClaimed(
        address indexed donor,
        bytes32 indexed categoryId,
        uint256 amount
    );

    modifier onlyCharity() {
        require(msg.sender == charity, "Only charity");
        _;
    }

    modifier nonReentrant() {
        require(!_entered, "Reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(
        address charity_,
        string memory title_,
        string memory descriptionURI_,
        uint256 fundingDeadline_,
        uint256 campaignDeadline_,
        uint256 votingPeriod_,
        uint256 quorumBps_,
        uint256 approvalBps_,
        string[] memory categoryNames_
    ) {
        require(charity_ != address(0), "Invalid charity");
        require(bytes(title_).length > 0, "Empty title");
        require(fundingDeadline_ > block.timestamp, "Funding deadline not future");
        require(campaignDeadline_ > fundingDeadline_, "Invalid campaign deadline");
        require(votingPeriod_ > 0, "Invalid voting period");
        require(
            fundingDeadline_ + votingPeriod_ <= campaignDeadline_,
            "Voting period too long"
        );
        require(quorumBps_ > 0 && quorumBps_ <= BPS_DENOMINATOR, "Invalid quorum");
        require(
            approvalBps_ > 0 && approvalBps_ <= BPS_DENOMINATOR,
            "Invalid approval threshold"
        );
        require(
            categoryNames_.length > 0 && categoryNames_.length <= MAX_CATEGORIES,
            "Invalid categories"
        );

        charity = charity_;
        title = title_;
        descriptionURI = descriptionURI_;
        fundingDeadline = fundingDeadline_;
        campaignDeadline = campaignDeadline_;
        votingPeriod = votingPeriod_;
        quorumBps = quorumBps_;
        approvalBps = approvalBps_;

        for (uint256 i = 0; i < categoryNames_.length; i++) {
            string memory name = categoryNames_[i];
            require(bytes(name).length > 0, "Empty category");

            bytes32 id = categoryIdFor(name);
            require(!_categories[id].exists, "Duplicate category");

            _categories[id].name = name;
            _categories[id].exists = true;
            _categoryIds.push(id);
        }
    }

    /**
     * @notice Derives a deterministic category id from its display name.
     */
    function categoryIdFor(string memory name) public pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function donate(bytes32 categoryId) external payable {
        require(!closed, "Campaign closed");
        require(msg.sender != charity, "Charity cannot donate");
        require(block.timestamp < fundingDeadline, "Funding closed");
        require(msg.value >= minDonation, "Minimum donation is 0.01 ETH.");

        Category storage category = _categories[categoryId];
        require(category.exists, "Unknown category");

        if (totalContributionByDonor[msg.sender] == 0) {
            totalUniqueDonors += 1;
        }

        if (categoryContribution[categoryId][msg.sender] == 0) {
            category.donorCount += 1;
        }

        totalContributionByDonor[msg.sender] += msg.value;
        categoryContribution[categoryId][msg.sender] += msg.value;

        totalDonated += msg.value;
        category.totalDonated += msg.value;
        category.availableBalance += msg.value;

        emit DonationReceived(msg.sender, categoryId, msg.value);
    }

    /**
     * @notice Charity proposes a payment and supplies a pointer + hash to off-chain evidence.
     *         The requested amount is reserved so the charity cannot over-commit the same funds
     *         across multiple simultaneous proposals.
     */
    function proposeExpense(
        bytes32 categoryId,
        address payable recipient,
        uint256 amount,
        string calldata description,
        string calldata evidenceURI,
        bytes32 evidenceHash
    ) external onlyCharity returns (uint256 expenseId) {
        require(!closed, "Campaign closed");
        require(block.timestamp >= fundingDeadline, "Funding still active");
        require(
            block.timestamp + votingPeriod <= campaignDeadline,
            "Not enough time to vote"
        );
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        require(bytes(description).length > 0, "Empty description");
        require(bytes(evidenceURI).length > 0, "Missing evidence URI");
        require(evidenceHash != bytes32(0), "Missing evidence hash");

        Category storage category = _categories[categoryId];
        require(category.exists, "Unknown category");
        require(category.donorCount > 0, "No donors in category");

        uint256 unreserved = category.availableBalance - category.reservedBalance;
        require(amount <= unreserved, "Insufficient category funds");

        category.reservedBalance += amount;

        expenseCount += 1;
        expenseId = expenseCount;

        Expense storage expense = _expenses[expenseId];
        expense.categoryId = categoryId;
        expense.recipient = recipient;
        expense.amount = amount;
        expense.description = description;
        expense.evidenceURI = evidenceURI;
        expense.evidenceHash = evidenceHash;
        expense.voteEnd = block.timestamp + votingPeriod;
        expense.status = ExpenseStatus.Voting;

        emit ExpenseProposed(
            expenseId,
            categoryId,
            recipient,
            amount,
            evidenceHash,
            expense.voteEnd
        );
    }

    /**
     * @notice One donor address gets one oracle vote on an expense in a category they funded.
     */
    function voteOnExpense(uint256 expenseId, bool support) external {
        Expense storage expense = _expenses[expenseId];
        require(expense.status == ExpenseStatus.Voting, "Expense not voting");
        require(block.timestamp < expense.voteEnd, "Voting ended");
        require(
            categoryContribution[expense.categoryId][msg.sender] > 0,
            "Not a category donor"
        );
        require(msg.sender != expense.recipient, "Recipient cannot vote");
        require(!hasVoted[expenseId][msg.sender], "Already voted");

        hasVoted[expenseId][msg.sender] = true;

        if (support) {
            expense.yesVotes += 1;
        } else {
            expense.noVotes += 1;
        }

        emit ExpenseVoteCast(expenseId, msg.sender, support);
    }

    /**
     * @notice A donor may publicly flag suspicious evidence and commit a hash of their reason.
     *         Raising a dispute does not itself decide the expense; the collective vote does.
     */
    function raiseDispute(uint256 expenseId, bytes32 reasonHash) external {
        Expense storage expense = _expenses[expenseId];
        require(expense.status == ExpenseStatus.Voting, "Expense not voting");
        require(block.timestamp < expense.voteEnd, "Voting ended");
        require(reasonHash != bytes32(0), "Missing reason hash");
        require(
            categoryContribution[expense.categoryId][msg.sender] > 0,
            "Not a category donor"
        );
        require(!hasRaisedDispute[expenseId][msg.sender], "Already disputed");

        hasRaisedDispute[expenseId][msg.sender] = true;
        expense.disputeCount += 1;

        emit DisputeRaised(expenseId, msg.sender, reasonHash);
    }

    /**
     * @notice Finalizes an expense after its voting window.
     *
     * Requirements to approve:
     * 1. Participation quorum: enough distinct donors in that category voted.
     * 2. Approval ratio: enough of the votes cast were YES.
     */
    function finalizeExpense(uint256 expenseId) external {
        require(!closed, "Campaign closed");

        Expense storage expense = _expenses[expenseId];
        require(expense.status == ExpenseStatus.Voting, "Expense not voting");
        require(block.timestamp >= expense.voteEnd, "Voting still active");

        Category storage category = _categories[expense.categoryId];
        uint256 totalVotes = expense.yesVotes + expense.noVotes;

        bool quorumMet =
            totalVotes * BPS_DENOMINATOR >= category.donorCount * quorumBps;

        bool approvalMet =
            totalVotes > 0 &&
            expense.yesVotes * BPS_DENOMINATOR >= totalVotes * approvalBps;

        bool approved = quorumMet && approvalMet;

        if (approved) {
            expense.status = ExpenseStatus.Approved;
        } else {
            expense.status = ExpenseStatus.Rejected;
            category.reservedBalance -= expense.amount;
        }

        emit ExpenseFinalized(
            expenseId,
            approved,
            expense.yesVotes,
            expense.noVotes,
            quorumMet
        );
    }

    /**
     * @notice Anyone may execute an already approved payment. This prevents the charity from
     *         selectively delaying an expense after donors approved it.
     */
    function executeExpense(uint256 expenseId) external nonReentrant {
        require(!closed, "Campaign closed");
        require(block.timestamp <= campaignDeadline, "Campaign expired");

        Expense storage expense = _expenses[expenseId];
        require(expense.status == ExpenseStatus.Approved, "Expense not approved");

        Category storage category = _categories[expense.categoryId];
        require(category.reservedBalance >= expense.amount, "Funds not reserved");
        require(category.availableBalance >= expense.amount, "Insufficient funds");

        // Checks-effects-interactions
        expense.status = ExpenseStatus.Paid;
        category.reservedBalance -= expense.amount;
        category.availableBalance -= expense.amount;
        totalSpent += expense.amount;

        (bool success, ) = expense.recipient.call{value: expense.amount}("");
        require(success, "Payment failed");

        emit ExpensePaid(expenseId, expense.recipient, expense.amount);
    }

    /**
     * @notice Ends the campaign after its deadline and snapshots all remaining category balances
     *         for pro-rata donor refunds. Approved but unexecuted expenses expire here.
     */
    function closeCampaign() external {
        require(!closed, "Campaign already closed");
        require(block.timestamp > campaignDeadline, "Campaign still active");

        closed = true;
        uint256 totalRefundable;

        for (uint256 i = 0; i < _categoryIds.length; i++) {
            Category storage category = _categories[_categoryIds[i]];
            category.refundPool = category.availableBalance;
            category.reservedBalance = 0;
            totalRefundable += category.refundPool;
        }

        emit CampaignClosed(totalRefundable);
    }

    /**
     * @notice Returns a donor's proportional share of the leftover money in one category.
     */
    function claimRefund(bytes32 categoryId) external nonReentrant {
        require(closed, "Campaign not closed");

        Category storage category = _categories[categoryId];
        require(category.exists, "Unknown category");
        require(!refundClaimed[categoryId][msg.sender], "Refund already claimed");

        uint256 contribution = categoryContribution[categoryId][msg.sender];
        require(contribution > 0, "No contribution");

        refundClaimed[categoryId][msg.sender] = true;

        uint256 amount =
            (contribution * category.refundPool) / category.totalDonated;

        require(amount > 0, "Nothing refundable");
        category.availableBalance -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Refund failed");

        emit RefundClaimed(msg.sender, categoryId, amount);
    }

    function getCategory(bytes32 categoryId) external view returns (Category memory) {
        require(_categories[categoryId].exists, "Unknown category");
        return _categories[categoryId];
    }

    function getCategoryIds() external view returns (bytes32[] memory) {
        return _categoryIds;
    }

    function getExpense(uint256 expenseId) external view returns (Expense memory) {
        require(_expenses[expenseId].status != ExpenseStatus.None, "Unknown expense");
        return _expenses[expenseId];
    }

    receive() external payable {
        revert("Use donate");
    }
}
