# 菁仕月度课时收费报表

这个目录用于把飞书/课程表导出的原始 CSV 转成可交互收费报表。

现在有两种使用方式：

- 线上页面：打开 Vercel 部署后的页面，直接上传最新 CSV。
- 本地脚本：把 CSV 放到 `data/raw/schedule.csv`，运行 Python 脚本生成静态 HTML。

线上页面不会保存原始课表；CSV 在浏览器本地解析。

## 线上页面使用步骤

1. 打开部署后的 Vercel 地址。
2. 选择或拖入最新课程表 CSV。
3. 使用月份和学生/老师筛选报表。
4. 点击汇总行的“明细”查看对应原始行。
5. 需要留档时点击“导出当前汇总”。

## 本地脚本使用步骤

1. 把新的原始课程表 CSV 覆盖到：

   `data/raw/schedule.csv`

2. 在本目录运行：

   ```bash
   python3 scripts/course_billing_report.py
   ```

3. 打开生成结果：

   `outputs/course_billing_report/course_billing_report.html`

## 本地预览上传页面

```bash
npm run dev
```

然后打开：

`http://localhost:4173`

## 部署到 Vercel

```bash
npx vercel --prod --yes
```

部署时 `.vercelignore` 会排除 `data/raw/` 和 `outputs/`，避免把原始 CSV 或旧 HTML 输出上传到线上。

## 常用命令

如果原始表不放在默认路径，可以临时指定：

```bash
python3 scripts/course_billing_report.py --input /path/to/raw.csv --output outputs/course_billing_report/course_billing_report.html
```

运行测试：

```bash
npm test
python3 -m unittest tests/course_billing_report_test.py
npm run build
```

## 报表口径

- 学生收费视图：按月份和学生筛选，展示当月上过哪些老师的课。
- 老师收入视图：按月份和老师筛选，展示当月教过哪些学生。
- 汇总维度：对方、课程类型、授课类型、取消/上课状态。
- 同一课程类型但授课类型不同会拆成多行。
- 临时取消按 `0h-70%`、`2h-50%`、`6h-30%` 单独列出并计费。
- 金额优先使用原始表里的 `课程总价格`。
- 脚本会同时计算规则金额，用于检查原始表金额是否异常。
- 每个汇总行都可以打开对应原始行明细，方便核查。

## 数据质量提醒

报表会提示这些常见问题：

- 缺少学生
- 缺少老师
- 缺少课程类型
- 缺少授课类型
- 缺少或无法解析上课时间
- 未知临时取消标记，例如 `请假`
- 原始金额与规则计算金额不一致
- 未进入计费汇总的零金额占位/考试记录

## 目录结构

```text
data/raw/schedule.csv                         # 默认输入
index.html                                    # Vercel 上传页面
assets/report-core.js                         # 浏览器端计费核心
assets/app.js                                 # 页面交互
assets/styles.css                             # shadcn 风格样式
scripts/course_billing_report.py              # 报表生成器
tests/course_billing_report_test.py           # 计费规则测试
outputs/course_billing_report/course_billing_report.html
```
