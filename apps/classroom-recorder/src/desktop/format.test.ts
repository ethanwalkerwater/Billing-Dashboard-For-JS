// npx tsx --test src/desktop/format.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lesson } from './bridge';
import { dayLabel, ordered, shanghaiToday } from './format';

test('MVP 分组与排序', () => {
  const l = (id: string, date: string, start: string) => ({ id, date, start, end: '', title: id }) as Lesson;
  const rows = ordered([l('xiaoyu', '2026-10-15', '16:00'), l('haoran', '2026-10-15', '13:30'), l('zihan', '2026-10-15', '10:00'),
    l('chenxi', '2026-10-15', '19:30'), l('yinuo', '2026-10-14', '18:00'), l('haoran2', '2026-10-14', '13:30'),
    l('zihan2', '2026-10-12', '10:00'), l('tmr', '2026-10-16', '09:00')], '2026-10-15');
  assert.deepEqual(rows.map(r => r.lesson.id), ['zihan', 'haoran', 'xiaoyu', 'chenxi', 'tmr', 'yinuo', 'haoran2', 'zihan2']);
  assert.deepEqual([...new Set(rows.map(r => r.group))], ['今天', '明天', '昨天', '更早']);
  assert.equal(dayLabel('2026-10-12', '2026-10-15'), '10/12 周一');
  assert.equal(shanghaiToday(Date.parse('2026-10-14T16:30:00Z')), '2026-10-15'); // UTC 16:30 = 上海次日 00:30
});
