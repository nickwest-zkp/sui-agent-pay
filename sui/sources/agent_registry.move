module agent_pay::agent_registry;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::table::{Self, Table};

const EALREADY_REGISTERED: u64 = 1;
const EAGENT_NOT_FOUND: u64 = 2;
const ENOT_AGENT_OWNER: u64 = 3;
const ECANNOT_RATE_SELF: u64 = 4;
const ESCORE_TOO_HIGH: u64 = 5;

const UNKNOWN_RISK: u8 = 0;
const LOW_RISK: u8 = 1;
const MEDIUM_RISK: u8 = 2;
const HIGH_RISK: u8 = 3;

public struct AgentIdentity has copy, drop, store {
    owner: address,
    agent_uri: String,
    payment_address: address,
    active: bool,
    registered_at_ms: u64,
}

public struct ReputationSummary has copy, drop, store {
    total_score: u64,
    feedback_count: u64,
    last_updated_ms: u64,
}

public struct AgentRegistry has key {
    id: UID,
    next_agent_id: u64,
    agents: Table<u64, AgentIdentity>,
    wallet_to_agent: Table<address, u64>,
    reputation: Table<u64, ReputationSummary>,
}

public struct AgentRegistered has copy, drop {
    registry_id: ID,
    agent_id: u64,
    owner: address,
    payment_address: address,
}

public struct AgentDeactivated has copy, drop {
    registry_id: ID,
    agent_id: u64,
}

public struct FeedbackSubmitted has copy, drop {
    registry_id: ID,
    agent_id: u64,
    client: address,
    score: u64,
}

public fun create_registry(ctx: &mut tx_context::TxContext) {
    let registry = AgentRegistry {
        id: object::new(ctx),
        next_agent_id: 1,
        agents: table::new(ctx),
        wallet_to_agent: table::new(ctx),
        reputation: table::new(ctx),
    };

    transfer::share_object(registry);
}

public fun register_agent(
    registry: &mut AgentRegistry,
    agent_uri: String,
    payment_address: address,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
) {
    assert!(!table::contains(&registry.wallet_to_agent, payment_address), EALREADY_REGISTERED);

    let owner = tx_context::sender(ctx);
    let agent_id = registry.next_agent_id;
    registry.next_agent_id = agent_id + 1;

    table::add(
        &mut registry.agents,
        agent_id,
        AgentIdentity {
            owner,
            agent_uri,
            payment_address,
            active: true,
            registered_at_ms: clock::timestamp_ms(clock),
        },
    );

    table::add(
        &mut registry.wallet_to_agent,
        payment_address,
        agent_id,
    );

    table::add(
        &mut registry.reputation,
        agent_id,
        ReputationSummary {
            total_score: 0,
            feedback_count: 0,
            last_updated_ms: clock::timestamp_ms(clock),
        },
    );

    event::emit(AgentRegistered {
        registry_id: object::id(registry),
        agent_id,
        owner,
        payment_address,
    });
}

public fun deactivate_agent(
    registry: &mut AgentRegistry,
    agent_id: u64,
    ctx: &mut tx_context::TxContext
) {
    assert!(table::contains(&registry.agents, agent_id), EAGENT_NOT_FOUND);

    let agent = table::borrow_mut(&mut registry.agents, agent_id);
    assert!(agent.owner == tx_context::sender(ctx), ENOT_AGENT_OWNER);
    agent.active = false;

    event::emit(AgentDeactivated {
        registry_id: object::id(registry),
        agent_id,
    });
}

public fun give_feedback(
    registry: &mut AgentRegistry,
    agent_id: u64,
    score: u64,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
) {
    assert!(score <= 100, ESCORE_TOO_HIGH);
    assert!(table::contains(&registry.agents, agent_id), EAGENT_NOT_FOUND);

    let agent = table::borrow(&registry.agents, agent_id);
    let client = tx_context::sender(ctx);
    assert!(agent.owner != client, ECANNOT_RATE_SELF);

    let summary = table::borrow_mut(&mut registry.reputation, agent_id);
    summary.total_score = summary.total_score + score;
    summary.feedback_count = summary.feedback_count + 1;
    summary.last_updated_ms = clock::timestamp_ms(clock);

    event::emit(FeedbackSubmitted {
        registry_id: object::id(registry),
        agent_id,
        client,
        score,
    });
}

public fun risk_level(registry: &AgentRegistry, agent_id: u64): u8 {
    assert!(table::contains(&registry.reputation, agent_id), EAGENT_NOT_FOUND);
    let summary = table::borrow(&registry.reputation, agent_id);

    if (summary.feedback_count < 3) {
        return UNKNOWN_RISK
    };

    let avg_score = summary.total_score / summary.feedback_count;
    if (avg_score >= 70) {
        LOW_RISK
    } else if (avg_score >= 40) {
        MEDIUM_RISK
    } else {
        HIGH_RISK
    }
}
