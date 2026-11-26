-- 教务网站登录白名单：只允许包天翊、黄钢、徐翰超。
-- 已绑定账号继续按飞书 open_id 验证；未绑定者按企业内精确姓名各认领一次。
begin;

update public.feedback_admins set active = false;

with chosen as (
  select distinct on (display_name) user_id
  from public.feedback_admins
  where display_name in ('包天翊', '黄钢', '徐翰超')
  order by display_name, (feishu_open_id is null), user_id
)
update public.feedback_admins
set active = true
where user_id in (select user_id from chosen);

insert into public.feedback_admins (user_id, email, active, feishu_open_id, display_name)
select seed.user_id, null, true, null, seed.display_name
from (values
  ('pending_bao_tianyi', '包天翊'),
  ('pending_huang_gang', '黄钢'),
  ('pending_xu_hanchao', '徐翰超')
) as seed(user_id, display_name)
where not exists (
  select 1
  from public.feedback_admins admin
  where admin.display_name = seed.display_name and admin.active = true
);

commit;
