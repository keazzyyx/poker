-- =============================================================================
-- Texas Hold'em – Supabase schema
-- =============================================================================
-- Run this entire file in the Supabase SQL Editor (Dashboard → SQL → New query).
-- It creates the two tables the app needs, opens up permissive access for the
-- anonymous (anon) API key, and enables Realtime so every connected browser
-- receives live updates.
--
-- NOTE ON SECURITY: This is a portfolio / hobby project with no authentication.
-- The policies below allow the public `anon` key to read and write freely, which
-- is fine for a friendly game but is NOT production-grade. See README.md.
-- =============================================================================

-- Clean slate (safe to re-run) ------------------------------------------------
drop table if exists public.players cascade;
drop table if exists public.rooms   cascade;

-- ---------------------------------------------------------------------------
-- rooms: one row per game. The full, authoritative game state lives in `state`
-- (a JSONB blob written only by the host/dealer client).
-- ---------------------------------------------------------------------------
create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,                 -- short shareable code e.g. ABC123
  host_id     text not null,                         -- client id of the host
  status      text not null default 'lobby',         -- 'lobby' | 'playing' | 'finished'
  small_blind int  not null default 10,
  big_blind   int  not null default 20,
  state       jsonb,                                 -- live game state (deck, pot, turn, …)
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- players: one row per seated player. `pending_action` is how a non-host client
-- submits a move; the host reads it, applies the rules, then clears it.
-- ---------------------------------------------------------------------------
create table public.players (
  id             text not null,                      -- client id (persisted in localStorage)
  room_id        uuid not null references public.rooms(id) on delete cascade,
  username       text not null,
  chips          int  not null default 0,            -- current chip stack (host-authoritative)
  buy_in         int  not null default 1000,
  seat           int  not null,                      -- 0-based seat index
  is_host        boolean not null default false,
  pending_action jsonb,                              -- { action, amount } submitted by the player
  connected      boolean not null default true,
  joined_at      timestamptz not null default now(),
  primary key (id, room_id)
);

create index players_room_idx on public.players(room_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: enable, then allow everything for anon (portfolio only).
-- ---------------------------------------------------------------------------
alter table public.rooms   enable row level security;
alter table public.players enable row level security;

create policy "rooms_all"   on public.rooms   for all using (true) with check (true);
create policy "players_all" on public.players for all using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Realtime: broadcast row changes to subscribed clients.
-- `replica identity full` ensures DELETE/UPDATE payloads include the old row.
-- ---------------------------------------------------------------------------
alter table public.rooms   replica identity full;
alter table public.players replica identity full;

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
