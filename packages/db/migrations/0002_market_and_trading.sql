set search_path = trading, public;

-- ---------------------------------------------------------------------------
-- Data sources & ingest (Apify, n8n, Claude scheduled tasks, built-in fetchers)
-- ---------------------------------------------------------------------------

create table data_sources (
  id                         uuid primary key default gen_random_uuid(),
  code                       text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  name                       text not null,
  kind                       text not null check (kind in ('worker','apify','claude','n8n','manual')),
  feeds                      text[] not null default '{}',
  expected_interval_minutes  integer check (expected_interval_minutes is null or expected_interval_minutes > 0),
  enabled                    boolean not null default true,
  last_success_at            timestamptz,
  last_error_at              timestamptz,
  last_error                 text,
  created_at                 timestamptz not null default now()
);

create table ingest_tokens (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  source_id     uuid not null references data_sources(id) on delete cascade,
  token_hash    text not null unique,
  token_prefix  text not null,
  scopes        text[] not null check (cardinality(scopes) > 0),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table ingest_log (
  id               bigserial primary key,
  token_id         uuid references ingest_tokens(id) on delete set null,
  source_id        uuid references data_sources(id) on delete set null,
  feed             text not null,
  received_at      timestamptz not null default now(),
  status           text not null check (status in ('ok','partial','rejected','error')),
  accepted         integer not null default 0,
  rejected         integer not null default 0,
  error            text,
  idempotency_key  text,
  unique (source_id, feed, idempotency_key)
);
create index ingest_log_time_idx on ingest_log (received_at desc);

-- ---------------------------------------------------------------------------
-- Market context
-- ---------------------------------------------------------------------------

create table economic_events (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,
  source_event_id  text not null,
  scheduled_at     timestamptz not null,
  country          text,
  currency         text,
  title            text not null,
  importance       text not null check (importance in ('low','medium','high','holiday')),
  unit             text,
  forecast         numeric(20,6),
  previous         numeric(20,6),
  actual           numeric(20,6),
  forecast_raw     text,
  previous_raw     text,
  actual_raw       text,
  surprise         numeric(20,6) generated always as (actual - forecast) stored,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source, source_event_id)
);
create index economic_events_time_idx on economic_events (scheduled_at);
create index economic_events_ccy_idx on economic_events (currency, scheduled_at);
create trigger economic_events_touch before update on economic_events
  for each row execute function trading.touch_updated_at();

create table event_reactions (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references economic_events(id) on delete cascade,
  broker_server      text not null,
  symbol             text not null,
  price_before       numeric(20,10) not null,
  move_1m_points     numeric(14,2),
  move_5m_points     numeric(14,2),
  move_15m_points    numeric(14,2),
  move_60m_points    numeric(14,2),
  max_spread_points  numeric(12,2),
  computed_at        timestamptz not null default now(),
  unique (event_id, broker_server, symbol)
);

create table news_items (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,
  source_item_id   text not null,
  url              text,
  title            text not null,
  summary          text,
  published_at     timestamptz not null,
  instruments      text[] not null default '{}',
  tags             text[] not null default '{}',
  importance       smallint check (importance between 1 and 5),
  sentiment        numeric(4,3) check (sentiment between -1 and 1),
  ingested_via     text not null,
  created_at       timestamptz not null default now(),
  unique (source, source_item_id)
);
create index news_items_time_idx on news_items (published_at desc);
create index news_items_instruments_idx on news_items using gin (instruments);

create table cot_reports (
  id                    uuid primary key default gen_random_uuid(),
  report_date           date not null,
  market_code           text not null,
  market_name           text not null,
  open_interest         bigint,
  noncomm_long          bigint,
  noncomm_short         bigint,
  comm_long             bigint,
  comm_short            bigint,
  nonrept_long          bigint,
  nonrept_short         bigint,
  noncomm_net           bigint generated always as (noncomm_long - noncomm_short) stored,
  source                text not null,
  created_at            timestamptz not null default now(),
  unique (report_date, market_code)
);

create table market_briefs (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  valid_until     timestamptz not null,
  produced_by     text not null check (produced_by in ('analyst','claude_scheduled','manual','ingest')),
  llm_call_id     uuid references llm_calls(id) on delete set null,
  prompt_version  text,
  regime          text not null check (regime in ('risk_on','risk_off','mixed','unknown')),
  summary_md      text not null,
  central_banks   jsonb not null default '[]'::jsonb,
  calendar        jsonb not null default '[]'::jsonb,
  instruments     jsonb not null default '{}'::jsonb,
  source_refs     jsonb not null default '{}'::jsonb,
  confidence      numeric(4,3) check (confidence between 0 and 1),
  check (valid_until > created_at)
);
create index market_briefs_time_idx on market_briefs (created_at desc);
create trigger market_briefs_immutable before update or delete on market_briefs
  for each row execute function trading.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Agent runs, decisions, orders, trades
-- ---------------------------------------------------------------------------

create table agent_runs (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id) on delete restrict,
  trigger      text not null check (trigger in ('schedule','event','manual','position_check')),
  trigger_ref  text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','error','skipped')),
  skip_reason  text,
  error        text,
  llm_call_id  uuid references llm_calls(id) on delete set null
);
create index agent_runs_agent_idx on agent_runs (agent_id, started_at desc);
-- At most one running run per agent.
create unique index agent_runs_one_running on agent_runs (agent_id) where status = 'running';

create table trades (
  id                     uuid primary key default gen_random_uuid(),
  agent_id               uuid not null references agents(id) on delete restrict,
  mt_account_id          uuid not null references mt_accounts(id) on delete restrict,
  open_decision_id       uuid,
  position_id            text not null,
  symbol                 text not null,
  direction              text not null check (direction in ('long','short')),
  volume_initial         numeric(12,4) not null check (volume_initial > 0),
  volume_open            numeric(12,4) not null check (volume_open >= 0),
  requested_entry_price  numeric(20,10),
  entry_price            numeric(20,10) not null,
  slippage_points        numeric(12,2),
  initial_sl             numeric(20,10) not null,
  initial_tp             numeric(20,10),
  current_sl             numeric(20,10),
  current_tp             numeric(20,10),
  risk_amount            numeric(18,2) not null check (risk_amount > 0),
  risk_pct               numeric(6,3) not null,
  opened_at              timestamptz not null,
  closed_at              timestamptz,
  exit_price             numeric(20,10),
  exit_reason            text check (exit_reason in ('sl','tp','agent','kill_switch','manual','stop_out','unknown')),
  realized_gross_pnl     numeric(18,2) not null default 0,
  commission             numeric(18,2) not null default 0,
  swap                   numeric(18,2) not null default 0,
  unrealized_pnl         numeric(18,2) not null default 0,
  net_pnl                numeric(18,2) generated always as (realized_gross_pnl + commission + swap) stored,
  r_multiple             numeric(10,4),
  mae_price              numeric(20,10),
  mfe_price              numeric(20,10),
  status                 text not null default 'open' check (status in ('open','closed')),
  updated_at             timestamptz not null default now(),
  unique (mt_account_id, position_id),
  check (status = 'open' or closed_at is not null)
);
create index trades_agent_idx on trades (agent_id, opened_at desc);
create index trades_open_idx on trades (mt_account_id) where status = 'open';
create trigger trades_touch before update on trades
  for each row execute function trading.touch_updated_at();

create table decisions (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null references agent_runs(id) on delete restrict,
  agent_id             uuid not null references agents(id) on delete restrict,
  strategy_version_id  uuid not null references strategy_versions(id) on delete restrict,
  model_id             uuid not null references llm_models(id) on delete restrict,
  mt_account_id        uuid not null references mt_accounts(id) on delete restrict,
  decided_at           timestamptz not null default now(),
  symbol               text,
  action               text not null check (action in (
                         'open_long','open_short','modify_position','add','partial_close','close','hold','skip')),
  target_trade_id      uuid references trades(id) on delete restrict,
  probability          numeric(5,4) check (probability between 0 and 1),
  expected_r           numeric(8,3),
  entry_price          numeric(20,10),
  stop_loss            numeric(20,10),
  take_profit          numeric(20,10),
  close_fraction       numeric(5,4) check (close_fraction > 0 and close_fraction <= 1),
  volume               numeric(12,4),
  rationale            text not null,
  factors              text[] not null default '{}',
  context_snapshot     jsonb not null,
  brief_id             uuid references market_briefs(id) on delete set null,
  lessons_used         uuid[] not null default '{}',
  risk_check           jsonb,
  risk_passed          boolean,
  status               text not null check (status in (
                         'recorded','rejected_risk','submitted','executed','failed')),
  error                text,
  outcome_r            numeric(10,4),
  outcome_hit          boolean,
  outcome_at           timestamptz,
  check (action not in ('open_long','open_short','add') or (probability is not null and stop_loss is not null)),
  check (action not in ('modify_position','add','partial_close','close') or target_trade_id is not null),
  check (action <> 'partial_close' or close_fraction is not null),
  check (action in ('hold','skip') or symbol is not null)
);
create index decisions_agent_idx on decisions (agent_id, decided_at desc);
create index decisions_run_idx on decisions (run_id);

alter table trades add constraint trades_open_decision_fk
  foreign key (open_decision_id) references decisions(id) on delete restrict;

-- Decisions are append-only except for execution status and outcome.
create or replace function trading.guard_decision_update() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'decisions are append-only' using errcode = 'P0001';
  end if;
  if (new.run_id, new.agent_id, new.strategy_version_id, new.model_id, new.mt_account_id, new.decided_at,
      new.symbol, new.action, new.target_trade_id, new.probability, new.expected_r, new.entry_price,
      new.stop_loss, new.take_profit, new.close_fraction, new.rationale, new.factors,
      new.context_snapshot, new.brief_id, new.lessons_used)
     is distinct from
     (old.run_id, old.agent_id, old.strategy_version_id, old.model_id, old.mt_account_id, old.decided_at,
      old.symbol, old.action, old.target_trade_id, old.probability, old.expected_r, old.entry_price,
      old.stop_loss, old.take_profit, old.close_fraction, old.rationale, old.factors,
      old.context_snapshot, old.brief_id, old.lessons_used) then
    raise exception 'decision content is immutable; only status, execution and outcome fields may change'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger decisions_guard before update or delete on decisions
  for each row execute function trading.guard_decision_update();

-- Every decision must belong to the agent's own frozen triple.
create or replace function trading.guard_decision_attribution() returns trigger
language plpgsql as $$
declare a record;
begin
  select strategy_version_id, model_id, mt_account_id into a from trading.agents where id = new.agent_id;
  if a.strategy_version_id <> new.strategy_version_id or a.model_id <> new.model_id
     or a.mt_account_id <> new.mt_account_id then
    raise exception 'decision attribution does not match agent' using errcode = 'P0001';
  end if;
  if not exists (select 1 from trading.agent_runs r where r.id = new.run_id and r.agent_id = new.agent_id) then
    raise exception 'decision run belongs to a different agent' using errcode = 'P0001';
  end if;
  if new.target_trade_id is not null and not exists (
       select 1 from trading.trades t where t.id = new.target_trade_id and t.agent_id = new.agent_id) then
    raise exception 'decision targets a trade of a different agent' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger decisions_attribution before insert on decisions
  for each row execute function trading.guard_decision_attribution();

create table orders (
  id                  uuid primary key default gen_random_uuid(),
  decision_id         uuid references decisions(id) on delete restrict,
  agent_id            uuid references agents(id) on delete restrict,
  mt_account_id       uuid not null references mt_accounts(id) on delete restrict,
  client_id           text not null unique,
  magic               bigint,
  symbol              text not null,
  side                text check (side in ('buy','sell')),
  order_kind          text not null check (order_kind in ('market','modify','close','close_partial')),
  volume              numeric(12,4),
  requested_price     numeric(20,10),
  stop_loss           numeric(20,10),
  take_profit         numeric(20,10),
  position_id         text,
  status              text not null default 'pending' check (status in ('pending','accepted','rejected','error')),
  broker_order_id     text,
  retcode             text,
  error               text,
  initiated_by        text not null check (initiated_by in ('agent','kill_switch','manual','system')),
  created_at          timestamptz not null default now(),
  acked_at            timestamptz,
  latency_ms          integer
);
create index orders_agent_idx on orders (agent_id, created_at desc);

create table position_events (
  id           uuid primary key default gen_random_uuid(),
  trade_id     uuid not null references trades(id) on delete restrict,
  decision_id  uuid references decisions(id) on delete restrict,
  order_id     uuid references orders(id) on delete restrict,
  occurred_at  timestamptz not null default now(),
  kind         text not null check (kind in (
                 'open','modify_sl','modify_tp','add','partial_close','close','external_change')),
  old_value    jsonb,
  new_value    jsonb,
  volume       numeric(12,4),
  price        numeric(20,10),
  pnl          numeric(18,2),
  deal_id      text
);
create index position_events_trade_idx on position_events (trade_id, occurred_at);
create unique index position_events_deal_idx on position_events (trade_id, deal_id) where deal_id is not null;
create trigger position_events_immutable before update or delete on position_events
  for each row execute function trading.forbid_mutation();

create table reconciliation_issues (
  id             uuid primary key default gen_random_uuid(),
  mt_account_id  uuid not null references mt_accounts(id) on delete cascade,
  detected_at    timestamptz not null default now(),
  kind           text not null check (kind in ('unknown_position','missing_position','external_modification','volume_mismatch')),
  position_id    text,
  details        jsonb not null default '{}'::jsonb,
  resolved_at    timestamptz,
  resolution     text
);
create unique index reconciliation_open_idx on reconciliation_issues (mt_account_id, kind, position_id)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Reviews and lessons
-- ---------------------------------------------------------------------------

create table trade_reviews (
  id               uuid primary key default gen_random_uuid(),
  trade_id         uuid not null unique references trades(id) on delete restrict,
  agent_id         uuid not null references agents(id) on delete restrict,
  llm_call_id      uuid references llm_calls(id) on delete set null,
  created_at       timestamptz not null default now(),
  thesis_held      boolean,
  process_quality  smallint check (process_quality between 1 and 5),
  what_worked      text not null default '',
  what_failed      text not null default '',
  lesson_candidate text,
  tags             text[] not null default '{}'
);

create table lessons (
  id                     uuid primary key default gen_random_uuid(),
  strategy_id            uuid not null references strategies(id) on delete restrict,
  body                   text not null,
  tags                   text[] not null default '{}',
  supporting_review_ids  uuid[] not null default '{}',
  status                 text not null default 'candidate' check (status in ('candidate','approved','rejected','retired')),
  min_support            integer not null default 5 check (min_support > 0),
  decided_at             timestamptz,
  decided_note           text,
  created_at             timestamptz not null default now(),
  check (status <> 'approved' or cardinality(supporting_review_ids) >= min_support)
);
create index lessons_strategy_idx on lessons (strategy_id, status);

create table review_sessions (
  id             uuid primary key default gen_random_uuid(),
  strategy_id    uuid not null references strategies(id) on delete restrict,
  agent_id       uuid references agents(id) on delete restrict,
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  trades_count   integer not null,
  metrics        jsonb not null,
  decisions_md   text not null,
  created_at     timestamptz not null default now(),
  check (period_end > period_start)
);

-- ---------------------------------------------------------------------------
-- The trader: journal, overrides, ideas, commitments
-- ---------------------------------------------------------------------------

create table journal_entries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('observation','idea','decision','urge_to_intervene','note')),
  body        text not null check (length(trim(body)) > 0),
  mood        smallint check (mood between 1 and 5),
  agent_id    uuid references agents(id) on delete set null,
  trade_id    uuid references trades(id) on delete set null,
  via         text not null default 'dashboard' check (via in ('dashboard','telegram','api'))
);
create index journal_time_idx on journal_entries (created_at desc);

create table manual_overrides (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in (
                'pause_agent','resume_agent','kill_agent','close_trade','close_agent_positions',
                'global_kill_switch','global_resume','change_criteria','change_commitment','other')),
  agent_id    uuid references agents(id) on delete set null,
  trade_id    uuid references trades(id) on delete set null,
  reason      text not null check (length(trim(reason)) >= 3),
  equity_at   numeric(18,2),
  details     jsonb not null default '{}'::jsonb,
  via         text not null default 'dashboard' check (via in ('dashboard','telegram'))
);
create index overrides_time_idx on manual_overrides (created_at desc);
create trigger manual_overrides_immutable before update or delete on manual_overrides
  for each row execute function trading.forbid_mutation();

create table strategy_ideas (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  title       text not null,
  body        text not null default '',
  source      text not null default '',
  status      text not null default 'queued' check (status in ('queued','promoted','dropped')),
  decided_at  timestamptz
);

create table commitments (
  id              uuid primary key default gen_random_uuid(),
  key             text not null check (key in (
                    'max_real_capital','real_account_conditions','project_end_condition','project_end_date','other')),
  label           text not null,
  value           text not null check (length(trim(value)) > 0),
  rationale       text not null default '',
  created_at      timestamptz not null default now(),
  effective_from  timestamptz not null default now(),
  supersedes_id   uuid references commitments(id)
);
create index commitments_key_idx on commitments (key, effective_from desc);

create or replace function trading.guard_commitment_insert() returns trigger
language plpgsql as $$
begin
  if new.key <> 'other' and exists (select 1 from trading.commitments where key = new.key) then
    if new.supersedes_id is null then
      raise exception 'a commitment change must reference the row it supersedes' using errcode = 'P0001';
    end if;
    if length(trim(new.rationale)) < 10 then
      raise exception 'a commitment change requires a written rationale' using errcode = 'P0001';
    end if;
    if new.effective_from < now() + interval '7 days' then
      new.effective_from := now() + interval '7 days';
    end if;
  else
    new.effective_from := now();
  end if;
  return new;
end $$;
create trigger commitments_insert before insert on commitments
  for each row execute function trading.guard_commitment_insert();
create trigger commitments_immutable before update or delete on commitments
  for each row execute function trading.forbid_mutation();
