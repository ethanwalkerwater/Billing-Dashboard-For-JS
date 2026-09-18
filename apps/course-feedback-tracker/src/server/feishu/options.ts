import { canonicalizeName } from "../../domain";
import { FeishuSchemaError } from "./errors";
import type { FeishuField, FeishuFieldOption } from "./types";

export interface FieldOptionAppendPlan {
  field: FeishuField;
  existingNames: string[];
  missingNames: string[];
  nextOptions: FeishuFieldOption[];
}

export function planSelectOptionAppend(input: {
  fields: FeishuField[];
  fieldName: string;
  requiredNames: string[];
}): FieldOptionAppendPlan {
  const field = input.fields.find((candidate) => candidate.field_name === input.fieldName);
  if (!field) {
    throw new FeishuSchemaError({ recordId: "字段配置", fieldName: input.fieldName, message: "不存在" });
  }
  const options = field.property?.options;
  if (!Array.isArray(options)) {
    throw new FeishuSchemaError({
      recordId: "字段配置",
      fieldName: input.fieldName,
      message: "不是可维护选项的单选/多选字段",
    });
  }

  const existingNames = options.map((option) => canonicalizeName(option.name)).filter(Boolean);
  const existingSet = new Set(existingNames);
  const missingNames = [
    ...new Set(input.requiredNames.map(canonicalizeName).filter(Boolean).filter((name) => !existingSet.has(name))),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const nextOptions = [
    ...options,
    ...missingNames.map((name, index) => ({ name, color: index % 54 })),
  ];
  return { field, existingNames, missingNames, nextOptions };
}

