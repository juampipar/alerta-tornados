-- Esquema de la red de tormentas (proyecto Supabase yqppzogcaoxhsmgtghqi), tal como está aplicado.
-- Se aplicó con las migraciones red_tormentas_inicial, funciones_privadas y denuncias_ocultan.

create table public.admins (email text primary key);
alter table public.admins enable row level security; -- sin políticas: no se lee desde la web

create table public.publicaciones (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  autor_nombre text,
  autor_avatar text,
  creado timestamptz not null default now(),
  visto_en timestamptz not null default now(),
  dia_tormenta date, -- día de tormenta en Argentina (6 h a 6 h), lo completa el trigger
  lat double precision not null check (lat between -56 and -20),
  lon double precision not null check (lon between -76 and -52),
  precision_m real check (precision_m is null or precision_m >= 0),
  que_vio text[] not null default '{}' check (que_vio <@ array['nada','lluvia fuerte','granizo','nube estante','nube pared','rotación','embudo','tornado']::text[]),
  descripcion text check (char_length(descripcion) <= 500),
  video_url text check (video_url is null or (char_length(video_url) <= 300 and
    video_url ~* '^https://([a-z0-9-]+\.)*(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com)/')),
  foto_path text check (foto_path is null or char_length(foto_path) <= 200),
  oculto boolean not null default false,
  denuncias integer not null default 0
);
create index publicaciones_visto_idx on public.publicaciones (visto_en desc);
create index publicaciones_dia_idx on public.publicaciones (dia_tormenta);
create index publicaciones_user_idx on public.publicaciones (user_id);

-- ¿Es admin quien consulta? En un esquema privado: lo usan las políticas, no está expuesto en la API.
create schema if not exists privado;
grant usage on schema privado to anon, authenticated;
create or replace function privado.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email'));
$$;
revoke execute on function privado.es_admin() from public;
grant execute on function privado.es_admin() to anon, authenticated;

-- Al publicar/editar: autor desde la cuenta de Google, campos protegidos, día de tormenta y límites.
create or replace function public.publicaciones_antes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb;
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.creado := now();
    new.oculto := false;
    new.denuncias := 0;
    select u.raw_user_meta_data into meta from auth.users u where u.id = new.user_id;
    new.autor_nombre := left(coalesce(meta ->> 'full_name', meta ->> 'name', 'Anónimo'), 60);
    new.autor_avatar := left(meta ->> 'avatar_url', 300);
    if (select count(*) from public.publicaciones p where p.user_id = new.user_id and p.creado > now() - interval '1 day') >= 20 then
      raise exception 'Llegaste al límite de 20 publicaciones por día.';
    end if;
  elsif pg_trigger_depth() = 1 then
    new.user_id := old.user_id; new.creado := old.creado; new.autor_nombre := old.autor_nombre; new.autor_avatar := old.autor_avatar;
    new.denuncias := old.denuncias;
    if not privado.es_admin() then new.oculto := old.oculto; end if;
  else
    return new; -- actualización interna (conteo de denuncias)
  end if;
  if new.visto_en > now() + interval '5 minutes' or new.visto_en < now() - interval '7 days' then
    raise exception 'La fecha de lo que viste tiene que ser de los últimos 7 días.';
  end if;
  new.dia_tormenta := ((new.visto_en at time zone 'America/Argentina/Cordoba') - interval '6 hours')::date;
  return new;
end;
$$;
revoke execute on function public.publicaciones_antes() from public, anon, authenticated;
create trigger publicaciones_antes before insert or update on public.publicaciones
for each row execute function public.publicaciones_antes();

alter table public.publicaciones enable row level security;
create policy "ver publicaciones visibles" on public.publicaciones for select
  to anon, authenticated using (not oculto or user_id = auth.uid() or privado.es_admin());
create policy "publicar con sesión" on public.publicaciones for insert
  to authenticated with check (user_id = auth.uid());
create policy "editar lo propio o admin" on public.publicaciones for update
  to authenticated using (user_id = auth.uid() or privado.es_admin()) with check (user_id = auth.uid() or privado.es_admin());
create policy "borrar lo propio o admin" on public.publicaciones for delete
  to authenticated using (user_id = auth.uid() or privado.es_admin());

-- Denuncias: una por persona y publicación; con 3 se oculta.
create table public.denuncias (
  publicacion_id bigint not null references public.publicaciones (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  motivo text check (char_length(motivo) <= 200),
  creado timestamptz not null default now(),
  primary key (publicacion_id, user_id)
);
alter table public.denuncias enable row level security;
create policy "denunciar con sesión" on public.denuncias for insert to authenticated with check (user_id = auth.uid());
create policy "ver mis denuncias o admin" on public.denuncias for select to authenticated using (user_id = auth.uid() or privado.es_admin());

create or replace function public.denuncias_despues() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.publicaciones p
     set denuncias = (select count(*) from public.denuncias d where d.publicacion_id = new.publicacion_id),
         oculto = p.oculto or (select count(*) from public.denuncias d where d.publicacion_id = new.publicacion_id) >= 3
   where p.id = new.publicacion_id;
  return null;
end;
$$;
revoke execute on function public.denuncias_despues() from public, anon, authenticated;
create trigger denuncias_despues after insert on public.denuncias
for each row execute function public.denuncias_despues();

-- Fotos: carpeta por usuario, hasta 5 MB, solo imágenes, lectura pública.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "subir fotos propias" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "borrar fotos propias o admin" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and ((storage.foldername(name))[1] = auth.uid()::text or privado.es_admin()));

insert into public.admins (email) values ('juampipar@gmail.com');
