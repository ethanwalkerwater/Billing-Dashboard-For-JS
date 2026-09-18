import type { FeishuClient } from "./client";
import { FeishuApiError } from "./errors";
import { planSelectOptionAppend } from "./options";

export async function ensureSelectFieldOptions(input: {
  client: Pick<FeishuClient, "listAllFields" | "updateFieldOptions">;
  appToken: string;
  tableId: string;
  fieldName: string;
  requiredNames: string[];
}): Promise<{ addedNames: string[]; totalOptions: number }> {
  const fields = await input.client.listAllFields(input);
  const plan = planSelectOptionAppend({
    fields,
    fieldName: input.fieldName,
    requiredNames: input.requiredNames,
  });
  if (plan.missingNames.length === 0) {
    return { addedNames: [], totalOptions: plan.nextOptions.length };
  }

  await input.client.updateFieldOptions({
    appToken: input.appToken,
    tableId: input.tableId,
    field: plan.field,
    options: plan.nextOptions,
  });
  const verifiedFields = await input.client.listAllFields(input);
  const verification = planSelectOptionAppend({
    fields: verifiedFields,
    fieldName: input.fieldName,
    requiredNames: input.requiredNames,
  });
  if (verification.missingNames.length > 0) {
    throw new FeishuApiError(`飞书“${input.fieldName}”选项写入后复核失败：仍缺 ${verification.missingNames.length} 项`);
  }
  return { addedNames: plan.missingNames, totalOptions: verification.nextOptions.length };
}

