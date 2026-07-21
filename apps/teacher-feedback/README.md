# 菁仕老师反馈系统

本应用属于菁仕后台服务 Monorepo。真实反馈表和课表统一放在仓库根
`data/local/teacher-feedback/`，公共课表读取 `data/local/shared/`，输出统一写入仓库根
`outputs/teacher-feedback/`；这两个目录都不会进入 Git 或 Vercel。

## 0. 先看这些文件
- [全仓库数据目录与接口约定](../../data/README.md)
- [AI 工作台说明](docs/AI工作台说明.md)
- [历史目录整理计划](docs/plans/2026-04-12-workspace-cleanup.md)
- [主脚本](scripts/monthly_teacher_feedback.py)
- [测试](tests/test_monthly_teacher_feedback.py)
- [当前姓名映射](templates/name_mapping.csv)

## 1. 处理逻辑（当前默认口径）
- 统计指定月份（`YYYY-MM`）的数据。
- 反馈月份默认按“报表月份 + 1 个月的提交时间”读取。
  例如：`2026-02` 月报默认读取 `2026-03` 提交的反馈，因为反馈填写通常发生在次月。
- 老师总课时：课表中该月、该老师、且`临时取消`为空的`课程时长`总和。
- 默认会过滤非授课占位事件（通过`课程类型`关键词与最大课时阈值控制）。
- 学员反馈影响权重：`学员在该老师该月课时 / 老师该月总课时`。
- 反馈去重：同一`老师+学员+身份`仅保留当月最后一次提交。
- 默认会把同一`老师+学员`下的“学生/家长”反馈先合并（避免双重计权）。
- 对于“当月有上课但该学员没有给该老师该项评分”的情况，会用**当月该项平均分**补齐后再参与老师评分，避免因样本过少导致老师分数虚高。
- 覆盖率、反馈条数、未匹配反馈仍然按**真实反馈**统计，不会因为均分补齐而伪造反馈数量。
- **文本型评分自动转分值**：部分指标（尤其是【家长】维度）从“1-5 数值”改成了“文本选项”。脚本会先按内置映射表把文本答案转成 1-5 分，再回退到数字解析，因此老的纯数字数据、以及“5分 − 高效回复”这类带数字前缀的文案都能继续正常工作。
  - 内置映射覆盖：学习提升效果（家长/学生）、责任心与服务态度、个人魅力。
  - 维护文件：`templates/score_text_map.csv`（格式 `答案文本,分值`，分组标题行可留空第二列）。
  - 如出现**没有对应分值的新文本**，脚本会在终端打印 `[警告]` 并写入 `run_meta.json` 的 `unmapped_score_texts`，该项按缺失处理（不会乱给分）。看到警告应先补映射再重跑。
  - 临时追加/覆盖映射：用 `--score-map your_map.csv`，会叠加在内置表之上。
- **新版问卷结构（2026-06 起）**：脚本已适配新版反馈表，并向后兼容旧版列名。
  - 身份/姓名列：`老师姓名`、`学生姓名`、`身份`（值含 `学生本人`，会归一化为“学生”）；旧版 `老师名/学员名/填写人身份` 仍可识别。
  - 老师评分指标（均支持 总/学生/家长 切换）：**学习提升效果、责任心与服务态度、个人魅力、推荐度**。其中责任心、个人魅力、推荐度在新版里拆成了【家长】/【学生】两列，脚本会自动合并。
  - **已移除指标**：教学目标、反馈及时、沟通感受、顾问回复反馈、上课风格/教学节奏/课堂互动（新版问卷已不再收集）。
  - **机构层面单独分析（不计入老师评分）**：`满意度`、`机构优势` 仅做整体分布统计，结果打印在终端并写入 `run_meta.json` 的 `org_analysis`。

## 2. 脚本位置
- `apps/teacher-feedback/scripts/monthly_teacher_feedback.py`

## 3. 快速运行
在 Monorepo 根目录执行：

```bash
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py --month 2026-02
```

输出目录：`outputs/teacher-feedback/<月份>/`
- `outputs/teacher-feedback/2026-02/respondent_detail.csv`：反馈明细（含反馈学员名、对应课时、学员总课时、权重、文本反馈）
- `outputs/teacher-feedback/2026-02/teacher_summary.csv`：老师汇总（覆盖率、各指标加权分、文本反馈计数与样例）
- `outputs/teacher-feedback/2026-02/teacher_text_feedback.csv`：文本反馈汇总（改进建议/推荐理由等）
- `outputs/teacher-feedback/2026-02/unmatched_feedback.csv`：未匹配到课时的反馈
- `outputs/teacher-feedback/2026-02/dashboard.html`：可视化看板（指标独立切换 + 总/学生/家长维度切换）
- `outputs/teacher-feedback/2026-02/run_meta.json`：本次运行配置与统计信息

## 4. 常用参数
```bash
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py \
  --month 2026-02 \
  --identities 学生 \
  --combine-mode independent \
  --feedback-start-date 2026-03-27 \
  --feedback-end-date 2026-04-12 \
  --max-duration-hours 8 \
  --exclude-course-type-keywords 请假,假期,空出,文书,会议,课表确定 \
  --name-map templates/name_mapping.csv
```

- `--identities`：`学生` / `家长/监护人` / `all`
- `--combine-mode`
  - `merge_by_student`：同老师同学员多身份先合并（推荐）
  - `independent`：学生和家长分别计权
- `--name-map`：姓名映射文件（可选）
- `--include-cancelled`：如需将临时取消课程计入总课时，可开启
- `--feedback-month-offset`：反馈提交月份偏移，默认 `1`
- `--feedback-start-date` / `--feedback-end-date`：显式指定反馈统计时间窗口（含起止）；提供后会覆盖 `--feedback-month-offset`
- `--max-duration-hours`：过滤异常长时长课程（默认 `8` 小时）
- `--exclude-course-type-keywords`：过滤非授课课程类型关键词（默认已内置）
- `--score-map`：追加“文本选项->分值”映射 CSV（叠加在内置表之上），用于新出现的文本选项

## 5. 姓名清洗建议
- 把 `templates/name_mapping_template.csv` 复制为 `templates/name_mapping.csv` 后持续维护。
- 建议优先维护：
  - 老师名后缀（如“老师”）统一
  - 英文名空格统一（如 `Lucas Zhang` -> `LucasZhang`）
  - 中英文混合名空格统一（如 `Stephen 杨` -> `Stephen杨`）

## 6. Dashboard 使用说明
- 指标切换：每个指标独立显示并按分值从高到低排序，不混图。
- 维度切换：支持有维度的指标在“总/学生/家长”间切换（如学习提升、顾问回复反馈）。
- 指标说明：右侧“指标说明”区域可查看覆盖率和各指标定义。
- 文本反馈：页面底部展示“改进反馈、推荐理由、需提升、不满意”等计数与样例。

## 7. 标准操作步骤（给任何执行人）
以下步骤默认都在项目根目录执行：

```bash
cd /path/to/jingshi-monorepo
```

### Step 1. 替换最新反馈文件
下载最新的 `菁仕反馈总表_3️⃣ 【学员】月度教学满意度反馈`，并覆盖当前目录里的同名文件：

```text
data/local/teacher-feedback/feedback.csv
```

检查项：
- 文件名必须保持不变。
- 文件替换后，确认文件修改时间是最新的。
- 不要把文件放进 `outputs/` 或其他子目录。

### Step 2. 替换最新课表
下载最新课表，并覆盖当前目录里的：

```text
data/local/shared/schedule.csv
```

检查项：
- 文件名必须保持不变。
- 确认课表是最新导出版本。
- 如果课表结构变了，先不要运行，先确认字段名是否仍然正常。

### Step 3. 确认本次反馈统计时间窗口
执行前必须先确认“这次月报要统计哪一段反馈提交时间”。

例如：
- 3 月月报的反馈收集时间是 `2026/03/27 - 最新`
- 其中 **包含** `2026/03/27` 当天

执行规则：
- 起始时间要写成 `--feedback-start-date 2026-03-27`
- 如果要固定结果，结束时间也要明确写出，例如 `--feedback-end-date 2026-04-12`
- 如果你写“到最新”，但没有写结束时间，脚本会统计到当前反馈文件里的最新记录

建议：
- 对外正式出数时，尽量把结束时间也写死，这样结果可复现。
- 日期统一使用 `YYYY-MM-DD` 格式输入命令。

### Step 4. 运行 Codex/终端命令出数
示例：生成 `2026-03` 月报，反馈窗口从 `2026-03-27` 到 `2026-04-12`：

```bash
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py \
  --month 2026-03 \
  --feedback-start-date 2026-03-27 \
  --feedback-end-date 2026-04-12
```

如果本次要求是“从某天开始，到反馈表最新为止”，可以不写结束时间：

```bash
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py \
  --month 2026-03 \
  --feedback-start-date 2026-03-27
```

输出目录会生成在：

```text
outputs/teacher-feedback/2026-03/
```

### Step 5. 输出后必须检查的内容
每次跑完后，必须检查以下文件和项目。

#### 5.1 先检查终端输出
终端会显示：
- 月份
- 输出目录
- 去重后的反馈记录数
- 成功匹配课时数
- 匹配率
- 老师数
- 总课时

检查项：
- 月份是否正确
- 老师数、总课时是否明显异常
- 匹配率如果突然很低，先不要继续发结果

#### 5.2 检查 `run_meta.json`
打开：

```text
outputs/teacher-feedback/2026-03/run_meta.json
```

重点确认：
- `month` 是否正确
- `input_feedback_csv` 和 `input_schedule_csv` 是否是当前目录下的最新文件
- `feedback_start_date` 是否等于本次口径起始日
- `feedback_end_date` 是否符合本次口径
- `feedback_stats.feedback_window_start` / `feedback_window_end` 是否正确
- `schedule_stats.teacher_count_in_month`、`total_teacher_hours` 是否合理
- `unmapped_score_texts` 是否为空：**非空说明有文本选项没对应到分值**，这些反馈的该项评分被当作缺失。需到 `templates/score_text_map.csv` 补充对应关系后重跑（或用 `--score-map` 临时补）。

#### 5.3 检查 `unmatched_feedback.csv`
打开：

```text
outputs/teacher-feedback/2026-03/unmatched_feedback.csv
```

检查项：
- 未匹配条数是否异常偏多
- 是否只是名字写法问题
- 是否出现老师或学生明显在课表里存在，但没匹配上的情况

处理规则：
- 如果发现别名问题，更新 `templates/name_mapping.csv`
- 更新后必须重跑一次命令

#### 5.4 检查 `teacher_summary.csv`
打开：

```text
outputs/teacher-feedback/2026-03/teacher_summary.csv
```

重点看：
- 是否有老师总课时为 0 或异常低
- 是否有大量老师没有匹配反馈
- 覆盖率是否异常
- 推荐度、学习提升效果等指标是否有明显离谱值

#### 5.5 检查 `dashboard.html`
打开：

```text
outputs/teacher-feedback/2026-03/dashboard.html
```

重点看：
- 图表是否能正常打开
- 排名和汇总表是否正常显示
- 头部老师、低分老师、覆盖率异常老师是否符合预期

## 8. 常见复跑场景
### 场景 A：只更新了反馈文件
重新替换反馈文件后，直接按原命令重跑。

### 场景 B：课表更新了
重新替换 `菁仕反馈总表_课表.csv` 后，必须重跑，因为老师数、总课时、匹配结果都可能变化。

### 场景 C：发现反馈时间口径错了
不要改输出文件，直接改命令里的：
- `--feedback-start-date`
- `--feedback-end-date`

然后整份月报重跑。

## 9. Web 服务版（Vercel）
现在仓库已经包含一个可部署到 Vercel 的上传处理页。

### 9.1 用户使用方式
部署完成后，用户只需要：
1. 打开网页
2. 上传反馈表 CSV
3. 上传课表 CSV
4. 选择报表月份
5. 填写反馈时间窗口
6. 点击“开始处理”

系统会返回：
- `teacher_summary.csv`
- `teacher_text_feedback.csv`
- `respondent_detail.csv`
- `unmatched_feedback.csv`
- `dashboard.html`
- `run_meta.json`

### 9.2 项目文件
- `index.html`：上传页面
- `api/process.py`：Vercel Python API
- `vercel.json`：Vercel 部署配置
- `requirements.txt`：Python 依赖

### 9.3 本地开发
先安装依赖：

```bash
python3 -m pip install -r requirements.txt
```

如果只是验证核心统计逻辑：

```bash
python3 -m unittest tests.test_monthly_teacher_feedback
```

**本地完整跑网页版（上传 + 处理）**，必须用服务器启动，不能直接双击打开 `index.html`：

```bash
python3 -m uvicorn api.process:app --reload --port 8000
# 然后浏览器打开 http://127.0.0.1:8000
```

> ⚠️ 报错 `Failed to parse URL from /api/process` 就是因为页面被当成本地文件（`file://`）或静态预览打开了——此时没有后端，相对地址 `/api/process` 无法解析。务必通过上面的服务器地址访问。

### 9.4 部署到 Vercel
仓库推到 Git 后，在 Vercel 中导入该项目即可。

部署注意：
- Vercel 会直接托管根目录下的 `index.html`
- `/api/process` 由 `api/process.py` 提供
- `vercel.json` 已排除本地历史输出和大体积源数据文件，避免把当前 CSV 一起打包部署

### 9.5 线上使用提醒
- 反馈表和课表必须上传 CSV
- 反馈起始日期包含当天
- 如果反馈结束日期留空，系统会统计到上传反馈表里的最新记录
- 可在“排除老师”中输入 `窦,蒋妍` 这样的逗号分隔名单
- Vercel 对单次请求体大小有限制，若未来课表继续变大，可能需要改成对象存储上传方案
