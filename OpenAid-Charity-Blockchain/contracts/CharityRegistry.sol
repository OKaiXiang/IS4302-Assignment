// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title CharityRegistry
 * @notice Simple registry used by the prototype to decide which wallet addresses
 *         are allowed to create charity campaigns.
 *
 * The registry is intentionally centralized at this layer: an administrator
 * verifies real-world charity identities. Fund custody and spending approval are
 * handled by separate decentralized campaign contracts.
 */
contract CharityRegistry {
    address public admin;
    mapping(address => bool) private _verifiedCharities;
    // Increases whenever a verified charity loses verification.
    mapping(address => uint256) public revocationVersion;

    event CharityVerificationUpdated(address indexed charity, bool verified);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setVerifiedCharity(
        address charity,
        bool verified
    ) external onlyAdmin {
        require(charity != address(0), "Invalid charity");

        if (_verifiedCharities[charity] && !verified) {
            revocationVersion[charity] += 1;
        }

        _verifiedCharities[charity] = verified;

        emit CharityVerificationUpdated(charity, verified);
    }

    function isVerifiedCharity(address charity) external view returns (bool) {
        return _verifiedCharities[charity];
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin");
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }
}
