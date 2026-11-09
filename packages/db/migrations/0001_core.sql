-- Trading 2.2 — core schema
-- Everything lives in the `trading` schema, which is NOT exposed through the
-- Supabase Data API. Applications connect with a direct Postgres connection.

create schema if not exists trading;
set search_path = trading, public;

create extension if not exists pgcrypto with schema public;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function trading.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Rejects any UPDATE/DELETE. Used for append-only tables.
create or replace function trading.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'table %.% is append-only (% not allowed)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- Settings, secrets, commands
-- ---------------------------------------------------------------------------

create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
create trigger app_settings_touch before update on app_settings
  for each row execute function trading.touch_updated_at();

-- Secrets are encrypted with an X25519 sealed box. The web app holds only the
-- public key (can write, cannot read); the worker holds the private key.
create table secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  ciphertext  text not null,
  last4       text not null,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz
);

-- Web -> worker command queue. The web app never calls MetaApi or LLM APIs.
create table commands (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'test_provider', 'deploy_account', 'undeploy_account', 'refresh_account',
                 'run_agent', 'close_trade', 'close_agent_positions', 'kill_agent',
                 'generate_brief', 'fetch_source', 'send_test_telegram', 'sync_instruments', 'review_trade')),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'queued' check (status in ('queued','running','done','error')),
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index commands_queue_idx on commands (created_at) where status = 'queued';

create or replace function trading.notify_command() returns trigger
language plpgsql as $$
begin
  perform pg_notify('trading_commands', new.id::text);
  return new;
end $$;
create trigger commands_notify after insert on commands
  for each row execute function trading.notify_command();

create table login_attempts (
  id            bigserial primary key,
  ip            text not null,
  attempted_at  timestamptz not null default now(),
  success       boolean not null
);
create index login_attempts_ip_idx on login_attempts (ip, attempted_at desc);

-- ---------------------------------------------------------------------------
-- Infrastructure: accounts, heartbeats, snapshots, system events
-- ---------------------------------------------------------------------------

create table mt_accounts (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  broker              text not null default 'Admirals',
  metaapi_account_id  text unique,
  login               text not null,
  server              text not null,
  platform            text not null default 'mt5' check (platform in ('mt4','mt5')),
  account_type        text not null default 'demo' check (account_type in ('demo','real')),
  currency            text,
  leverage            integer,
  margin_mode         text,
  status              text not null default 'pending' check (status in (
                        'pending','deploying','connected','disconnected','error','undeployed','archived')),
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (server, login)
);
create trigger mt_accounts_touch before update on mt_accounts
  for each row execute function trading.touch_updated_at();

create table connection_heartbeats (
  id                 bigserial primary key,
  mt_account_id      uuid not null references mt_accounts(id) on delete cascade,
  checked_at         timestamptz not null default now(),
  metaapi_state      text,
  broker_connected   boolean not null,
  latency_ms         integer,
  server_time        timestamptz,
  error              text
);
create index connection_heartbeats_idx on connection_heartbeats (mt_account_id, checked_at desc);

create table worker_heartbeats (
  instance_id   text primary key,
  started_at    timestamptz not null,
  beat_at       timestamptz not null default now(),
  version       text not null,
  info          jsonb not null default '{}'::jsonb
);

create table account_snapshots (
  id             bigserial primary key,
  mt_account_id  uuid not null references mt_accounts(id) on delete cascade,
  taken_at       timestamptz not null default now(),
  balance        numeric(18,2) not null,
  equity         numeric(18,2) not null,
  margin         numeric(18,2) not null,
  free_margin    numeric(18,2) not null,
  margin_level   numeric(12,2),
  currency       text not null
);
create index account_snapshots_idx on account_snapshots (mt_account_id, taken_at desc);

create table system_events (
  id             bigserial primary key,
  occurred_at    timestamptz not null default now(),
  level          text not null check (level in ('debug','info','warn','error','critical')),
  source         text not null,
  kind           text not null,
  message        text not null,
  agent_id       uuid,
  mt_account_id  uuid,
  context        jsonb not null default '{}'::jsonb
);
create index system_events_time_idx on system_events (occurred_at desc);
create index system_events_level_idx on system_events (level, occurred_at desc) where level in ('warn','error','critical');

-- ---------------------------------------------------------------------------
-- Market reference data
-- ---------------------------------------------------------------------------

create table instruments (
  id               uuid primary key default gen_random_uuid(),
  broker_server    text not null,
  symbol           text not null,
  description      text,
  asset_class      text,
  digits           integer not null,
  point            numeric(20,10) not null,
  contract_size    numeric(20,6),
  tick_size        numeric(20,10) not null,
  volume_min       numeric(12,4) not null,
  volume_max       numeric(12,4) not null,
  volume_step      numeric(12,4) not null,
  currency_base    text,
  currency_profit  text,
  currency_margin  text,
  swap_long        numeric(18,6),
  swap_short       numeric(18,6),
  trade_mode       text,
  filling_modes    jsonb,
  stops_level      integer,
  raw              jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  unique (broker_server, symbol)
);

create table spread_samples (
  id             bigserial primary key,
  broker_server  text not null,
  symbol         text not null,
  sampled_at     timestamptz not null default now(),
  bid            numeric(20,10) not null,
  ask            numeric(20,10) not null,
  spread_points  numeric(12,2) not null,
  context        text not null check (context in ('decision','entry','event_window','periodic')),
  ref_id         uuid
);
create index spread_samples_idx on spread_samples (broker_server, symbol, sampled_at desc);

create table candles_cache (
  broker_server  text not null,
  symbol         text not null,
  timeframe      text not null,
  open_time      timestamptz not null,
  open           numeric(20,10) not null,
  high           numeric(20,10) not null,
  low            numeric(20,10) not null,
  close          numeric(20,10) not null,
  tick_volume    bigint,
  primary key (broker_server, symbol, timeframe, open_time)
);

create table fx_rates (
  base        text not null,
  quote       text not null,
  rate        numeric(20,10) not null check (rate > 0),
  observed_at timestamptz not null default now(),
  primary key (base, quote)
);

-- ---------------------------------------------------------------------------
-- LLM providers, models, calls
-- ---------------------------------------------------------------------------

create table llm_providers (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('anthropic','minimax','openrouter','openai_compatible')),
  name              text not null unique,
  base_url          text,
  api_key_secret_id uuid references secrets(id) on delete set null,
  enabled           boolean not null default true,
  status            text not null default 'untested' check (status in ('untested','ok','error')),
  last_tested_at    timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger llm_providers_touch before update on llm_providers
  for each row execute function trading.touch_updated_at();

create table llm_models (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references llm_providers(id) on delete restrict,
  model_key                text not null,
  display_name             text not null,
  input_usd_per_mtok       numeric(12,4) not null check (input_usd_per_mtok >= 0),
  output_usd_per_mtok      numeric(12,4) not null check (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok  numeric(12,4) not null default 0 check (cache_read_usd_per_mtok >= 0),
  cache_write_usd_per_mtok numeric(12,4) not null default 0 check (cache_write_usd_per_mtok >= 0),
  max_output_tokens        integer not null default 8192 check (max_output_tokens > 0),
  enabled                  boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider_id, model_key)
);
create trigger llm_models_touch before update on llm_models
  for each row execute function trading.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Strategies, versions, success criteria
-- ---------------------------------------------------------------------------

create table strategies (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{2,8}$'),
  name        text not null,
  style       text not null check (style in ('swing','day','event','other')),
  description text not null default '',
  status      text not null default 'draft' check (status in ('draft','active','paused','retired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger strategies_touch before update on strategies
  for each row execute function trading.touch_updated_at();

create table strategy_versions (
  id             uuid primary key default gen_random_uuid(),
  strategy_id    uuid not null references strategies(id) on delete restrict,
  version        integer not null check (version > 0),
  rules_md       text not null,
  system_prompt  text not null,
  params         jsonb not null default '{}'::jsonb,
  timeframes     text[] not null default '{}',
  instruments    text[] not null default '{}',
  content_hash   text not null,
  change_note    text not null default '',
  created_at     timestamptz not null default now(),
  approved_at    timestamptz,
  unique (strategy_id, version)
);

-- An approved version is immutable: agents and decisions point at it.
create or replace function trading.guard_strategy_version() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.approved_at is not null then
      raise exception 'approved strategy version cannot be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.approved_at is not null then
    raise exception 'approved strategy version is immutable; create a new version' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger strategy_versions_guard before update or delete on strategy_versions
  for each row execute function trading.guard_strategy_version();

-- Criteria are written before results exist. Rows are immutable; a change is a
-- new row that only becomes effective 7 days later.
create table success_criteria (
  id                   uuid primary key default gen_random_uuid(),
  strategy_id          uuid not null references strategies(id) on delete restrict,
  min_period_days      integer not null check (min_period_days > 0),
  min_trades           integer not null check (min_trades > 0),
  min_expectancy_r     numeric(8,4) not null,
  max_drawdown_pct     numeric(6,2) not null check (max_drawdown_pct > 0 and max_drawdown_pct <= 100),
  min_profit_factor    numeric(8,4) not null check (min_profit_factor > 0),
  max_brier            numeric(6,4) check (max_brier is null or (max_brier > 0 and max_brier <= 1)),
  notes                text not null default '',
  rationale            text not null default '',
  created_at           timestamptz not null default now(),
  effective_from       timestamptz not null default now(),
  supersedes_id        uuid references success_criteria(id)
);
create index success_criteria_idx on success_criteria (strategy_id, effective_from desc);

create or replace function trading.guard_success_criteria_insert() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from trading.success_criteria where strategy_id = new.strategy_id) then
    if new.supersedes_id is null then
      raise exception 'criteria already exist for this strategy; a change must reference the row it supersedes'
        using errcode = 'P0001';
    end if;
    if length(trim(new.rationale)) < 10 then
      raise exception 'a criteria change requires a written rationale' using errcode = 'P0001';
    end if;
    if new.effective_from < now() + interval '7 days' then
      new.effective_from := now() + interval '7 days';
    end if;
  else
    new.effective_from := now();
  end if;
  return new;
end $$;
create trigger success_criteria_insert before insert on success_criteria
  for each row execute function trading.guard_success_criteria_insert();
create trigger success_criteria_immutable before update or delete on success_criteria
  for each row execute function trading.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Agents = strategy version x model x account (immutable triple)
-- ---------------------------------------------------------------------------

create sequence agent_magic_seq start 710001;

create table agents (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null unique check (code ~ '^[A-Z0-9]{3,6}$'),
  name                    text not null,
  strategy_version_id     uuid not null references strategy_versions(id) on delete restrict,
  model_id                uuid not null references llm_models(id) on delete restrict,
  mt_account_id           uuid not null references mt_accounts(id) on delete restrict,
  magic                   bigint not null unique default nextval('trading.agent_magic_seq'),
  allocated_capital       numeric(18,2) not null check (allocated_capital > 0),
  risk_per_trade_pct      numeric(5,2) not null check (risk_per_trade_pct > 0 and risk_per_trade_pct <= 5),
  max_open_positions      integer not null default 3 check (max_open_positions between 1 and 50),
  max_daily_loss_pct      numeric(5,2) not null default 3 check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 50),
  max_drawdown_pct        numeric(5,2) not null default 20 check (max_drawdown_pct > 0 and max_drawdown_pct <= 100),
  schedule_cron           text not null,
  instruments             text[] not null check (cardinality(instruments) > 0),
  temperature             numeric(3,2) not null default 0.2 check (temperature >= 0 and temperature <= 1),
  status                  text not null default 'draft' check (status in ('draft','active','paused','killed','archived')),
  status_reason           text,
  created_at              timestamptz not null default now(),
  activated_at            timestamptz,
  updated_at              timestamptz not null default now()
);
create unique index agents_unique_triple on agents (strategy_version_id, model_id, mt_account_id)
  where status <> 'archived';
create trigger agents_touch before update on agents
  for each row execute function trading.touch_updated_at();

-- The triple and the money settings define what the agent's results mean.
-- They cannot change once the agent has been activated: clone instead.
create or replace function trading.guard_agent_identity() returns trigger
language plpgsql as $$
begin
  if old.activated_at is not null and (
       new.strategy_version_id is distinct from old.strategy_version_id or
       new.model_id            is distinct from old.model_id or
       new.mt_account_id       is distinct from old.mt_account_id or
       new.magic               is distinct from old.magic or
       new.code                is distinct from old.code or
       new.allocated_capital   is distinct from old.allocated_capital) then
    raise exception 'agent identity (version, model, account, magic, capital) is frozen after activation; clone the agent'
      using errcode = 'P0001';
  end if;
  if old.status = 'killed' and new.status not in ('killed','archived') then
    raise exception 'a killed agent can only be archived; clone it to continue' using errcode = 'P0001';
  end if;
  if old.status = 'archived' and new.status <> 'archived' then
    raise exception 'an archived agent cannot be restored; clone it' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger agents_guard before update on agents
  for each row execute function trading.guard_agent_identity();

-- Activation requires an approved strategy version.
create or replace function trading.guard_agent_activation() returns trigger
language plpgsql as $$
declare v_approved timestamptz;
begin
  if new.status = 'active' then
    select approved_at into v_approved from trading.strategy_versions where id = new.strategy_version_id;
    if v_approved is null then
      raise exception 'agent can be activated only on an approved strategy version' using errcode = 'P0001';
    end if;
    if new.activated_at is null then
      new.activated_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger agents_activation before insert or update on agents
  for each row execute function trading.guard_agent_activation();

create table llm_calls (
  id                  uuid primary key default gen_random_uuid(),
  purpose             text not null check (purpose in ('decision','brief','review','test')),
  agent_id            uuid references agents(id) on delete set null,
  provider_id         uuid references llm_providers(id) on delete set null,
  model_id            uuid references llm_models(id) on delete set null,
  model_key           text not null,
  started_at          timestamptz not null,
  finished_at         timestamptz not null,
  latency_ms          integer not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_usd            numeric(14,6) not null default 0,
  status              text not null check (status in ('ok','error','timeout','invalid_output')),
  stop_reason         text,
  error               text,
  request             jsonb,
  response            jsonb
);
create index llm_calls_agent_idx on llm_calls (agent_id, started_at desc);
create index llm_calls_time_idx on llm_calls (started_at desc);
