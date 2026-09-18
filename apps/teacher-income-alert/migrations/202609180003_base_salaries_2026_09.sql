-- 2026-09 教务给出的老师基础薪水，覆盖之前从 teacher-income-report 导入的旧值；页面里仍可随时改。
-- 「Valentina 林」在课表里写作「Valentina Lin」，按课表写法存。
insert into public.income_teachers (teacher, base_salary) values
  ('张劭景', 24000),
  ('应雁心', 36000),
  ('李寅鑫', 24000),
  ('汤朔', 24000),
  ('陈璐怡', 48000),
  ('王冰青', 36000),
  ('刘艳阳', 24000),
  ('高志勇', 24000),
  ('马怡婷', 24000),
  ('李品轩', 36000),
  ('Jack Hou', 24000),
  ('朱毅博', 24000),
  ('唐择运', 24000),
  ('蓝浪', 36000),
  ('罗健文', 36000),
  ('郑唯梓', 24000),
  ('Kevin Liu', 24000),
  ('王储君', 24000),
  ('Valentina Lin', 24000),
  ('黄钢', 36000),
  ('张文豪', 24000),
  ('陈依依', 24000)
on conflict (teacher) do update set base_salary = excluded.base_salary, updated_at = now();
