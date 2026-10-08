-- 预警线 = 基础薪水 × 底薪倍数（默认 1.2，和「老师收入详情」的底薪扣减系数一致），倍数在页面顶部可改。
-- 基础薪水本身按收入详情的原值存。不在收入详情基础薪水表里、但同样被乘过 1.2 的 4 位（24000 = 20000 × 1.2）一并还原，
-- 否则改成按倍数算之后会被乘两次。只改仍是 24000 的，页面上手改过的不动。
begin;

alter table public.income_settings add column if not exists base_multiplier numeric(4,2) not null default 1.2;

update public.income_teachers
set base_salary = 20000, updated_at = now()
where teacher in ('Jack Hou', '唐择运', '马怡婷', '高志勇') and base_salary = 24000;

commit;
