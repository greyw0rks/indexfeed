#![no_std]
//! IndexFeed oracle — the on-chain source of truth for the index.
//!
//! Off-chain the aggregator prices constituents, applies the methodology, and
//! publishes one immutable `IndexUpdate` per rebalance epoch. This contract
//! stores those updates and serves them to any reader. A published epoch is
//! never edited; a bad update is superseded by publishing the next epoch.
//!
//! Value scaling: `value` is the index level in units of 1e-7 (7 decimals, the
//! Stellar convention), so an index level of 1000.0 is stored as 10_000_000_000.
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Symbol, Vec};

/// Index level decimals. Matches Stellar's 7dp convention.
pub const VALUE_DECIMALS: u32 = 7;

/// Weights are basis points and must sum to this on every update.
pub const TOTAL_WEIGHT_BPS: u32 = 10_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Constituent {
    /// Ticker as carried in the methodology, e.g. `XLM`.
    pub symbol: Symbol,
    /// Free-float-adjusted, cap-constrained weight in basis points.
    pub weight_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexUpdate {
    /// Monotonic rebalance epoch. Also the update's permanent identity.
    pub epoch: u32,
    /// Index level, scaled by 1e7.
    pub value: i128,
    pub constituents: Vec<Constituent>,
    /// Ledger timestamp at which this epoch was published.
    pub published_at: u64,
    /// Hash of the methodology version this update was computed under.
    pub methodology_hash: BytesN<32>,
}

#[contracttype]
enum DataKey {
    Admin,
    /// Key authorized to publish index updates.
    Publisher,
    /// Epoch number of the most recent update.
    Head,
    /// A published update, keyed by epoch. Write-once.
    Epoch(u32),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// No update has been published yet, so there is nothing to read.
    NoData = 3,
    /// Epoch must be exactly `head + 1`; gaps and rewrites are both rejected.
    EpochOutOfOrder = 4,
    /// Weights did not sum to 10_000 bps.
    WeightsNotNormalized = 5,
    EmptyConstituents = 6,
    NonPositiveValue = 7,
    /// The requested epoch was never published or has been culled.
    EpochNotFound = 8,
}

#[contract]
pub struct IndexFeedOracle;

#[contractimpl]
impl IndexFeedOracle {
    /// One-time setup. `admin` can rotate the publisher; `publisher` is the
    /// aggregator key that signs updates. They are deliberately separate so the
    /// hot publishing key can be replaced without touching governance.
    pub fn initialize(env: Env, admin: Address, publisher: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Publisher, &publisher);
        Ok(())
    }

    /// Publish the next rebalance epoch. Rejected unless `epoch == head + 1`,
    /// which makes every published epoch immutable by construction.
    pub fn publish(
        env: Env,
        epoch: u32,
        value: i128,
        constituents: Vec<Constituent>,
        methodology_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let publisher: Address = env
            .storage()
            .instance()
            .get(&DataKey::Publisher)
            .ok_or(Error::NotInitialized)?;
        publisher.require_auth();

        if constituents.is_empty() {
            return Err(Error::EmptyConstituents);
        }
        if value <= 0 {
            return Err(Error::NonPositiveValue);
        }

        let expected = Self::head_epoch(&env).map_or(0, |h| h + 1);
        if epoch != expected {
            return Err(Error::EpochOutOfOrder);
        }

        let mut sum_bps: u32 = 0;
        for c in constituents.iter() {
            sum_bps = sum_bps
                .checked_add(c.weight_bps)
                .ok_or(Error::WeightsNotNormalized)?;
        }
        if sum_bps != TOTAL_WEIGHT_BPS {
            return Err(Error::WeightsNotNormalized);
        }

        let update = IndexUpdate {
            epoch,
            value,
            constituents,
            published_at: env.ledger().timestamp(),
            methodology_hash,
        };
        env.storage().persistent().set(&DataKey::Epoch(epoch), &update);
        env.storage().instance().set(&DataKey::Head, &epoch);
        Ok(())
    }

    /// The current index level, scaled by 1e7.
    pub fn value(env: Env) -> Result<i128, Error> {
        Ok(Self::latest(env)?.value)
    }

    /// The full current update: level, constituents, weights, timestamp, hash.
    pub fn latest(env: Env) -> Result<IndexUpdate, Error> {
        let head = Self::head_epoch(&env).ok_or(Error::NoData)?;
        Self::at_epoch(env, head)
    }

    /// A historical update. Callers can audit any past rebalance.
    pub fn at_epoch(env: Env, epoch: u32) -> Result<IndexUpdate, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Epoch(epoch))
            .ok_or(Error::EpochNotFound)
    }

    /// Most recent published epoch, or `NoData` before the first publish.
    pub fn head(env: Env) -> Result<u32, Error> {
        Self::head_epoch(&env).ok_or(Error::NoData)
    }

    pub fn publisher(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Publisher)
            .ok_or(Error::NotInitialized)
    }

    /// Rotate the publishing key. Admin only.
    pub fn set_publisher(env: Env, publisher: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Publisher, &publisher);
        Ok(())
    }

    pub fn decimals(_env: Env) -> u32 {
        VALUE_DECIMALS
    }

    fn head_epoch(env: &Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::Head)
    }
}

mod test;
