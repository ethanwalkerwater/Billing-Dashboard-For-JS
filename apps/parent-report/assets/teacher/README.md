# 师资数据维护说明

师资团队页（家长报告第④页）的内容来自这个目录，**你只需要维护两样东西**：

1. **`老师卡片.txt`** —— 每位老师的卡片文字（标签 / 简介 / 三项评分）。
2. **头像图片** —— 命名规则 `学科-姓名.png`（如 `数学-应雁心.png`、`物理-李品轩.png`）。

> 旧的 `老师介绍.md` 已不再使用（保留作参考），现在的唯一数据源是 `老师卡片.txt`。

## 一、改老师信息

打开 `老师卡片.txt`，一段就是一位老师，用 `---` 分隔。字段：

```
姓名: 李品轩
学科: 物理                     # 数学 / 物理 / 化学 / 经济 / 英语
头像: 物理-李品轩.png          # 可省略，会按「学科-姓名」自动找
标签: A-Level / 竞赛 物理       # 卡片姓名右边的擅长标注
简介: 西交利物浦大学国际教育硕士……（建议 80–120 字，学历背景 + 教学特点）
学习提升: 4.9                  # 1–5 分一位小数；留空则卡片显示 “—”
责任心: 5.0
个人魅力: 4.8
```

- **新增老师**：复制一段改内容，并把头像放进本目录（`学科-姓名.png`）。
- **删除老师**：删掉那一段（图片可留可删）。
- **填评分**：评分到位后填进 `学习提升/责任心/个人魅力` 即可。

## 二、改完后生成

在仓库根运行：

```bash
npm run build:faculty -w @jingshi/parent-report
```

它做两件事：① 解析 `老师卡片.txt` → `data/teachers.json`；② 把师资卡注入模板
`outputs/parent_reports/模板.html`。打开该 HTML 即可看到更新后的师资页。

## 三、批量制作 parent reports（给开发）

数据与渲染已解耦，批量生成最高效的调用方式：

```js
import fs from "node:fs";
import { renderFacultyByRole } from "apps/parent-report/src/render-faculty.mjs";

// 1) 只解析一次（所有报告共用）
const { teachers } = JSON.parse(fs.readFileSync("apps/parent-report/data/teachers.json", "utf8"));
const photoDir = "apps/parent-report/assets/teacher";

// 2) 每个学生：用其实际课程得出授课老师，渲染师资段（embed=true → 自包含单文件）
for (const student of students) {
  const teaching = teachersOf(student);            // 来自该生账单/课程数据
  const facultyHtml = renderFacultyByRole(teachers, teaching, { embed: true, photoDir });
  // …把 facultyHtml 拼进该生的报告模板…
}
```

- `teachers.json` 只解析一次，循环里零重复开销。
- `embed:true` 把头像内嵌为 base64 → 每份报告是自包含单文件（便于发给家长）；
  模板预览用 `photoBase` 路径引用（文件小）。
- 评分、简介都来自同一份 `老师卡片.txt`，改一处全局生效。
