CREATE TABLE IF NOT EXISTS finance_conversations (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_turns (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_payments (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_payment_deliveries (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
