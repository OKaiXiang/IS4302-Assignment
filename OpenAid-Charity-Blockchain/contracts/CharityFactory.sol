// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {CharityRegistry} from "./CharityRegistry.sol";
import {CharityCampaign} from "./CharityCampaign.sol";

/**
 * @title CharityFactory
 * @notice Creates campaign contracts only for real-world charities approved by the registry.
 */
contract CharityFactory {
    CharityRegistry public immutable registry;

    address[] private _campaigns;
    mapping(address => address[]) private _campaignsByCharity;

    event CampaignCreated(
        address indexed campaign,
        address indexed charity,
        string title
    );

    constructor(address registryAddress) {
        require(registryAddress != address(0), "Invalid registry");
        registry = CharityRegistry(registryAddress);
    }

    function createCampaign(
        string calldata title,
        string calldata descriptionURI,
        uint256 fundingDeadline,
        uint256 campaignDeadline,
        uint256 votingPeriod,
        uint256 quorumBps,
        uint256 approvalBps,
        string[] calldata categoryNames
    ) external returns (address campaignAddress) {
        require(registry.isVerifiedCharity(msg.sender), "Charity not verified");

        CharityCampaign campaign = new CharityCampaign(
            address(registry),
            msg.sender,
            title,
            descriptionURI,
            fundingDeadline,
            campaignDeadline,
            votingPeriod,
            quorumBps,
            approvalBps,
            categoryNames
        );

        campaignAddress = address(campaign);
        _campaigns.push(campaignAddress);
        _campaignsByCharity[msg.sender].push(campaignAddress);

        emit CampaignCreated(campaignAddress, msg.sender, title);
    }

    function getCampaigns() external view returns (address[] memory) {
        return _campaigns;
    }

    function getCampaignsByCharity(
        address charity
    ) external view returns (address[] memory) {
        return _campaignsByCharity[charity];
    }

    function getCampaignCount() external view returns (uint256) {
        return _campaigns.length;
    }
}
