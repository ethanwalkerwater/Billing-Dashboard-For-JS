import { useCallback, useEffect, useMemo, useState } from "react";

import { DEFAULT_RATES, evaluateTeacher } from "@/domain/income";
import type { Evaluation, Rates, TeacherSettings } from "@/domain/income";
import { MONTHS_TABLE, SETTINGS_TABLE, TEACHERS_TABLE } from "@/shared/postgrest";
import type { SettingsRow, TeacherMonthRow, TeacherRow } from "@/shared/postgrest";
import { callIncomeApi, db } from "./cloudbase";

export interface TeacherLine extends Evaluation {
  teacher: string;
  lessonFee: number;
  lessons: number;
  hours: number;
  students: string[];
  unitPriceAuto: number | null;
  settings: TeacherSettings;
  /** 被排除的老师（兼职、已离职、不需要盯的）：不进统计和导出，页面上可恢复 */
  excluded: boolean;
}

const num = (value: unknown): number | null => (value == null || value === "" ? null : Number(value));

export function useIncomeData(month: string) {
  const [months, setMonths] = useState<TeacherMonthRow[]>([]);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [rates, setRates] = useState<Rates>(DEFAULT_RATES);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [monthRows, teacherRows, settingRows] = await Promise.all([
        db.from(MONTHS_TABLE).select<TeacherMonthRow>("*").eq("month", month),
        db.from(TEACHERS_TABLE).select<TeacherRow>("*"),
        db.from(SETTINGS_TABLE).select<SettingsRow>("*").eq("id", 1),
      ]);
      const failed = [monthRows, teacherRows, settingRows].find((result) => result.error);
      if (failed?.error) throw new Error(failed.error.message);
      setMonths(monthRows.data ?? []);
      setTeachers(teacherRows.data ?? []);
      const settings = settingRows.data?.[0];
      if (settings) setRates({ min: Number(settings.min_rate), max: Number(settings.max_rate), baseMultiplier: Number(settings.base_multiplier ?? DEFAULT_RATES.baseMultiplier) });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 老师名单 = 有底薪配置的 ∪ 当月课表里出现的，两边都算，谁没课谁没底薪一眼看到。 */
  const lines = useMemo<TeacherLine[]>(() => {
    const settingsByTeacher = new Map(teachers.map((row) => [row.teacher, row]));
    const monthByTeacher = new Map(months.map((row) => [row.teacher, row]));
    const names = [...new Set([...settingsByTeacher.keys(), ...monthByTeacher.keys()])];
    return names
      .map((teacher) => {
        const monthRow = monthByTeacher.get(teacher);
        const row = settingsByTeacher.get(teacher);
        const settings: TeacherSettings = {
          baseSalary: num(row?.base_salary),
          unitPrice: num(row?.unit_price),
          extraIncome: num(row?.extra_income),
          customRate: num(row?.custom_rate),
          note: row?.note ?? "",
        };
        const lessonFee = Number(monthRow?.lesson_fee ?? 0);
        const unitPriceAuto = num(monthRow?.unit_price_auto);
        return {
          teacher,
          lessonFee,
          lessons: monthRow?.lessons ?? 0,
          hours: Number(monthRow?.hours ?? 0),
          students: monthRow?.students ?? [],
          unitPriceAuto,
          settings,
          excluded: row?.is_excluded ?? false,
          ...evaluateTeacher({ lessonFee, unitPriceAuto, settings, rates }),
        };
      })
      .sort((a, b) => a.teacher.localeCompare(b.teacher, "zh-CN"));
  }, [months, teachers, rates]);

  const syncedAt = useMemo(() => months.map((row) => row.synced_at).sort().at(-1) ?? null, [months]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      await callIncomeApi({ action: "sync", month });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  }, [month, reload]);

  /** 底薪 / 额外收入 / 单价 / 自定义系数 / 备注 / 排除：改一格存一格。 */
  const saveTeacher = useCallback(
    async (teacher: string, patch: Partial<Pick<TeacherRow, "base_salary" | "extra_income" | "unit_price" | "custom_rate" | "note" | "is_excluded">>) => {
      const current = teachers.find((row) => row.teacher === teacher);
      const next: TeacherRow = {
        teacher,
        base_salary: current?.base_salary ?? null,
        unit_price: current?.unit_price ?? null,
        extra_income: current?.extra_income ?? null,
        custom_rate: current?.custom_rate ?? null,
        note: current?.note ?? "",
        is_excluded: current?.is_excluded ?? false,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      // 先改本地再落库，输入框不等网络
      setTeachers((rows) => (current ? rows.map((row) => (row.teacher === teacher ? next : row)) : [...rows, next]));
      const result = await db.from(TEACHERS_TABLE).upsert([{ ...next }], { onConflict: "teacher" });
      if (result.error) {
        setError(`保存失败：${result.error.message}`);
        await reload();
      }
    },
    [teachers, reload],
  );

  const saveRates = useCallback(
    async (next: Rates) => {
      setRates(next);
      const result = await db
        .from(SETTINGS_TABLE)
        .upsert([{ id: 1, min_rate: next.min, max_rate: next.max, base_multiplier: next.baseMultiplier, updated_at: new Date().toISOString() }], { onConflict: "id" });
      if (result.error) setError(`保存系数失败：${result.error.message}`);
    },
    [],
  );

  return { lines, rates, syncedAt, loading, syncing, error, reload, sync, saveTeacher, saveRates };
}
