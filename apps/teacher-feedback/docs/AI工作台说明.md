# 菁仕项目 AI 工作台说明

## 项目用途
这个目录用于生成“老师月度反馈加权统计”报表。核心流程是：

1. 用仓库 `data/local/` 中的反馈 CSV 和公共课表作为输入。
2. 运行 `scripts/monthly_teacher_feedback.py` 生成指定月份报表。
3. 在仓库 `outputs/teacher-feedback/<YYYY-MM>/` 下查看汇总表、文本反馈、未匹配反馈和 dashboard。

## 目录角色
- `data/local/teacher-feedback/feedback.csv`
  当前生效的反馈原始表，脚本默认读取这里。
- `data/local/shared/schedule.csv`
  当前生效的公共课表，课时账单、老师反馈和家长报告共用。
- `scripts/monthly_teacher_feedback.py`
  主脚本。不要随意改默认输入路径，除非 README 和本文件一起更新。
- `tests/test_monthly_teacher_feedback.py`
  主脚本的回归测试。
- `templates/name_mapping.csv`
  当前使用中的姓名映射表。发现别名问题时优先更新这里。
- `templates/name_mapping_template.csv`
  模板副本，用于新环境初始化参考。即使和现有映射内容相同，也建议保留。
- `outputs/teacher-feedback/<YYYY-MM>/`
  每个月的历史产出目录。属于业务结果，默认保留，不要当缓存删除。
- `docs/plans/`
  历次修改/设计记录。未来 AI 需要先看，避免重复探索。
- `README.md`
  人类执行版操作手册，包含口径、命令和检查步骤。

## 保留 / 可删规则

### 必须保留
- `data/local/teacher-feedback/feedback.csv`
- `data/local/shared/schedule.csv`
- `scripts/`
- `tests/`
- `templates/`
- `outputs/teacher-feedback/` 下的按月报表目录
- `README.md`
- `docs/plans/`

### 可以直接删除
- 任意位置的 `.DS_Store`
- 任意位置的 `__pycache__/`
- 未来如果出现 `.pytest_cache/`、临时日志、临时下载文件，也可以按“可再生缓存”处理

### 谨慎删除
- `outputs/teacher-feedback/<YYYY-MM>/`
  只有在该月报表已经确认无须追溯、且结果已在别处备份时才删除。
- `templates/name_mapping.csv`
  这是持续积累的清洗资产，除非明确重建，否则不要删。

## 给未来 AI 的执行约束
- 数据目录接口以仓库 `data/README.md` 为准；不要重新创建旧的根目录输入文件。
- 默认文件名是 `feedback.csv` 和 `schedule.csv`，如需临时读取其他文件应使用命令参数。
- 目录整理时，优先删除缓存和系统文件，不要先删业务产出。
- 如果新增参考文档，放到 `docs/`；如果是执行方案或变更计划，放到 `docs/plans/`。

## 标准复跑命令
在项目根目录执行：

```bash
python3 apps/teacher-feedback/scripts/monthly_teacher_feedback.py \
  --month 2026-03 \
  --feedback-start-date 2026-03-27 \
  --feedback-end-date 2026-04-12
```

如果只指定起始日，不指定结束日，脚本会统计到当前反馈文件里的最新记录。

## 每次复跑后至少检查
- `outputs/teacher-feedback/<YYYY-MM>/run_meta.json`
- `outputs/teacher-feedback/<YYYY-MM>/unmatched_feedback.csv`
- `outputs/teacher-feedback/<YYYY-MM>/teacher_summary.csv`
- `outputs/teacher-feedback/<YYYY-MM>/dashboard.html`

## 当前目录整理结论（2026-07-17）
- 原始输入已统一进入仓库 `data/local/`，不提交也不部署。
- 公共课表只有一份，避免多个副本内容不一致。
- 生成结果统一进入仓库 `outputs/teacher-feedback/`。
