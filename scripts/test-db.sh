#!/usr/bin/env bash
# Recreates a local test database, applies migrations and runs invariant tests.
# Requires a local Postgres reachable as postgres:postgres@localhost.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=${PGPASSWORD:-postgres}
DB=${TEST_DB:-tv_test}
psql -h localhost -U postgres -q -c "drop database if exists $DB" -c "create database $DB"
psql -h localhost -U postgres -d "$DB" -q -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;"
DATABASE_URL="postgres://postgres:${PGPASSWORD}@localhost:5432/$DB" pnpm --silent --filter @tv/db migrate
# second run must be a no-op
DATABASE_URL="postgres://postgres:${PGPASSWORD}@localhost:5432/$DB" pnpm --silent --filter @tv/db migrate
psql -h localhost -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -t -f packages/db/tests/invariants.sql | grep -v '^\s*$' | tail -1
