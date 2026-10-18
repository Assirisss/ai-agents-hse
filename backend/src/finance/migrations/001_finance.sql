CREATE TABLE IF NOT EXISTS finance_profiles (
  id text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS finance_accounts (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_categories (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_operations (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_drafts (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_receipts (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_audit (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_watchlist (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_summaries (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_deliveries (profile_id text NOT NULL REFERENCES finance_profiles(id), id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(profile_id,id));
CREATE TABLE IF NOT EXISTS finance_telegram_links (
  profile_id text PRIMARY KEY REFERENCES finance_profiles(id),
  user_id text UNIQUE NOT NULL,
  chat_id text UNIQUE NOT NULL,
  linked_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_link_codes (code_hash text PRIMARY KEY, profile_id text UNIQUE NOT NULL REFERENCES finance_profiles(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS finance_telegram_updates (id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS finance_metadata (key text PRIMARY KEY, value jsonb NOT NULL);
