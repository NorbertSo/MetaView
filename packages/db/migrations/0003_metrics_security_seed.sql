set search_path = trading, public;

-- ---------------------------------------------------------------------------
-- Agent equity snapshots (virtual equity per agent, used for drawdown & kill)
-- ---------------------------------------------------------------------------

create table agent_equity_snapshots (
  id             bigserial primary key,
  agent_id       uuid not null references agents(id) on delete cascade,
  taken_at       timestamptz not null default now(),
  equity         numeric(18,2) not null,
  realized_pnl   numeric(18,2) not null,
  unrealized_pnl numeric(18,2) not null,
  open_risk      numeric(18,2) not null,
  open_positions integer not null
);
create index agent_equity_idx on agent_equity_snapshots (agent_id, taken_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Current virtual equity per agent: allocation + realized (incl. partial closes) + open unrealized.
create view v_agent_equity as
select
  a.id as agent_id,
  a.allocated_capital,
  coalesce(sum(t.net_pnl), 0)::numeric(18,2)                                         as realized_pnl,
  coalesce(sum(t.unrealized_pnl) filter (where t.status = 'open'), 0)::numeric(18,2) as unrealized_pnl,
  (a.allocated_capital + coalesce(sum(t.net_pnl), 0)
     + coalesce(sum(t.unrealized_pnl) filter (where t.status = 'open'), 0))::numeric(18,2) as equity,
  count(*) filter (where t.status = 'open')::int                                     as open_positions
from agents a
left join trades t on t.agent_id = a.id
group by a.id, a.allocated_capital;

create view v_agent_stats as
with closed as (
  select * from trades where status = 'closed'
),
per_agent as (
  select
    agent_id,
    count(*)::int                                             as closed_trades,
    count(*) filter (where net_pnl > 0)::int                  as wins,
    count(*) filter (where net_pnl < 0)::int                  as losses,
    avg(r_multiple)                                           as expectancy_r,
    coalesce(sum(net_pnl) filter (where net_pnl > 0), 0)      as gross_profit,
    coalesce(-sum(net_pnl) filter (where net_pnl < 0), 0)     as gross_loss,
    sum(commission + swap)                                    as costs,
    avg(extract(epoch from (closed_at - opened_at)) / 3600.0) as avg_hold_hours,
    min(opened_at)                                            as first_trade_at
  from closed group by agent_id
),
dd as (
  select agent_id, max(dd_pct) as max_drawdown_pct
  from (
    select agent_id,
           case when peak > 0 then (peak - equity) / peak * 100 else 0 end as dd_pct
    from (
      select agent_id, equity,
             max(equity) over (partition by agent_id order by taken_at rows unbounded preceding) as peak
      from agent_equity_snapshots
    ) s
  ) d group by agent_id
),
calib as (
  select agent_id,
         avg(power(probability - case when outcome_hit then 1 else 0 end, 2)) as brier,
         count(*)::int as calibrated_decisions
  from decisions
  where action in ('open_long','open_short') and outcome_hit is not null and probability is not null
  group by agent_id
),
llm as (
  select agent_id, sum(cost_usd) as llm_cost_usd, count(*)::int as llm_calls
  from llm_calls where agent_id is not null group by agent_id
)
select
  a.id as agent_id,
  coalesce(p.closed_trades, 0)                                          as closed_trades,
  coalesce(p.wins, 0)                                                   as wins,
  coalesce(p.losses, 0)                                                 as losses,
  case when coalesce(p.closed_trades,0) > 0 then p.wins::numeric / p.closed_trades end as win_rate,
  p.expectancy_r,
  p.gross_profit,
  p.gross_loss,
  case when p.gross_loss > 0 then p.gross_profit / p.gross_loss end    as profit_factor,
  p.costs,
  p.avg_hold_hours,
  p.first_trade_at,
  e.realized_pnl,
  e.unrealized_pnl,
  e.equity,
  e.open_positions,
  coalesce(dd.max_drawdown_pct, 0)                                      as max_drawdown_pct,
  c.brier,
  coalesce(c.calibrated_decisions, 0)                                   as calibrated_decisions,
  coalesce(l.llm_cost_usd, 0)                                           as llm_cost_usd,
  coalesce(l.llm_calls, 0)                                              as llm_calls
from agents a
left join per_agent p on p.agent_id = a.id
left join v_agent_equity e on e.agent_id = a.id
left join dd on dd.agent_id = a.id
left join calib c on c.agent_id = a.id
left join llm l on l.agent_id = a.id;

-- Criteria effective right now per strategy.
create view v_current_criteria as
select distinct on (strategy_id) *
from success_criteria
where effective_from <= now()
order by strategy_id, effective_from desc, created_at desc;

create view v_current_commitments as
select distinct on (key) *
from commitments
where effective_from <= now() and key <> 'other'
order by key, effective_from desc, created_at desc;

create view v_data_source_health as
select
  s.*,
  case
    when not s.enabled then 'disabled'
    when s.last_success_at is null then 'never'
    when s.expected_interval_minutes is not null
         and s.last_success_at < now() - make_interval(mins => s.expected_interval_minutes * 2) then 'stale'
    when s.last_error_at is not null and s.last_error_at > s.last_success_at then 'error'
    else 'ok'
  end as health
from data_sources s;

create view v_daily_agent_pnl as
select agent_id,
       (closed_at at time zone 'UTC')::date as day,
       count(*)::int as trades,
       sum(net_pnl) as net_pnl,
       sum(r_multiple) as total_r
from trades
where status = 'closed'
group by agent_id, (closed_at at time zone 'UTC')::date;

-- ---------------------------------------------------------------------------
-- Security: nothing in `trading` is reachable through the Supabase Data API.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'trading' loop
    execute format('alter table trading.%I enable row level security', r.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema trading from anon';
    execute 'revoke all on all tables in schema trading from anon';
    execute 'revoke all on all sequences in schema trading from anon';
    execute 'alter default privileges in schema trading revoke all on tables from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema trading from authenticated';
    execute 'revoke all on all tables in schema trading from authenticated';
    execute 'revoke all on all sequences in schema trading from authenticated';
    execute 'alter default privileges in schema trading revoke all on tables from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

insert into app_settings (key, value) values
  ('trading_enabled', 'false'::jsonb),
  ('telegram', '{"chat_id": null, "notify_trades": true, "notify_level": "warn"}'::jsonb),
  ('risk_global', '{"max_account_open_risk_pct": 10, "max_currency_exposure_pct": 6, "min_rr": 1.0, "max_spread_multiple": 3}'::jsonb),
  ('event_blackout', '{"minutes_before": 15, "minutes_after": 10, "importance": ["high"], "applies_to_styles": ["swing","day","other"]}'::jsonb),
  ('analyst', '{"model_id": null, "cron": "15 6,12 * * 1-5", "valid_hours": 12, "prompt_version": "analyst-v1"}'::jsonb),
  ('daily_report', '{"cron": "5 21 * * 1-5"}'::jsonb),
  ('retention_days', '{"heartbeats": 30, "spread_samples": 90, "llm_payloads": 120}'::jsonb);

insert into data_sources (code, name, kind, feeds, expected_interval_minutes) values
  ('metaapi',            'MetaApi (konto, ceny, pozycje)', 'worker', '{account,positions,prices}', 5),
  ('forexfactory',       'Kalendarz ForexFactory',         'worker', '{economic_events}',          360),
  ('cftc_cot',           'Raporty COT (CFTC)',              'worker', '{cot_reports}',              10080),
  ('apify',              'Apify (scrapery)',                'apify',  '{news,economic_events}',     null),
  ('claude_scheduled',   'Claude: zaplanowane zadania',     'claude', '{news,market_briefs}',       null),
  ('n8n',                'n8n',                             'n8n',    '{news,economic_events}',     null),
  ('manual',             'Wpisy ręczne',                    'manual', '{news,market_briefs,economic_events}', null);

with p as (
  insert into llm_providers (kind, name, base_url, enabled) values
    ('anthropic',  'Anthropic',  'https://api.anthropic.com',         true),
    ('minimax',    'MiniMax',    'https://api.minimax.io/anthropic',  true),
    ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1',      false)
  returning id, kind
)
insert into llm_models (provider_id, model_key, display_name, input_usd_per_mtok, output_usd_per_mtok,
                        cache_read_usd_per_mtok, cache_write_usd_per_mtok, max_output_tokens)
select p.id, m.model_key, m.display_name, m.i, m.o, m.cr, m.cw, m.mx
from p
join (values
  ('anthropic', 'claude-opus-5-5',     'Claude Opus 5.5',    4.00, 20.00, 0.20,  5.00, 16000),
  ('anthropic', 'claude-sonnet-5-5',   'Claude Sonnet 5.5',  2.00, 10.00, 0.20,  2.50, 16000),
  ('anthropic', 'claude-fable-5-2',    'Claude Fable 5.2',  10.00, 50.00, 0.25, 12.50, 16000),
  ('anthropic', 'claude-haiku-5-5',    'Claude Haiku 5.5',   1.00,  5.00, 0.10,  1.25, 8000),
  ('minimax',   'MiniMax-M3',          'MiniMax M3',         0.30,  1.20, 0.06,  0.00, 16000),
  ('minimax',   'MiniMax-M3.1-Flash',  'MiniMax M3.1 Flash', 0.15,  0.60, 0.015, 0.00, 16000)
) as m(kind, model_key, display_name, i, o, cr, cw, mx) on m.kind = p.kind;
