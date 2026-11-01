create table if not exists players (
  id serial primary key,
  name text unique not null,
  pin_hash text not null,
  starting_cents integer not null default 0
);
create table if not exists settings (
  id integer primary key default 1 check (id = 1),
  start_date date not null,
  end_date date not null,
  milestone_cents integer not null default 700000,
  first_date_planner_id integer references players(id)
);
create table if not exists deposits (
  id serial primary key,
  player_id integer not null references players(id),
  amount_cents integer not null check (amount_cents > 0),
  note text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists dates (
  id serial primary key,
  planner_id integer not null references players(id),
  title text not null,
  scope text[] not null,
  budget_cap_cents integer,
  planned_for date,
  status text not null default 'planned' check (status in ('planned','done','skipped')),
  deleted_at timestamptz
);
alter table dates add column if not exists deleted_at timestamptz;
create table if not exists spends (
  id serial primary key,
  player_id integer not null references players(id),
  amount_cents integer not null check (amount_cents > 0),
  category text not null,
  note text,
  date_id integer references dates(id),
  proposed_by integer not null references players(id),
  via text not null check (via in ('solo','immunity','rps')),
  split_group uuid,
  texted_first boolean not null default false,
  is_gas boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists rps_rounds (
  id serial primary key,
  topic text not null default '',
  started_by integer references players(id),
  p1_move text check (p1_move in ('rock','paper','scissors')),
  p2_move text check (p2_move in ('rock','paper','scissors')),
  ties integer not null default 0,
  winner_id integer references players(id),
  resolved_at timestamptz,
  cancelled_at timestamptz
);
-- p1 = the lower player id. For databases migrated before phase 5:
alter table rps_rounds add column if not exists topic text not null default '';
alter table rps_rounds add column if not exists started_by integer references players(id);
alter table rps_rounds add column if not exists ties integer not null default 0;
alter table rps_rounds add column if not exists cancelled_at timestamptz;
alter table rps_rounds drop column if exists spend_id;
alter table spends add column if not exists rps_round_id integer references rps_rounds(id);
create unique index if not exists spends_one_per_rps_round on spends (rps_round_id)
  where rps_round_id is not null and deleted_at is null;
create table if not exists audit_log (
  id bigserial primary key,
  table_name text not null,
  row_id integer not null,
  action text not null check (action in ('create','update','delete')),
  actor_id integer not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create table if not exists snapshots (
  id serial primary key,
  taken_at timestamptz not null default now(),
  trigger text not null check (trigger in ('cron','manual')),
  payload jsonb not null
);
create table if not exists login_failures (
  player_id integer not null,
  at timestamptz not null default now()
);
