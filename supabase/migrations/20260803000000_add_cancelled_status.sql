alter table public.reservations add column if not exists cancelled boolean not null default false;

create or replace function public.admin_set_cancelled(p_password text, p_id uuid, p_value boolean)
returns reservations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r reservations;
begin
  if p_password <> '1231001010' then
    raise exception 'invalid password';
  end if;
  update reservations set cancelled = p_value where id = p_id returning * into r;
  return r;
end;
$function$;
