-- Integration test for database invariants. Runs inside a transaction and rolls back.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/tests/invariants.sql
begin;
set search_path = trading, public;

create or replace function pg_temp.expect_error(stmt text, fragment text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if position(fragment in sqlerrm) = 0 then
      raise exception 'expected error containing "%", got "%"', fragment, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected error containing "%", but statement succeeded: %', fragment, stmt;
end $$;

-- fixtures
insert into strategies (id, code, name, style) values ('00000000-0000-0000-0000-000000000001', 'EVT1', 'Event', 'event');
insert into strategy_versions (id, strategy_id, version, rules_md, system_prompt, content_hash)
  values ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1, 'rules', 'prompt', 'h1');
insert into mt_accounts (id, name, login, server) values ('00000000-0000-0000-0000-000000000021', 'Demo', '123', 'AdmiralsGroup-Demo');

-- agent cannot be activated on an unapproved version
select pg_temp.expect_error($$
  insert into agents (code, name, strategy_version_id, model_id, mt_account_id, allocated_capital, risk_per_trade_pct, schedule_cron, instruments, status)
  select 'A01', 'x', '00000000-0000-0000-0000-000000000011', id, '00000000-0000-0000-0000-000000000021', 10000, 1, '*/15 * * * *', '{EURUSD}', 'active'
  from llm_models limit 1 $$, 'approved strategy version');

update strategy_versions set approved_at = now() where id = '00000000-0000-0000-0000-000000000011';
select pg_temp.expect_error($$ update strategy_versions set rules_md = 'changed' where id = '00000000-0000-0000-0000-000000000011' $$, 'immutable');
select pg_temp.expect_error($$ delete from strategy_versions where id = '00000000-0000-0000-0000-000000000011' $$, 'cannot be deleted');

insert into agents (id, code, name, strategy_version_id, model_id, mt_account_id, allocated_capital, risk_per_trade_pct, schedule_cron, instruments, status)
  select '00000000-0000-0000-0000-000000000031', 'A01', 'Agent 1', '00000000-0000-0000-0000-000000000011', id,
         '00000000-0000-0000-0000-000000000021', 10000, 1, '*/15 * * * *', '{EURUSD}', 'active'
  from llm_models where model_key = 'claude-sonnet-5-5';

do $$ begin
  if (select activated_at from trading.agents where code = 'A01') is null then
    raise exception 'activated_at should be set on activation';
  end if;
  if (select magic from trading.agents where code = 'A01') < 710001 then
    raise exception 'magic should come from sequence';
  end if;
end $$;

-- identity frozen after activation
select pg_temp.expect_error($$ update agents set allocated_capital = 5000 where code = 'A01' $$, 'frozen');
select pg_temp.expect_error($$ update agents set model_id = (select id from llm_models where model_key = 'claude-opus-5-5') where code = 'A01' $$, 'frozen');
-- duplicate active triple rejected
select pg_temp.expect_error($$
  insert into agents (code, name, strategy_version_id, model_id, mt_account_id, allocated_capital, risk_per_trade_pct, schedule_cron, instruments)
  select 'A02', 'dup', strategy_version_id, model_id, mt_account_id, 10000, 1, '*/15 * * * *', '{EURUSD}' from agents where code = 'A01' $$, 'agents_unique_triple');

-- kill is terminal
update agents set status = 'paused' where code = 'A01';
update agents set status = 'active' where code = 'A01';

-- second agent on another model, used for attribution tests
insert into agents (id, code, name, strategy_version_id, model_id, mt_account_id, allocated_capital, risk_per_trade_pct, schedule_cron, instruments, status)
  select '00000000-0000-0000-0000-000000000032', 'A02', 'Agent 2', '00000000-0000-0000-0000-000000000011', id,
         '00000000-0000-0000-0000-000000000021', 10000, 1, '*/15 * * * *', '{EURUSD}', 'active'
  from llm_models where model_key = 'MiniMax-M3';

insert into agent_runs (id, agent_id, trigger) values ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000031', 'manual');
-- only one running run per agent
select pg_temp.expect_error($$ insert into agent_runs (agent_id, trigger) values ('00000000-0000-0000-0000-000000000031', 'manual') $$, 'agent_runs_one_running');

-- decision attributed to the wrong model is rejected
select pg_temp.expect_error($$
  insert into decisions (run_id, agent_id, strategy_version_id, model_id, mt_account_id, action, rationale, context_snapshot, status)
  values ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000011',
          (select id from llm_models where model_key = 'MiniMax-M3'), '00000000-0000-0000-0000-000000000021', 'skip', 'x', '{}', 'recorded') $$,
  'attribution');
-- decision with a run of another agent is rejected
insert into agent_runs (id, agent_id, trigger) values ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-000000000032', 'manual');
select pg_temp.expect_error($$
  insert into decisions (run_id, agent_id, strategy_version_id, model_id, mt_account_id, action, rationale, context_snapshot, status)
  select '00000000-0000-0000-0000-000000000042', id, strategy_version_id, model_id, mt_account_id, 'skip', 'x', '{}', 'recorded'
  from agents where code = 'A01' $$, 'different agent');
-- open without probability or stop is rejected
select pg_temp.expect_error($$
  insert into decisions (run_id, agent_id, strategy_version_id, model_id, mt_account_id, symbol, action, rationale, context_snapshot, status)
  select '00000000-0000-0000-0000-000000000041', id, strategy_version_id, model_id, mt_account_id, 'EURUSD', 'open_long', 'x', '{}', 'recorded'
  from agents where code = 'A01' $$, 'decisions_check');

insert into decisions (id, run_id, agent_id, strategy_version_id, model_id, mt_account_id, symbol, action, probability, stop_loss, rationale, context_snapshot, status)
  select '00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000041', id, strategy_version_id, model_id, mt_account_id,
         'EURUSD', 'open_long', 0.6, 1.08, 'thesis', '{}', 'recorded'
  from agents where code = 'A01';
update decisions set status = 'executed', volume = 0.1 where id = '00000000-0000-0000-0000-000000000051';
select pg_temp.expect_error($$ update decisions set rationale = 'rewritten' where id = '00000000-0000-0000-0000-000000000051' $$, 'immutable');
select pg_temp.expect_error($$ delete from decisions where id = '00000000-0000-0000-0000-000000000051' $$, 'append-only');

-- trades & equity view
insert into trades (agent_id, mt_account_id, open_decision_id, position_id, symbol, direction, volume_initial, volume_open,
                    entry_price, initial_sl, risk_amount, risk_pct, opened_at, closed_at, status, realized_gross_pnl, commission, swap, r_multiple, exit_reason)
  values ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000051',
          'P1', 'EURUSD', 'long', 0.1, 0, 1.09, 1.08, 100, 1, now() - interval '2 hours', now(), 'closed', 210, -7, -3, 2.0, 'tp');
do $$ declare e numeric; begin
  select equity into e from trading.v_agent_equity where agent_id = '00000000-0000-0000-0000-000000000031';
  if e <> 10200 then raise exception 'equity should be 10200, got %', e; end if;
end $$;

-- trade closed without closed_at rejected
select pg_temp.expect_error($$
  insert into trades (agent_id, mt_account_id, position_id, symbol, direction, volume_initial, volume_open, entry_price, initial_sl, risk_amount, risk_pct, opened_at, status)
  values ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000021', 'P2', 'EURUSD', 'long', 0.1, 0, 1.09, 1.08, 100, 1, now(), 'closed') $$, 'trades_check');

-- success criteria: first row effective now, change requires rationale and is delayed 7 days
insert into success_criteria (id, strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor)
  values ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000001', 90, 100, 0.05, 20, 1.2);
select pg_temp.expect_error($$
  insert into success_criteria (strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor)
  values ('00000000-0000-0000-0000-000000000001', 30, 10, 0, 50, 1) $$, 'supersedes');
select pg_temp.expect_error($$
  insert into success_criteria (strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor, supersedes_id)
  values ('00000000-0000-0000-0000-000000000001', 30, 10, 0, 50, 1, '00000000-0000-0000-0000-000000000061') $$, 'rationale');
insert into success_criteria (strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor, supersedes_id, rationale, effective_from)
  values ('00000000-0000-0000-0000-000000000001', 60, 50, 0, 25, 1.1, '00000000-0000-0000-0000-000000000061', 'more realistic sample size', now());
do $$ begin
  if (select min_trades from trading.v_current_criteria where strategy_id = '00000000-0000-0000-0000-000000000001') <> 100 then
    raise exception 'criteria change must not take effect immediately';
  end if;
end $$;
select pg_temp.expect_error($$ update success_criteria set min_trades = 1 $$, 'append-only');

-- commitments behave the same way
insert into commitments (id, key, label, value) values ('00000000-0000-0000-0000-000000000071', 'max_real_capital', 'Maks. kapitał', '2000 PLN');
select pg_temp.expect_error($$ insert into commitments (key, label, value) values ('max_real_capital', 'x', '50000 PLN') $$, 'supersedes');
select pg_temp.expect_error($$ delete from commitments $$, 'append-only');

-- lessons cannot be approved without enough support
select pg_temp.expect_error($$
  insert into lessons (strategy_id, body, status) values ('00000000-0000-0000-0000-000000000001', 'noise', 'approved') $$, 'lessons_check');

-- killed agent is terminal
update agents set status = 'killed' where code = 'A02';
select pg_temp.expect_error($$ update agents set status = 'paused' where code = 'A02' $$, 'only be archived');

-- manual overrides are append-only and require a reason
select pg_temp.expect_error($$ insert into manual_overrides (kind, reason) values ('other', '') $$, 'manual_overrides_reason_check');

-- RLS enabled everywhere
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'trading' and not rowsecurity) then
    raise exception 'RLS disabled on some trading table';
  end if;
end $$;

select 'ALL INVARIANT TESTS PASSED' as result;
rollback;
