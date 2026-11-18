-- 0004: commitments belong to a strategy; per-instrument performance views.

set search_path = trading, public;

-- ---------------------------------------------------------------------------
-- Commitments per strategy
-- ---------------------------------------------------------------------------
-- Commitments are append-only, so existing global rows cannot be re-assigned.
-- At the time of this migration the table is empty in every environment.
do $$
begin
  if exists (select 1 from trading.commitments) then
    raise exception 'commitments already contain global rows; assign them to strategies manually before migrating';
  end if;
end $$;

alter table commitments add column strategy_id uuid not null references strategies(id) on delete restrict;

drop index if exists commitments_key_idx;
create index commitments_strategy_key_idx on commitments (strategy_id, key, effective_from desc);

create or replace function trading.guard_commitment_insert() returns trigger
language plpgsql as $$
begin
  if new.key <> 'other' and exists (
       select 1 from trading.commitments where strategy_id = new.strategy_id and key = new.key) then
    if new.supersedes_id is null then
      raise exception 'a commitment change must reference the row it supersedes' using errcode = 'P0001';
    end if;
    if not exists (
         select 1 from trading.commitments
         where id = new.supersedes_id and strategy_id = new.strategy_id and key = new.key) then
      raise exception 'a commitment can only supersede a row of the same strategy and key' using errcode = 'P0001';
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

drop view if exists v_current_commitments;
create view v_current_commitments as
select distinct on (strategy_id, key) *
from commitments
where effective_from <= now() and key <> 'other'
order by strategy_id, key, effective_from desc, created_at desc;

-- ---------------------------------------------------------------------------
-- Instrument performance
-- ---------------------------------------------------------------------------
-- Additive building block: one row per (symbol, agent). Everything is stored as
-- sums and counts so it can be rolled up exactly to symbol or strategy level.
create view v_instrument_agent_stats as
select
  t.symbol,
  t.agent_id,
  v.strategy_id,
  count(*)::int                                                                      as trades_total,
  count(*) filter (where t.status = 'open')::int                                     as open_trades,
  count(*) filter (where t.status = 'closed')::int                                   as closed_trades,
  count(*) filter (where t.status = 'closed' and t.net_pnl > 0)::int                 as wins,
  count(*) filter (where t.status = 'closed' and t.net_pnl < 0)::int                 as losses,
  count(*) filter (where t.status = 'closed' and t.direction = 'long')::int          as long_closed,
  count(*) filter (where t.status = 'closed' and t.direction = 'long' and t.net_pnl > 0)::int  as long_wins,
  count(*) filter (where t.status = 'closed' and t.direction = 'short')::int         as short_closed,
  count(*) filter (where t.status = 'closed' and t.direction = 'short' and t.net_pnl > 0)::int as short_wins,
  coalesce(sum(t.net_pnl) filter (where t.status = 'closed'), 0)                     as net_pnl,
  coalesce(sum(t.net_pnl) filter (where t.status = 'closed' and t.net_pnl > 0), 0)   as gross_profit,
  coalesce(-sum(t.net_pnl) filter (where t.status = 'closed' and t.net_pnl < 0), 0)  as gross_loss,
  coalesce(sum(t.commission + t.swap) filter (where t.status = 'closed'), 0)         as costs,
  coalesce(sum(t.unrealized_pnl) filter (where t.status = 'open'), 0)                as open_pnl,
  count(t.r_multiple) filter (where t.status = 'closed')::int                        as r_count,
  coalesce(sum(t.r_multiple) filter (where t.status = 'closed'), 0)                  as total_r,
  max(t.r_multiple) filter (where t.status = 'closed')                               as best_r,
  min(t.r_multiple) filter (where t.status = 'closed')                               as worst_r,
  coalesce(sum(extract(epoch from (t.closed_at - t.opened_at)) / 3600.0) filter (where t.status = 'closed'), 0) as hold_hours_sum,
  min(t.opened_at)                                                                   as first_trade_at,
  max(t.opened_at)                                                                   as last_trade_at
from trades t
join agents a on a.id = t.agent_id
join strategy_versions v on v.id = a.strategy_version_id
group by t.symbol, t.agent_id, v.strategy_id;

-- Maximum drawdown of the closed-trade P/L curve, per symbol (account currency).
create view v_instrument_drawdown as
select symbol, max(peak - cum) as max_drawdown
from (
  select symbol, cum,
         greatest(0, max(cum) over (partition by symbol order by closed_at, id rows unbounded preceding)) as peak
  from (
    select symbol, closed_at, id,
           sum(net_pnl) over (partition by symbol order by closed_at, id rows unbounded preceding) as cum
    from trades where status = 'closed'
  ) c
) p
group by symbol;

-- One row per symbol: every synced instrument plus any symbol that was traded.
create view v_instrument_stats as
with agg as (
  select symbol,
         sum(trades_total)::int as trades_total, sum(open_trades)::int as open_trades, sum(closed_trades)::int as closed_trades,
         sum(wins)::int as wins, sum(losses)::int as losses,
         sum(long_closed)::int as long_closed, sum(long_wins)::int as long_wins,
         sum(short_closed)::int as short_closed, sum(short_wins)::int as short_wins,
         sum(net_pnl) as net_pnl, sum(gross_profit) as gross_profit, sum(gross_loss) as gross_loss,
         sum(costs) as costs, sum(open_pnl) as open_pnl,
         sum(r_count)::int as r_count, sum(total_r) as total_r, max(best_r) as best_r, min(worst_r) as worst_r,
         sum(hold_hours_sum) as hold_hours_sum,
         count(distinct agent_id)::int as agents, count(distinct strategy_id)::int as strategies,
         min(first_trade_at) as first_trade_at, max(last_trade_at) as last_trade_at
  from v_instrument_agent_stats group by symbol
),
syms as (
  select distinct on (symbol) symbol, description, asset_class, currency_profit
  from instruments order by symbol, updated_at desc
)
select
  coalesce(s.symbol, a.symbol)              as symbol,
  s.description, s.asset_class, s.currency_profit,
  coalesce(a.trades_total, 0)               as trades_total,
  coalesce(a.open_trades, 0)                as open_trades,
  coalesce(a.closed_trades, 0)              as closed_trades,
  coalesce(a.wins, 0)                       as wins,
  coalesce(a.losses, 0)                     as losses,
  coalesce(a.long_closed, 0)                as long_closed,
  coalesce(a.long_wins, 0)                  as long_wins,
  coalesce(a.short_closed, 0)               as short_closed,
  coalesce(a.short_wins, 0)                 as short_wins,
  coalesce(a.net_pnl, 0)                    as net_pnl,
  coalesce(a.gross_profit, 0)               as gross_profit,
  coalesce(a.gross_loss, 0)                 as gross_loss,
  coalesce(a.costs, 0)                      as costs,
  coalesce(a.open_pnl, 0)                   as open_pnl,
  coalesce(a.r_count, 0)                    as r_count,
  coalesce(a.total_r, 0)                    as total_r,
  a.best_r, a.worst_r,
  coalesce(a.hold_hours_sum, 0)             as hold_hours_sum,
  coalesce(a.agents, 0)                     as agents,
  coalesce(a.strategies, 0)                 as strategies,
  a.first_trade_at, a.last_trade_at,
  coalesce(d.max_drawdown, 0)               as max_drawdown
from syms s
full join agg a on a.symbol = s.symbol
left join v_instrument_drawdown d on d.symbol = coalesce(s.symbol, a.symbol);
