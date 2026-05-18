// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentRegistry
 * @notice Simplified ERC-8004 compatible Agent Identity + Reputation Registry.
 *
 * Three functions aligned with ERC-8004:
 *   1. Identity - register agents with on-chain metadata URI
 *   2. Reputation - give/read feedback (value + tags)
 *   3. Risk query - aggregated reputation for policy decisions
 *
 * Designed for inter-agent settlement trust on Monad.
 */
contract AgentRegistry {

    // -- Identity ----------------------------------------------------

    struct AgentIdentity {
        address owner;
        string  agentURI;          // ERC-8004: resolves to registration file
        address agentWallet;       // where agent receives payments
        bool    active;
        uint256 registeredAt;
    }

    uint256 public nextAgentId = 1;
    mapping(uint256 => AgentIdentity) public agents;
    mapping(address => uint256) public walletToAgent;  // reverse lookup

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event AgentDeactivated(uint256 indexed agentId);

    // -- Reputation --------------------------------------------------

    struct Feedback {
        address client;
        int128  value;             // signed score
        uint8   valueDecimals;     // 0-18
        string  tag1;              // e.g. "successRate", "responseTime"
        string  tag2;              // e.g. sub-category
        bool    revoked;
        uint256 timestamp;
    }

    // agentId -> feedbackIndex (1-based) -> Feedback
    mapping(uint256 => mapping(uint64 => Feedback)) public feedbacks;
    mapping(uint256 => uint64) public feedbackCount;

    // agentId -> client -> lastIndex
    mapping(uint256 => mapping(address => uint64)) public clientLastIndex;

    // agentId -> aggregated reputation cache
    struct ReputationSummary {
        int128  totalValue;
        uint64  count;
        uint8   decimals;
        uint256 lastUpdated;
    }
    mapping(uint256 => ReputationSummary) public reputationSummaries;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    // -- Risk thresholds ---------------------------------------------

    uint64 public constant MIN_FEEDBACK_FOR_RATING = 3;
    int128 public constant RISK_THRESHOLD = 40;

    // ================================================================
    //  Identity functions
    // ================================================================

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        agents[agentId] = AgentIdentity({
            owner: msg.sender,
            agentURI: agentURI,
            agentWallet: msg.sender,
            active: true,
            registeredAt: block.timestamp
        });
        walletToAgent[msg.sender] = agentId;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function registerWithWallet(string calldata agentURI, address wallet) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        agents[agentId] = AgentIdentity({
            owner: msg.sender,
            agentURI: agentURI,
            agentWallet: wallet,
            active: true,
            registeredAt: block.timestamp
        });
        walletToAgent[wallet] = agentId;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(agents[agentId].owner == msg.sender, "NotOwner");
        agents[agentId].agentURI = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function deactivate(uint256 agentId) external {
        require(agents[agentId].owner == msg.sender, "NotOwner");
        agents[agentId].active = false;
        emit AgentDeactivated(agentId);
    }

    function getAgent(uint256 agentId) external view returns (
        address owner_,
        string memory agentURI_,
        address agentWallet_,
        bool active_,
        uint256 registeredAt_
    ) {
        AgentIdentity storage a = agents[agentId];
        return (a.owner, a.agentURI, a.agentWallet, a.active, a.registeredAt);
    }

    function getAgentIdByWallet(address wallet) external view returns (uint256) {
        return walletToAgent[wallet];
    }

    // ================================================================
    //  Reputation functions (ERC-8004 Reputation Registry)
    // ================================================================

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2
    ) external {
        require(agents[agentId].active, "AgentNotActive");
        require(agents[agentId].owner != msg.sender, "CannotRateSelf");
        require(valueDecimals <= 18, "DecimalsTooHigh");

        uint64 idx = ++feedbackCount[agentId];
        feedbacks[agentId][idx] = Feedback({
            client: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            revoked: false,
            timestamp: block.timestamp
        });

        clientLastIndex[agentId][msg.sender] = idx;

        ReputationSummary storage s = reputationSummaries[agentId];
        s.totalValue += value;
        s.count++;
        s.decimals = valueDecimals;
        s.lastUpdated = block.timestamp;

        emit NewFeedback(agentId, msg.sender, idx, value, valueDecimals, tag1, tag2);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback storage f = feedbacks[agentId][feedbackIndex];
        require(f.client == msg.sender, "NotFeedbackOwner");
        require(!f.revoked, "AlreadyRevoked");

        f.revoked = true;

        ReputationSummary storage s = reputationSummaries[agentId];
        s.totalValue -= f.value;
        s.count--;
        s.lastUpdated = block.timestamp;

        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    // -- Read functions ----------------------------------------------

    function readFeedback(uint256 agentId, uint64 feedbackIndex) external view returns (
        address client,
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        bool isRevoked
    ) {
        Feedback storage f = feedbacks[agentId][feedbackIndex];
        return (f.client, f.value, f.valueDecimals, f.tag1, f.tag2, f.revoked);
    }

    function getSummary(uint256 agentId) external view returns (
        uint64 count,
        int128 summaryValue,
        uint8  summaryValueDecimals
    ) {
        ReputationSummary storage s = reputationSummaries[agentId];
        return (s.count, s.totalValue, s.decimals);
    }

    function getAverageScore(uint256 agentId) external view returns (int128) {
        ReputationSummary storage s = reputationSummaries[agentId];
        if (s.count < MIN_FEEDBACK_FOR_RATING) return -1;
        return s.totalValue / int128(int64(s.count));
    }

    // ================================================================
    //  Risk assessment
    // ================================================================

    enum RiskLevel { UNKNOWN, LOW, MEDIUM, HIGH }

    function assessRisk(uint256 agentId) external view returns (RiskLevel, int128 avgScore) {
        ReputationSummary storage s = reputationSummaries[agentId];
        if (s.count < MIN_FEEDBACK_FOR_RATING) {
            return (RiskLevel.UNKNOWN, int128(-1));
        }
        avgScore = s.totalValue / int128(int64(s.count));
        if (avgScore >= 70) return (RiskLevel.LOW, avgScore);
        if (avgScore >= RISK_THRESHOLD) return (RiskLevel.MEDIUM, avgScore);
        return (RiskLevel.HIGH, avgScore);
    }

    function isReputable(address wallet) external view returns (bool registered, RiskLevel risk, int128 score) {
        uint256 agentId = walletToAgent[wallet];
        if (agentId == 0) return (false, RiskLevel.UNKNOWN, int128(-1));

        registered = true;
        ReputationSummary storage s = reputationSummaries[agentId];
        if (s.count < MIN_FEEDBACK_FOR_RATING) {
            return (true, RiskLevel.UNKNOWN, int128(-1));
        }
        score = s.totalValue / int128(int64(s.count));
        if (score >= 70) risk = RiskLevel.LOW;
        else if (score >= RISK_THRESHOLD) risk = RiskLevel.MEDIUM;
        else risk = RiskLevel.HIGH;
    }
}
