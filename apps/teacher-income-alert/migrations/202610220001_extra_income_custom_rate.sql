-- 额外收入：课时以外的固定收入（如管理费），预警线 = 基础薪水 × 底薪倍数 − 额外收入。
-- 自定义系数：教务按老师试算 0.47 / 0.62 以外的系数，页面多出「自定义差值」「自定义需加」两列。
begin;

alter table public.income_teachers add column if not exists extra_income numeric(12,2);
alter table public.income_teachers add column if not exists custom_rate numeric(5,4);

commit;
