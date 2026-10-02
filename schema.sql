-- Friends Chat: схема для Supabase. Выполните ЦЕЛИКОМ в SQL Editor.
--
-- Если вы уже запускали старую версию и получили ошибку или остались её куски,
-- сначала выполните этот сброс (он удалит данные чата!), потом весь файл:
--   drop table if exists public.messages cascade;
--   drop table if exists public.profiles cascade;
--   drop type if exists public.account_status cascade;
--   drop type if exists public.app_role cascade;
--   drop function if exists public.is_admin(), public.is_approved(), public.handle_new_user(), public.send_message(text), public.username_taken(text) cascade;

create type public.account_status as enum ('pending', 'approved', 'banned');
create type public.app_role as enum ('user', 'admin');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 3 and 24),
  status public.account_status not null default 'pending',
  role public.app_role not null default 'user',
  tag_name text check (tag_name is null or char_length(tag_name) <= 18),
  tag_color text check (tag_color is null or tag_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now()
);
-- ники уникальны без учёта регистра (нельзя выдать себя за "Admin")
create unique index profiles_username_lower_idx on public.profiles (lower(username));

create table public.messages (
  id bigint generated always as identity primary key,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 40),
  created_at timestamptz not null default now()
);
create index messages_created_idx on public.messages (created_at desc);
create index messages_author_created_idx on public.messages (author_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.messages enable row level security;

-- Вспомогательные функции (security definer, чтобы не упираться в RLS)
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'approved'
  )
$$;

create function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  )
$$;

-- Проверка занятости ника (нужна до регистрации, поэтому доступна и без входа)
create function public.username_taken(uname text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where lower(username) = lower(trim(uname)))
$$;
revoke all on function public.username_taken(text) from public;
grant execute on function public.username_taken(text) to anon, authenticated;

-- Политики
-- Профили: свой видишь всегда; одобренные участники видят остальных (нужны ники и теги в чате).
create policy "read profiles" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_approved());

-- Менять профили (одобрить, бан, теги) может только админ.
-- Админ не может снять админку / забанить сам себя.
create policy "admin updates profiles" on public.profiles for update to authenticated
  using (public.is_admin())
  with check (
    public.is_admin()
    and (id <> auth.uid() or (role = 'admin' and status = 'approved'))
  );

-- Сообщения: читать могут только одобренные, удалять только админ.
-- Политики на insert/update нет, писать можно только через send_message().
create policy "approved read messages" on public.messages for select to authenticated
  using (public.is_approved());
create policy "admin delete messages" on public.messages for delete to authenticated
  using (public.is_admin());

-- Автосоздание профиля (статус pending) при регистрации
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uname text;
begin
  uname := nullif(trim(new.raw_user_meta_data->>'username'), '');
  if uname is null
     or char_length(uname) not between 3 and 24
     or exists (select 1 from public.profiles where lower(username) = lower(uname)) then
    uname := 'user_' || substring(new.id::text, 1, 8);
  end if;
  insert into public.profiles (id, username) values (new.id, uname);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Отправка сообщения: статус, длина 1-40 и пауза 5 секунд проверяются здесь, на сервере
create function public.send_message(message text) returns public.messages
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  clean text := trim(coalesce(message, ''));
  m public.messages;
begin
  if uid is null or not public.is_approved() then
    raise exception 'Нет подтверждённого доступа';
  end if;

  if char_length(clean) not between 1 and 40 then
    raise exception 'Сообщение должно содержать от 1 до 40 символов';
  end if;

  -- блокировка на пользователя: параллельные запросы не обходят паузу
  perform pg_advisory_xact_lock(hashtext(uid::text));

  if exists (
    select 1 from public.messages
    where author_id = uid and created_at > now() - interval '5 seconds'
  ) then
    raise exception 'Можно отправлять одно сообщение каждые 5 секунд';
  end if;

  insert into public.messages (author_id, body) values (uid, clean) returning * into m;
  return m;
end;
$$;
revoke all on function public.send_message(text) from public;
grant execute on function public.send_message(text) to authenticated;

-- Realtime: чат обновляется сам, админ сразу видит новые заявки
alter publication supabase_realtime add table public.messages, public.profiles;
