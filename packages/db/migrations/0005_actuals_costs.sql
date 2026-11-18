-- 0005: actual figures from TradingView, more frequent COT/FF polling, instrument cost data.

set search_path = trading, public;

-- Sources: ForexFactory hourly, COT every 3 hours, TradingView fills actuals.
update data_sources set expected_interval_minutes = 60  where code = 'forexfactory';
update data_sources set expected_interval_minutes = 360 where code = 'cftc_cot';
insert into data_sources (code, name, kind, feeds, expected_interval_minutes)
values ('tradingview', 'Wyniki danych makro (TradingView)', 'worker', '{economic_events}', 30)
on conflict (code) do nothing;

-- Latest quote, tick value and margin per instrument (filled by the worker's watchlist sampler).
alter table instruments
  add column last_bid          numeric(20,10),
  add column last_ask          numeric(20,10),
  add column tick_value        numeric(20,10),   -- account currency per tick per 1 lot (loss side)
  add column quote_at          timestamptz,
  add column margin_per_lot    numeric(18,2),    -- account currency, 1 lot buy at the last ask
  add column margin_checked_at timestamptz;

-- Spread statistics per instrument from periodic and decision-time samples.
create view v_spread_stats as
select broker_server, symbol,
       count(*) filter (where sampled_at > now() - interval '7 days')::int                                   as n_7d,
       percentile_cont(0.5) within group (order by spread_points) filter (where sampled_at > now() - interval '7 days') as median_7d,
       avg(spread_points) filter (where sampled_at > now() - interval '7 days')                               as avg_7d,
       percentile_cont(0.9) within group (order by spread_points) filter (where sampled_at > now() - interval '7 days') as p90_7d,
       min(spread_points) filter (where sampled_at > now() - interval '7 days')                               as min_7d,
       max(spread_points) filter (where sampled_at > now() - interval '7 days')                               as max_7d,
       count(*)::int                                                                                          as n_all,
       avg(spread_points)                                                                                     as avg_all,
       max(sampled_at)                                                                                        as last_at
from spread_samples
where context in ('periodic', 'decision')
group by broker_server, symbol;

-- Costs actually paid on closed trades, per symbol (account currency).
create view v_trade_costs as
select symbol,
       count(*)::int                                                     as closed_trades,
       sum(volume_initial)                                               as lots,
       sum(commission)                                                   as commission,
       sum(swap)                                                         as swap,
       case when sum(volume_initial) > 0 then sum(commission) / sum(volume_initial) end as commission_per_lot,
       avg(abs(slippage_points)) filter (where slippage_points is not null) as avg_abs_slippage_points,
       sum(extract(epoch from (closed_at - opened_at)) / 86400.0)        as days_held
from trades where status = 'closed'
group by symbol;
