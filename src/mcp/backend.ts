export interface Order {
  order_id: string;
  customer_name: string;
  project_name: string;
  status: string;
  amount: number;
}

type FieldRule = {
  type: "string" | "number";
  required: boolean;
  max_length?: number;
  minimum?: number;
  options?: string[];
};

const orders: Order[] = [
  {
    order_id: "SO-1001",
    customer_name: "青岛示例工厂",
    project_name: "空压机节能改造",
    status: "待资产申报",
    amount: 268000,
  },
  {
    order_id: "SO-1002",
    customer_name: "上海示例园区",
    project_name: "暖通设备更新",
    status: "执行中",
    amount: 186000,
  },
];

const formSchema = {
  schema_version: "asset-declaration.v1",
  fields: {
    asset_name: { type: "string", required: true, max_length: 100 },
    asset_category: {
      type: "string",
      required: true,
      options: ["生产设备", "动力设备", "办公设备"],
    },
    amount: { type: "number", required: true, minimum: 0 },
    project_name: { type: "string", required: true, max_length: 200 },
  } satisfies Record<string, FieldRule>,
};

export class DemoBusinessBackend {
  queryOrders(query: string) {
    const normalized = query.trim().toLowerCase();
    const items = orders.filter(
      (order) =>
        !normalized ||
        order.order_id.toLowerCase().includes(normalized) ||
        order.customer_name.toLowerCase().includes(normalized) ||
        order.project_name.toLowerCase().includes(normalized),
    );
    return { items: structuredClone(items), count: items.length };
  }

  getAssetForm(orderId: string) {
    const order = orders.find((item) => item.order_id === orderId);
    if (!order) {
      return { found: false as const, order_id: orderId, reason: "订单不存在" };
    }

    const suggestedValues = {
      asset_name: order.project_name,
      asset_category: "生产设备",
      amount: order.amount,
      project_name: order.project_name,
    };

    return {
      found: true as const,
      order: structuredClone(order),
      schema: structuredClone(formSchema),
      suggested_values: suggestedValues,
      provenance: Object.fromEntries(Object.keys(suggestedValues).map((key) => [key, "order"])),
    };
  }

  prepareAssetDraft(orderId: string, fields: Record<string, unknown>) {
    const form = this.getAssetForm(orderId);
    if (!form.found) return form;

    const schemaFields: Record<string, FieldRule> = formSchema.fields;
    const unknownFields = Object.keys(fields)
      .filter((field) => !(field in schemaFields))
      .sort();
    if (unknownFields.length > 0) {
      return {
        valid: false as const,
        errors: unknownFields.map((field) => `未知字段：${field}`),
      };
    }

    const draft: Record<string, unknown> = { ...form.suggested_values, ...fields };
    const errors: string[] = [];

    for (const [fieldName, rules] of Object.entries(schemaFields)) {
      const value = draft[fieldName];
      if (rules.required && (value === undefined || value === null || value === "")) {
        errors.push(`${fieldName} 为必填字段`);
      }
      if (rules.options && !rules.options.includes(String(value))) {
        errors.push(`${fieldName} 必须是：${rules.options.join("、")}`);
      }
      if (rules.type === "number" && typeof value !== "number") {
        errors.push(`${fieldName} 必须是数字`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      order_id: orderId,
      schema_version: formSchema.schema_version,
      draft,
      submitted: false,
      next_action: "请用户逐字段确认后，由原业务系统正式提交",
    };
  }
}
