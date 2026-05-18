module agent_pay::agent_vault;

use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

const ENOT_OWNER: u64 = 1;
const EPAUSED: u64 = 2;
const ESESSION_EXISTS: u64 = 3;
const ESESSION_NOT_FOUND: u64 = 4;
const ESESSION_REVOKED: u64 = 5;
const ESESSION_EXPIRED: u64 = 6;
const EEXCEEDS_PER_TX: u64 = 7;
const EEXCEEDS_TOTAL: u64 = 8;
const ERECIPIENT_NOT_ALLOWED: u64 = 9;

public struct SessionPermission has copy, drop, store {
    max_per_tx: u64,
    max_total: u64,
    spent: u64,
    expiry_ms: u64,
    allowed_recipient: address,
    revoked: bool,
}

public struct AgentVault<phantom CoinType> has key {
    id: UID,
    owner: address,
    paused: bool,
    balance: Balance<CoinType>,
    sessions: Table<address, SessionPermission>,
}

public struct VaultCreated<phantom CoinType> has copy, drop {
    vault_id: ID,
    owner: address,
}

public struct SessionKeyRegistered has copy, drop {
    vault_id: ID,
    session_key: address,
    expiry_ms: u64,
    max_total: u64,
}

public struct SessionKeyRevoked has copy, drop {
    vault_id: ID,
    session_key: address,
}

public struct Deposited<phantom CoinType> has copy, drop {
    vault_id: ID,
    amount: u64,
}

public struct Withdrawn<phantom CoinType> has copy, drop {
    vault_id: ID,
    recipient: address,
    amount: u64,
}

public struct PaymentExecuted<phantom CoinType> has copy, drop {
    vault_id: ID,
    session_key: address,
    recipient: address,
    amount: u64,
}

public struct PauseChanged has copy, drop {
    vault_id: ID,
    paused: bool,
}

public fun create_vault<CoinType>(ctx: &mut tx_context::TxContext) {
    let owner = tx_context::sender(ctx);
    let vault = AgentVault<CoinType> {
        id: object::new(ctx),
        owner,
        paused: false,
        balance: balance::zero(),
        sessions: table::new(ctx),
    };

    let vault_id = object::id(&vault);
    event::emit(VaultCreated<CoinType> { vault_id, owner });
    transfer::share_object(vault);
}

public fun deposit<CoinType>(
    vault: &mut AgentVault<CoinType>,
    payment: Coin<CoinType>
) {
    assert!(!vault.paused, EPAUSED);

    let amount = coin::value(&payment);
    balance::join(&mut vault.balance, coin::into_balance(payment));
    event::emit(Deposited<CoinType> {
        vault_id: object::id(vault),
        amount,
    });
}

public fun withdraw<CoinType>(
    vault: &mut AgentVault<CoinType>,
    amount: u64,
    recipient: address,
    ctx: &mut tx_context::TxContext
) {
    assert_owner(vault, ctx);

    let payout = coin::from_balance(balance::split(&mut vault.balance, amount), ctx);
    transfer::public_transfer(payout, recipient);

    event::emit(Withdrawn<CoinType> {
        vault_id: object::id(vault),
        recipient,
        amount,
    });
}

public fun register_session_key<CoinType>(
    vault: &mut AgentVault<CoinType>,
    session_key: address,
    max_per_tx: u64,
    max_total: u64,
    expiry_ms: u64,
    allowed_recipient: address,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
) {
    assert_owner(vault, ctx);
    assert!(!table::contains(&vault.sessions, session_key), ESESSION_EXISTS);
    assert!(expiry_ms > clock::timestamp_ms(clock), ESESSION_EXPIRED);

    table::add(
        &mut vault.sessions,
        session_key,
        SessionPermission {
            max_per_tx,
            max_total,
            spent: 0,
            expiry_ms,
            allowed_recipient,
            revoked: false,
        },
    );

    event::emit(SessionKeyRegistered {
        vault_id: object::id(vault),
        session_key,
        expiry_ms,
        max_total,
    });
}

public fun revoke_session_key<CoinType>(
    vault: &mut AgentVault<CoinType>,
    session_key: address,
    ctx: &mut tx_context::TxContext
) {
    assert_owner(vault, ctx);
    assert!(table::contains(&vault.sessions, session_key), ESESSION_NOT_FOUND);

    let permission = table::borrow_mut(&mut vault.sessions, session_key);
    permission.revoked = true;

    event::emit(SessionKeyRevoked {
        vault_id: object::id(vault),
        session_key,
    });
}

public fun execute_payment<CoinType>(
    vault: &mut AgentVault<CoinType>,
    clock: &Clock,
    recipient: address,
    amount: u64,
    ctx: &mut tx_context::TxContext
) {
    assert!(!vault.paused, EPAUSED);

    let session_key = tx_context::sender(ctx);
    assert!(table::contains(&vault.sessions, session_key), ESESSION_NOT_FOUND);

    let permission = table::borrow_mut(&mut vault.sessions, session_key);
    assert!(!permission.revoked, ESESSION_REVOKED);
    assert!(clock::timestamp_ms(clock) < permission.expiry_ms, ESESSION_EXPIRED);
    assert!(amount <= permission.max_per_tx, EEXCEEDS_PER_TX);
    assert!(permission.spent + amount <= permission.max_total, EEXCEEDS_TOTAL);

    if (permission.allowed_recipient != @0x0) {
        assert!(recipient == permission.allowed_recipient, ERECIPIENT_NOT_ALLOWED);
    };

    permission.spent = permission.spent + amount;

    let payout = coin::from_balance(balance::split(&mut vault.balance, amount), ctx);
    transfer::public_transfer(payout, recipient);

    event::emit(PaymentExecuted<CoinType> {
        vault_id: object::id(vault),
        session_key,
        recipient,
        amount,
    });
}

public fun pause<CoinType>(
    vault: &mut AgentVault<CoinType>,
    ctx: &mut tx_context::TxContext
) {
    assert_owner(vault, ctx);
    vault.paused = true;
    event::emit(PauseChanged {
        vault_id: object::id(vault),
        paused: true,
    });
}

public fun unpause<CoinType>(
    vault: &mut AgentVault<CoinType>,
    ctx: &mut tx_context::TxContext
) {
    assert_owner(vault, ctx);
    vault.paused = false;
    event::emit(PauseChanged {
        vault_id: object::id(vault),
        paused: false,
    });
}

fun assert_owner<CoinType>(vault: &AgentVault<CoinType>, ctx: &tx_context::TxContext) {
    assert!(vault.owner == tx_context::sender(ctx), ENOT_OWNER);
}
