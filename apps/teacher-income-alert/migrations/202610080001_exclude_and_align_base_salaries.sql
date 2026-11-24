-- 1) 排除老师：不参与预警统计、表格默认不显示、不导出（页面上随时恢复）。
-- 2) 基础薪水对齐「老师收入详情」的老师基础薪水表（apps/teacher-income-report/web/assets/payroll/defaults.json，
--    2026-07-06 生成，20 位老师）。2026-09 那批种子数据恰好都是这张表的 1.2 倍（20000→24000），
--    应是把「底薪扣减系数 1.2」乘进去了。不在这张表里的老师（Jack Hou、Kevin Liu、包天翊、唐择运、马怡婷、高志勇）不动。
-- 3) 之前为了「不算这个老师」手动改成 0 的，改为排除，同时填回正确的基础薪水，取消排除后数字就是对的。
begin;

alter table public.income_teachers add column if not exists is_excluded boolean not null default false;

update public.income_teachers set is_excluded = true, updated_at = now() where base_salary = 0;

insert into public.income_teachers (teacher, base_salary) values
  ('Tinko', 25000),
  ('Valentina Lin', 20000),
  ('傅威程', 25000),
  ('刘艳阳', 20000),
  ('华心晨', 15000),
  ('应雁心', 30000),
  ('张劭景', 20000),
  ('张文豪', 20000),
  ('朱毅博', 20000),
  ('李品轩', 30000),
  ('李寅鑫', 20000),
  ('汤朔', 20000),
  ('王储君', 20000),
  ('王冰青', 30000),
  ('罗健文', 30000),
  ('蓝浪', 30000),
  ('郑唯梓', 30000),
  ('陈依依', 20000),
  ('陈璐怡', 40000),
  ('黄钢', 30000)
on conflict (teacher) do update set base_salary = excluded.base_salary, updated_at = now();

commit;
