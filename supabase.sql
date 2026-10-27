-- Jalankan sekali di Supabase → SQL Editor.

-- 1) Satu baris berisi seluruh database aplikasi (akun, tes, hasil).
create table if not exists public.app_state (
  id         text primary key,
  data       jsonb  not null default '{}'::jsonb,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.app_state (id) values ('main') on conflict do nothing;

alter table public.app_state enable row level security;
drop policy if exists "app_state read"   on public.app_state;
drop policy if exists "app_state update" on public.app_state;
create policy "app_state read"   on public.app_state for select to anon using (true);
create policy "app_state update" on public.app_state for update to anon using (id = 'main') with check (id = 'main');

-- 2) Bucket publik untuk foto kamera peserta.
insert into storage.buckets (id, name, public) values ('snapshots', 'snapshots', true)
on conflict (id) do nothing;
drop policy if exists "snapshots upload" on storage.objects;
create policy "snapshots upload" on storage.objects for insert to anon with check (bucket_id = 'snapshots');
