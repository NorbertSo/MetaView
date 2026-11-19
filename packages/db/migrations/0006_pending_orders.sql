-- 0006: pending entries (stop/limit with expiry) and their cancellation.

set search_path = trading, public;

alter table decisions drop constraint decisions_action_check;
alter table decisions add constraint decisions_action_check check (action in (
  'open_long','open_short','modify_position','add','partial_close','close','cancel_order','hold','skip'));

-- market = immediate; stop/limit = pending order placed at entry_price.
alter table decisions add column entry_type text not null default 'market'
  check (entry_type in ('market','stop','limit'));
alter table decisions add column target_order_id uuid references orders(id) on delete restrict;

alter table orders drop constraint orders_order_kind_check;
alter table orders add constraint orders_order_kind_check check (order_kind in (
  'market','modify','close','close_partial','pending','cancel'));

alter table orders add column order_type text
  check (order_type is null or order_type in ('buy_stop','sell_stop','buy_limit','sell_limit'));
alter table orders add column expires_at timestamptz;
-- Lifecycle of a pending order at the broker (only for order_kind = 'pending').
alter table orders add column pending_state text
  check (pending_state is null or pending_state in ('placed','filled','cancelled','expired'));
alter table orders add column pending_closed_at timestamptz;
-- Planned risk of the pending order (account currency), counted in open-risk gates until it fills or ends.
alter table orders add column planned_risk numeric(18,2);

create index orders_pending_idx on orders (mt_account_id) where pending_state = 'placed';
