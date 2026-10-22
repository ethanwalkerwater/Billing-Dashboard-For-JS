-- 教务网站改用飞书登录（反馈工作台、取消课程、雅思正向率共用 feedback_admins）。
-- 白名单按飞书 open_id 维护；user_id 仍是 CloudBase 用户 ID（RLS 的 auth.uid() 和云函数 getUserInfo().uid 都按它判断），
-- 第一次飞书登录后由 feedback-api 的 bind-feishu 自动写入。新加的管理员先放占位值 'feishu:' || open_id。
begin;

alter table public.feedback_admins add column if not exists feishu_open_id text unique;
alter table public.feedback_admins add column if not exists display_name text;
alter table public.feedback_admins alter column email drop not null;

commit;

-- 开通管理员（open_id 在对方登录被拒的页面上能看到）：
-- insert into public.feedback_admins (user_id, feishu_open_id, display_name)
-- values ('feishu:ou_xxxxxxxx', 'ou_xxxxxxxx', '姓名');
--
-- 收回权限：update public.feedback_admins set active = false where feishu_open_id = 'ou_xxxxxxxx';
