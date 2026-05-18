// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title AgentPaymentVault
/// @notice A restricted payment vault that allows session-key-based agents to execute
///         limited payments on behalf of an owner. Assets stay in the vault at all times;
///         session keys can only instruct the vault to transfer within policy bounds.
contract AgentPaymentVault {
    // ── Errors ──────────────────────────────────────────────────────
    error NotOwner();
    error Paused();
    error NotPaused();
    error SessionNotFound();
    error SessionRevoked();
    error SessionExpired();
    error ExceedsPerTxLimit(uint256 amount, uint256 maxPerTx);
    error ExceedsTotalLimit(uint256 newSpent, uint256 maxTotal);
    error RecipientNotAllowed(address recipient);
    error TokenNotAllowed(address token);
    error SessionAlreadyExists();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error SelfCallNotAllowed();
    error CallFailed(bytes returnData);
    error ReentrancyGuard();
    error ValueExceedsPerTxLimit(uint256 value, uint256 maxPerTx);
    error SpenderNotConfigured(address spender);
    error RequiresHumanApproval(address spender);
    error ApproveAmountExceedsCap(uint256 amount, uint256 cap);
    error InsufficientOutput(uint256 actual, uint256 minRequired);

    // ── Events ──────────────────────────────────────────────────────
    event SessionKeyRegistered(address indexed sessionKey, uint256 expiry, uint256 maxTotal);
    event SessionKeyUpdated(address indexed sessionKey);
    event SessionKeyRevoked(address indexed sessionKey);
    event SessionKeyRotated(address indexed oldKey, address indexed newKey);
    event PaymentExecuted(
        address indexed sessionKey,
        address indexed token,
        address indexed recipient,
        uint256 amount
    );
    event WalletPaused(address indexed by);
    event WalletUnpaused(address indexed by);
    event FundsDeposited(address indexed token, uint256 amount);
    event FundsWithdrawn(address indexed token, address indexed to, uint256 amount);
    event ContractCallExecuted(
        address indexed sessionKey,
        address indexed target,
        bytes4 indexed selector,
        uint256 value,
        bool success
    );
    event AllowedTargetAdded(address indexed sessionKey, address indexed target);
    event AllowedTargetRemoved(address indexed sessionKey, address indexed target);
    event AllowedSelectorAdded(address indexed sessionKey, address indexed target, bytes4 selector);
    event AllowedSelectorRemoved(address indexed sessionKey, address indexed target, bytes4 selector);
    event SpenderRiskSet(address indexed sessionKey, address indexed spender, uint8 tier, uint256 amountCap);
    event TrustedSpenderSet(address indexed spender, bool trusted);
    event ApproveAndExecuted(
        address indexed sessionKey,
        address indexed spender,
        address indexed target,
        address token,
        uint256 approveAmount,
        uint8 riskTier
    );

    // ── Types ───────────────────────────────────────────────────────
    enum RiskTier { NONE, LOW, MEDIUM, HIGH }

    struct SessionPermission {
        uint256 maxPerTx;
        uint256 maxTotal;
        uint256 spent;
        uint256 expiry;
        address allowedRecipient;
        address allowedToken;
        bool exists;
        bool revoked;
    }

    // ── State ───────────────────────────────────────────────────────
    address public owner;
    bool public paused;
    mapping(address => SessionPermission) public sessions;
    address[] public sessionKeyList;

    // ── executeCall state ───────────────────────────────────────────
    /// @dev sessionKey => target => allowed
    mapping(address => mapping(address => bool)) public allowedTargets;
    /// @dev sessionKey => target => selector => allowed (address(0) target = global)
    mapping(address => mapping(address => mapping(bytes4 => bool))) public allowedSelectors;

    /// @dev Blacklisted selectors that can never be called (approve, setApprovalForAll)
    bytes4 private constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant SEL_APPROVE_FOR_ALL = bytes4(keccak256("setApprovalForAll(address,bool)"));
    bytes4 private constant SEL_INCREASE_ALLOWANCE = bytes4(keccak256("increaseAllowance(address,uint256)"));

    // ── approveAndExecute state ───────────────────────────────────
    /// @dev sessionKey => spender => risk tier
    mapping(address => mapping(address => RiskTier)) public spenderRiskTiers;
    /// @dev sessionKey => spender => max approve amount per call
    mapping(address => mapping(address => uint256)) public approveAmountCaps;
    /// @dev Globally trusted spenders (e.g. Uniswap Router) — applies to HIGH tier
    mapping(address => bool) public trustedSpenders;

    /// @dev Reentrancy lock
    uint256 private _locked = 1;

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert ReentrancyGuard();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor() {
        owner = msg.sender;
    }

    // ── Owner: Fund management ──────────────────────────────────────

    /// @notice Deposit ERC-20 tokens into the vault.
    function deposit(address token, uint256 amount) external {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit FundsDeposited(token, amount);
    }

    /// @notice Owner withdraws tokens from the vault.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "transfer failed");
        emit FundsWithdrawn(token, to, amount);
    }

    // ── Owner: Session key management ───────────────────────────────

    function registerSessionKey(
        address sessionKey,
        uint256 maxPerTx,
        uint256 maxTotal,
        uint256 expiry,
        address allowedRecipient,
        address allowedToken
    ) external onlyOwner {
        if (sessions[sessionKey].exists) revert SessionAlreadyExists();

        sessions[sessionKey] = SessionPermission({
            maxPerTx: maxPerTx,
            maxTotal: maxTotal,
            spent: 0,
            expiry: expiry,
            allowedRecipient: allowedRecipient,
            allowedToken: allowedToken,
            exists: true,
            revoked: false
        });
        sessionKeyList.push(sessionKey);

        emit SessionKeyRegistered(sessionKey, expiry, maxTotal);
    }

    function updateSessionKey(
        address sessionKey,
        uint256 maxPerTx,
        uint256 maxTotal,
        uint256 expiry,
        address allowedRecipient,
        address allowedToken
    ) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();

        perm.maxPerTx = maxPerTx;
        perm.maxTotal = maxTotal;
        perm.expiry = expiry;
        perm.allowedRecipient = allowedRecipient;
        perm.allowedToken = allowedToken;

        emit SessionKeyUpdated(sessionKey);
    }

    function revokeSessionKey(address sessionKey) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        perm.revoked = true;
        emit SessionKeyRevoked(sessionKey);
    }

    function rotateSessionKey(
        address oldKey,
        address newKey,
        uint256 maxPerTx,
        uint256 maxTotal,
        uint256 expiry,
        address allowedRecipient,
        address allowedToken
    ) external onlyOwner {
        // Revoke old
        SessionPermission storage oldPerm = sessions[oldKey];
        if (!oldPerm.exists) revert SessionNotFound();
        oldPerm.revoked = true;

        // Register new
        if (sessions[newKey].exists) revert SessionAlreadyExists();
        sessions[newKey] = SessionPermission({
            maxPerTx: maxPerTx,
            maxTotal: maxTotal,
            spent: 0,
            expiry: expiry,
            allowedRecipient: allowedRecipient,
            allowedToken: allowedToken,
            exists: true,
            revoked: false
        });
        sessionKeyList.push(newKey);

        emit SessionKeyRevoked(oldKey);
        emit SessionKeyRotated(oldKey, newKey);
        emit SessionKeyRegistered(newKey, expiry, maxTotal);
    }

    // ── Session key: Payment execution ──────────────────────────────

    /// @notice Execute a restricted payment. Called by the session key holder.
    function executePayment(
        address token,
        address recipient,
        uint256 amount
    ) external whenNotPaused {
        SessionPermission storage perm = sessions[msg.sender];
        if (!perm.exists) revert SessionNotFound();
        if (perm.revoked) revert SessionRevoked();
        if (block.timestamp >= perm.expiry) revert SessionExpired();
        if (amount > perm.maxPerTx) revert ExceedsPerTxLimit(amount, perm.maxPerTx);
        if (perm.spent + amount > perm.maxTotal) revert ExceedsTotalLimit(perm.spent + amount, perm.maxTotal);
        if (recipient != perm.allowedRecipient) revert RecipientNotAllowed(recipient);
        if (token != perm.allowedToken) revert TokenNotAllowed(token);

        perm.spent += amount;

        require(IERC20(token).transfer(recipient, amount), "transfer failed");

        emit PaymentExecuted(msg.sender, token, recipient, amount);
    }

    // ── Session key: Self-rotation ──────────────────────────────────

    /// @notice Session key holder rotates to a new key autonomously.
    ///         Cannot expand permissions: inherits spent, expiry, limits, whitelist.
    function selfRotate(address newKey) external whenNotPaused {
        SessionPermission storage oldPerm = sessions[msg.sender];
        if (!oldPerm.exists) revert SessionNotFound();
        if (oldPerm.revoked) revert SessionRevoked();
        if (block.timestamp >= oldPerm.expiry) revert SessionExpired();
        if (sessions[newKey].exists) revert SessionAlreadyExists();

        // New key inherits ALL constraints — cannot escalate
        sessions[newKey] = SessionPermission({
            maxPerTx: oldPerm.maxPerTx,
            maxTotal: oldPerm.maxTotal,
            spent: oldPerm.spent,              // inherit spent, no reset
            expiry: oldPerm.expiry,            // inherit expiry, no extension
            allowedRecipient: oldPerm.allowedRecipient,
            allowedToken: oldPerm.allowedToken,
            exists: true,
            revoked: false
        });
        sessionKeyList.push(newKey);

        // Revoke old key
        oldPerm.revoked = true;

        emit SessionKeyRevoked(msg.sender);
        emit SessionKeyRotated(msg.sender, newKey);
        emit SessionKeyRegistered(newKey, oldPerm.expiry, oldPerm.maxTotal);
    }

    // ── Owner: Target & selector whitelist management ─────────────

    /// @notice Add an allowed target contract for a session key.
    function addAllowedTarget(address sessionKey, address target) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        allowedTargets[sessionKey][target] = true;
        emit AllowedTargetAdded(sessionKey, target);
    }

    /// @notice Remove an allowed target contract for a session key.
    function removeAllowedTarget(address sessionKey, address target) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        allowedTargets[sessionKey][target] = false;
        emit AllowedTargetRemoved(sessionKey, target);
    }

    /// @notice Add an allowed function selector for a session key on a specific target.
    ///         Use target=address(0) for global selector whitelist.
    function addAllowedSelector(address sessionKey, address target, bytes4 selector) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        allowedSelectors[sessionKey][target][selector] = true;
        emit AllowedSelectorAdded(sessionKey, target, selector);
    }

    /// @notice Remove an allowed function selector.
    function removeAllowedSelector(address sessionKey, address target, bytes4 selector) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        allowedSelectors[sessionKey][target][selector] = false;
        emit AllowedSelectorRemoved(sessionKey, target, selector);
    }

    // ── Owner: Spender risk tier management ─────────────────────────

    /// @notice Set the risk tier and approve amount cap for a spender on a session key.
    ///         LOW = full approve, MEDIUM = transfer-first (no approve), HIGH = trusted-only or human approval.
    function setSpenderRisk(
        address sessionKey,
        address spender,
        RiskTier tier,
        uint256 amountCap
    ) external onlyOwner {
        SessionPermission storage perm = sessions[sessionKey];
        if (!perm.exists) revert SessionNotFound();
        spenderRiskTiers[sessionKey][spender] = tier;
        approveAmountCaps[sessionKey][spender] = amountCap;
        emit SpenderRiskSet(sessionKey, spender, uint8(tier), amountCap);
    }

    /// @notice Add or remove a globally trusted spender (e.g. Uniswap Router).
    ///         HIGH-tier spenders that are trusted get the same treatment as LOW.
    function setTrustedSpender(address spender, bool trusted) external onlyOwner {
        trustedSpenders[spender] = trusted;
        emit TrustedSpenderSet(spender, trusted);
    }

    // ── Session key: Approve-and-execute (three-tier risk model) ────

    /// @notice Execute a contract call that requires token approval.
    ///         Behavior depends on the spender's risk tier set by the owner:
    ///         - LOW:    approve(spender, amount) → call(target, data) — full trust
    ///         - MEDIUM: transfer(token, target, amount) → call(target, data) — zero approve risk
    ///         - HIGH:   if trustedSpender → same as LOW; else revert RequiresHumanApproval
    ///         - NONE:   revert SpenderNotConfigured
    function approveAndExecute(
        address token,
        address spender,
        uint256 approveAmount,
        address target,
        uint256 value,
        bytes calldata data,
        address outputToken,
        uint256 minOutput
    ) external whenNotPaused nonReentrant returns (bytes memory) {
        // Standard session key checks
        SessionPermission storage perm = sessions[msg.sender];
        if (!perm.exists) revert SessionNotFound();
        if (perm.revoked) revert SessionRevoked();
        if (block.timestamp >= perm.expiry) revert SessionExpired();
        if (target == address(this)) revert SelfCallNotAllowed();
        if (!allowedTargets[msg.sender][target]) revert TargetNotAllowed(target);

        // Value limit check
        if (value > perm.maxPerTx) revert ValueExceedsPerTxLimit(value, perm.maxPerTx);
        if (perm.spent + value > perm.maxTotal) revert ExceedsTotalLimit(perm.spent + value, perm.maxTotal);

        // Risk tier check
        RiskTier tier = spenderRiskTiers[msg.sender][spender];
        if (tier == RiskTier.NONE) revert SpenderNotConfigured(spender);

        // Approve amount cap check
        uint256 cap = approveAmountCaps[msg.sender][spender];
        if (approveAmount > cap) revert ApproveAmountExceedsCap(approveAmount, cap);

        bytes memory ret = _executeApproveStrategy(tier, token, spender, approveAmount, target, value, data, outputToken, minOutput);
        if (value > 0) perm.spent += value;
        return ret;
    }

    function _executeApproveStrategy(
        RiskTier tier,
        address token,
        address spender,
        uint256 approveAmount,
        address target,
        uint256 value,
        bytes calldata data,
        address outputToken,
        uint256 minOutput
    ) internal returns (bytes memory) {
        uint256 outputBefore = minOutput > 0 ? IERC20(outputToken).balanceOf(address(this)) : 0;

        bytes memory ret;
        if (tier == RiskTier.LOW) {
            IERC20(token).approve(spender, approveAmount);
            (bool ok, bytes memory r) = target.call{value: value}(data);
            if (!ok) revert CallFailed(r);
            ret = r;
        } else if (tier == RiskTier.MEDIUM) {
            require(IERC20(token).transfer(target, approveAmount), "transfer failed");
            (bool ok, bytes memory r) = target.call{value: value}(data);
            if (!ok) revert CallFailed(r);
            ret = r;
        } else if (trustedSpenders[spender]) {
            IERC20(token).approve(spender, approveAmount);
            (bool ok, bytes memory r) = target.call{value: value}(data);
            if (!ok) revert CallFailed(r);
            ret = r;
        } else {
            revert RequiresHumanApproval(spender);
        }

        _checkMinOutput(outputToken, outputBefore, minOutput);
        _emitApproveExecuted(msg.sender, spender, target, token, approveAmount, tier);
        return ret;
    }

    /// @notice Owner executes an approve-and-call after human review (for HIGH-tier untrusted spenders).
    function ownerApproveAndExecute(
        address token,
        address spender,
        uint256 approveAmount,
        address target,
        uint256 value,
        bytes calldata data,
        address outputToken,
        uint256 minOutput
    ) external onlyOwner whenNotPaused nonReentrant returns (bytes memory) {
        if (target == address(this)) revert SelfCallNotAllowed();
        bytes memory ret = _doApproveCall(token, spender, approveAmount, target, value, data, outputToken, minOutput);
        // Revoke remaining approval for safety
        IERC20(token).approve(spender, 0);
        _emitApproveExecuted(msg.sender, spender, target, token, approveAmount, RiskTier.HIGH);
        return ret;
    }

    function _doApproveCall(
        address token,
        address spender,
        uint256 approveAmount,
        address target,
        uint256 value,
        bytes calldata data,
        address outputToken,
        uint256 minOutput
    ) internal returns (bytes memory) {
        uint256 outputBefore = minOutput > 0 ? IERC20(outputToken).balanceOf(address(this)) : 0;
        IERC20(token).approve(spender, approveAmount);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        _checkMinOutput(outputToken, outputBefore, minOutput);
        return ret;
    }

    // ── Internal helpers ────────────────────────────────────────────

    function _checkMinOutput(address outputToken, uint256 outputBefore, uint256 minOutput) internal view {
        if (minOutput > 0) {
            uint256 outputAfter = IERC20(outputToken).balanceOf(address(this));
            if (outputAfter < outputBefore + minOutput) {
                revert InsufficientOutput(outputAfter - outputBefore, minOutput);
            }
        }
    }

    function _emitApproveExecuted(
        address sessionKey,
        address spender,
        address target,
        address token,
        uint256 approveAmount,
        RiskTier tier
    ) internal {
        emit ApproveAndExecuted(sessionKey, spender, target, token, approveAmount, uint8(tier));
    }

    // ── Session key: General contract execution ─────────────────────

    /// @notice Execute an arbitrary contract call from the vault.
    ///         Subject to target whitelist, selector whitelist, value limits,
    ///         dangerous-call blacklist, and reentrancy protection.
    /// @param target  The contract to call
    /// @param value   Native token (MON) value to send
    /// @param data    The calldata (selector + encoded args)
    function executeCall(
        address target,
        uint256 value,
        bytes calldata data
    ) external whenNotPaused nonReentrant returns (bytes memory) {
        SessionPermission storage perm = sessions[msg.sender];
        if (!perm.exists) revert SessionNotFound();
        if (perm.revoked) revert SessionRevoked();
        if (block.timestamp >= perm.expiry) revert SessionExpired();

        // Prevent self-calls (reentrancy / privilege escalation)
        if (target == address(this)) revert SelfCallNotAllowed();

        // Target whitelist check
        if (!allowedTargets[msg.sender][target]) revert TargetNotAllowed(target);

        // Value limit check (reuse maxPerTx / maxTotal for value)
        if (value > perm.maxPerTx) revert ValueExceedsPerTxLimit(value, perm.maxPerTx);
        if (perm.spent + value > perm.maxTotal) revert ExceedsTotalLimit(perm.spent + value, perm.maxTotal);

        // Selector-level checks (if data has at least 4 bytes)
        if (data.length >= 4) {
            bytes4 selector = bytes4(data[:4]);

            // Dangerous selector blacklist
            if (selector == SEL_APPROVE || selector == SEL_APPROVE_FOR_ALL || selector == SEL_INCREASE_ALLOWANCE) {
                revert SelectorNotAllowed(selector);
            }

            // Selector whitelist: if any selectors are whitelisted for this target or globally,
            // the call's selector must be in the whitelist
            bool hasTargetSelector = allowedSelectors[msg.sender][target][selector];
            bool hasGlobalSelector = allowedSelectors[msg.sender][address(0)][selector];
            // Only enforce if at least one selector has been whitelisted for this session key
            // (if no selectors whitelisted at all, allow any non-blacklisted selector)
            if (!hasTargetSelector && !hasGlobalSelector) {
                // Check if any selector has been explicitly set — we use a simple approach:
                // if neither target-specific nor global selector matches, and data exists, revert
                // only when the owner has explicitly set selectors for this target
                // For simplicity, always check: if selector not in whitelist, it's blocked
                // Owner must whitelist at least the selectors they want to allow
                revert SelectorNotAllowed(selector);
            }
        }

        // Track value spent
        if (value > 0) {
            perm.spent += value;
        }

        // Execute the call
        (bool success, bytes memory returnData) = target.call{value: value}(data);
        if (!success) revert CallFailed(returnData);

        emit ContractCallExecuted(msg.sender, target, data.length >= 4 ? bytes4(data[:4]) : bytes4(0), value, success);

        return returnData;
    }

    /// @notice Allow the vault to receive native MON for executeCall with value.
    receive() external payable {}

    // ── Owner: Emergency controls ───────────────────────────────────

    function pause() external onlyOwner {
        if (paused) revert Paused();
        paused = true;
        emit WalletPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit WalletUnpaused(msg.sender);
    }

    /// @notice Transfer vault ownership (used by VaultFactory after deployment).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }

    // ── View functions ──────────────────────────────────────────────

    function getSessionPermission(address sessionKey)
        external
        view
        returns (SessionPermission memory)
    {
        return sessions[sessionKey];
    }

    function getSessionKeyCount() external view returns (uint256) {
        return sessionKeyList.length;
    }

    function getVaultBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
