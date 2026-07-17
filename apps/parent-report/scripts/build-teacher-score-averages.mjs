import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsv } from "@jingshi/billing-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const DEFAULT_INPUT_ROOT = path.resolve(REPO_ROOT, "outputs/teacher-feedback");
const DEFAULT_OUTPUT_JSON = path.resolve(APP_ROOT, "data/teacher-score-averages.json");
const DEFAULT_OUTPUT_CSV = path.resolve(APP_ROOT, "data/teacher-score-averages.csv");

const METRICS = [
  {
    key: "learning_effect",
    label: "学习提升效果",
    countColumn: "metric_learning_effect_total_value_count",
    averageColumn: "metric_learning_effect_total_raw_avg",
  },
  {
    key: "responsibility",
    label: "责任心与服务态度",
    countColumn: "metric_responsibility_total_value_count",
    averageColumn: "metric_responsibility_total_raw_avg",
  },
  {
    key: "charisma",
    label: "个人魅力",
    countColumn: "metric_charisma_total_value_count",
    averageColumn: "metric_charisma_total_raw_avg",
  },
];

function parseArgs(argv) {
  const options = {
    inputRoot: process.env.FEEDBACK_OUTPUT_ROOT || DEFAULT_INPUT_ROOT,
    outputJson: DEFAULT_OUTPUT_JSON,
    outputCsv: DEFAULT_OUTPUT_CSV,
    monthDirs: [],
    summaryCsvs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-root") {
      options.inputRoot = argv[++index];
    } else if (arg === "--output-json") {
      options.outputJson = argv[++index];
    } else if (arg === "--output-csv") {
      options.outputCsv = argv[++index];
    } else if (arg === "--summary-csv") {
      options.summaryCsvs.push(argv[++index]);
    } else {
      options.monthDirs.push(arg);
    }
  }

  return options;
}

function monthFromDir(dir) {
  return path.basename(path.resolve(dir));
}

function sourceFromMonthDir(dir) {
  return {
    month: monthFromDir(dir),
    summaryPath: path.join(dir, "teacher_summary.csv"),
  };
}

function sourceFromSummarySpec(spec) {
  const separatorIndex = spec.indexOf("=");
  if (separatorIndex > -1) {
    const month = spec.slice(0, separatorIndex).trim();
    const summaryPath = spec.slice(separatorIndex + 1).trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error(`Invalid summary month in --summary-csv: ${spec}`);
    }
    return { month, summaryPath: path.resolve(summaryPath) };
  }

  const summaryPath = path.resolve(spec);
  const parentMonth = path.basename(path.dirname(summaryPath));
  if (!/^\d{4}-\d{2}$/.test(parentMonth)) {
    throw new Error(
      `Cannot infer month for --summary-csv ${spec}; use YYYY-MM=/path/to/teacher_summary.csv`,
    );
  }
  return { month: parentMonth, summaryPath };
}

function listMonthDirs(inputRoot) {
  if (!fs.existsSync(inputRoot)) return [];
  return fs.readdirSync(inputRoot)
    .filter((entry) => /^\d{4}-\d{2}$/.test(entry))
    .map((entry) => path.join(inputRoot, entry))
    .filter((dir) => fs.existsSync(path.join(dir, "teacher_summary.csv")))
    .sort((a, b) => monthFromDir(a).localeCompare(monthFromDir(b)));
}

function normalizeSources(sources) {
  return sources
    .map((source) => {
      if (typeof source !== "string") {
        return {
          month: source.month,
          summaryPath: path.resolve(source.summaryPath),
        };
      }
      return sourceFromMonthDir(path.resolve(source));
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  if (value == null) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function displayScore(value) {
  return value == null ? "" : value.toFixed(1);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const text = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${text}\n`, "utf8");
}

export function buildTeacherScoreAverages(sources) {
  const teachers = new Map();
  const sourceMonths = [];
  const normalizedSources = normalizeSources(sources);

  for (const { month, summaryPath } of normalizedSources) {
    const rows = parseCsv(fs.readFileSync(summaryPath, "utf8"));
    sourceMonths.push(month);

    for (const row of rows) {
      const teacher = String(row.teacher || "").trim();
      if (!teacher) continue;
      if (!teachers.has(teacher)) {
        teachers.set(teacher, {
          teacher,
          monthRows: new Set(),
          metrics: Object.fromEntries(METRICS.map((metric) => [metric.label, {
            weightedSum: 0,
            valueCount: 0,
            months: [],
          }])),
        });
      }

      const teacherEntry = teachers.get(teacher);
      teacherEntry.monthRows.add(month);

      for (const metric of METRICS) {
        const valueCount = toNumber(row[metric.countColumn]) || 0;
        const average = toNumber(row[metric.averageColumn]);
        if (valueCount <= 0 || average == null) continue;

        const metricEntry = teacherEntry.metrics[metric.label];
        metricEntry.weightedSum += average * valueCount;
        metricEntry.valueCount += valueCount;
        metricEntry.months.push({
          month,
          valueCount,
          average: round(average),
        });
      }
    }
  }

  return [...teachers.values()]
    .map((teacherEntry) => {
      const metrics = Object.fromEntries(METRICS.map((metric) => {
        const metricEntry = teacherEntry.metrics[metric.label];
        const weightedAverage = metricEntry.valueCount > 0
          ? metricEntry.weightedSum / metricEntry.valueCount
          : null;
        return [metric.label, {
          weightedAverage: round(weightedAverage),
          displayScore: displayScore(weightedAverage),
          valueCount: metricEntry.valueCount,
          monthsWithScore: metricEntry.months.length,
          months: metricEntry.months,
        }];
      }));
      const monthsWithAnyScore = new Set(Object.values(metrics)
        .flatMap((metric) => metric.months.map((monthEntry) => monthEntry.month)));
      return {
        teacher: teacherEntry.teacher,
        monthsObserved: teacherEntry.monthRows.size,
        monthsWithAnyScore: monthsWithAnyScore.size,
        metrics,
      };
    })
    .filter((teacherEntry) => teacherEntry.monthsWithAnyScore > 0)
    .sort((a, b) => a.teacher.localeCompare(b.teacher, "zh-CN"));
}

function buildCsvRows(teacherScores) {
  const header = [
    "老师",
    ...METRICS.map((metric) => metric.label),
    "统计月份数",
    ...METRICS.flatMap((metric) => [
      `${metric.label}有效评分数`,
      `${metric.label}统计月份数`,
      `${metric.label}原始加权平均`,
    ]),
  ];

  return [
    header,
    ...teacherScores.map((teacher) => [
      teacher.teacher,
      ...METRICS.map((metric) => teacher.metrics[metric.label].displayScore),
      teacher.monthsWithAnyScore,
      ...METRICS.flatMap((metric) => {
        const value = teacher.metrics[metric.label];
        return [
          value.valueCount,
          value.monthsWithScore,
          value.weightedAverage ?? "",
        ];
      }),
    ]),
  ];
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const monthDirs = options.monthDirs.length
    ? options.monthDirs.map((dir) => path.resolve(dir))
    : listMonthDirs(options.inputRoot);
  const sources = [
    ...monthDirs.map(sourceFromMonthDir),
    ...options.summaryCsvs.map(sourceFromSummarySpec),
  ];

  if (!sources.length) {
    console.error(`No teacher_summary.csv files found under ${options.inputRoot}`);
    process.exitCode = 1;
    return;
  }

  const teacherScores = buildTeacherScoreAverages(sources);
  const sourceMonths = normalizeSources(sources).map((source) => source.month);
  const output = {
    generatedAt: new Date().toISOString(),
    sourceMonths,
    weighting: "每个维度按 teacher_summary.csv 中对应 total_value_count 加权；value_count=0 的月份不参与该维度平均。",
    metrics: METRICS.map(({ label, countColumn, averageColumn }) => ({
      label,
      countColumn,
      averageColumn,
    })),
    teachers: teacherScores,
  };

  fs.mkdirSync(path.dirname(options.outputJson), { recursive: true });
  fs.writeFileSync(options.outputJson, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeCsv(options.outputCsv, buildCsvRows(teacherScores));

  console.log(`Read ${sourceMonths.length} months: ${sourceMonths.join(", ")}`);
  console.log(`Wrote ${teacherScores.length} teacher score averages`);
  console.log(options.outputJson);
  console.log(options.outputCsv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
