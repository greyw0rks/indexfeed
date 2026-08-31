#![cfg(test)]

use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, vec, Env};

struct Fixture {
    env: Env,
    client: IndexFeedOracleClient<'static>,
    publisher: Address,
    admin: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IndexFeedOracle, ());
    let client = IndexFeedOracleClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let publisher = Address::generate(&env);
    client.initialize(&admin, &publisher);
    Fixture { env, client, publisher, admin }
}

fn hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

/// A two-name index whose weights sum to exactly 10_000 bps.
fn valid_constituents(env: &Env) -> Vec<Constituent> {
    vec![
        env,
        Constituent { symbol: symbol_short!("XLM"), weight_bps: 6_000 },
        Constituent { symbol: symbol_short!("USDC"), weight_bps: 4_000 },
    ]
}

#[test]
fn publishes_and_reads_back() {
    let f = setup();
    let level = 1_000i128 * 10_000_000; // 1000.0 at 7dp
    f.client.publish(&0, &level, &valid_constituents(&f.env), &hash(&f.env));

    assert_eq!(f.client.value(), level);
    assert_eq!(f.client.head(), 0);
    let latest = f.client.latest();
    assert_eq!(latest.epoch, 0);
    assert_eq!(latest.constituents.len(), 2);
    assert_eq!(latest.methodology_hash, hash(&f.env));
    assert_eq!(f.client.decimals(), VALUE_DECIMALS);
}

#[test]
fn reading_before_first_publish_is_no_data() {
    let f = setup();
    assert_eq!(f.client.try_value(), Err(Ok(Error::NoData)));
    assert_eq!(f.client.try_head(), Err(Ok(Error::NoData)));
}

#[test]
fn epochs_are_immutable_once_published() {
    let f = setup();
    let c = valid_constituents(&f.env);
    f.client.publish(&0, &1_000, &c, &hash(&f.env));

    // Republishing epoch 0 with a different value must be refused outright.
    assert_eq!(
        f.client.try_publish(&0, &9_999, &c, &hash(&f.env)),
        Err(Ok(Error::EpochOutOfOrder))
    );
    // Skipping ahead is refused too, so history has no gaps.
    assert_eq!(
        f.client.try_publish(&2, &1_100, &c, &hash(&f.env)),
        Err(Ok(Error::EpochOutOfOrder))
    );
    assert_eq!(f.client.value(), 1_000);
}

#[test]
fn history_is_queryable_after_supersede() {
    let f = setup();
    let c = valid_constituents(&f.env);
    f.client.publish(&0, &1_000, &c, &hash(&f.env));
    f.client.publish(&1, &1_250, &c, &hash(&f.env));

    assert_eq!(f.client.value(), 1_250);
    assert_eq!(f.client.at_epoch(&0).value, 1_000);
    assert_eq!(f.client.try_at_epoch(&5), Err(Ok(Error::EpochNotFound)));
}

#[test]
fn rejects_weights_that_do_not_sum_to_10000() {
    let f = setup();
    let under = vec![
        &f.env,
        Constituent { symbol: symbol_short!("XLM"), weight_bps: 5_000 },
    ];
    assert_eq!(
        f.client.try_publish(&0, &1_000, &under, &hash(&f.env)),
        Err(Ok(Error::WeightsNotNormalized))
    );
}

#[test]
fn rejects_empty_and_non_positive() {
    let f = setup();
    let empty: Vec<Constituent> = vec![&f.env];
    assert_eq!(
        f.client.try_publish(&0, &1_000, &empty, &hash(&f.env)),
        Err(Ok(Error::EmptyConstituents))
    );
    assert_eq!(
        f.client.try_publish(&0, &0, &valid_constituents(&f.env), &hash(&f.env)),
        Err(Ok(Error::NonPositiveValue))
    );
}

#[test]
fn double_initialize_is_refused() {
    let f = setup();
    assert_eq!(
        f.client.try_initialize(&f.admin, &f.publisher),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn publisher_key_can_be_rotated() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.set_publisher(&next);
    assert_eq!(f.client.publisher(), next);
}
