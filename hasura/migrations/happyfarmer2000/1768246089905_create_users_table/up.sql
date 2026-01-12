create table public.users (
  id bigint primary key,               -- telegram user id

  username text,
  first_name text not null,
  last_name text,
  language_code text,
  allows_write_to_pm boolean not null,
  photo_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
