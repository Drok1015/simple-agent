import { describe, expect, it } from "vitest";

import { DemoBusinessBackend } from "../src/mcp/backend.js";

describe("DemoBusinessBackend", () => {
  it("按订单号查询", () => {
    const result = new DemoBusinessBackend().queryOrders("SO-1001");
    expect(result.count).toBe(1);
    expect(result.items[0]?.customer_name).toBe("青岛示例工厂");
  });

  it("按客户名称查询", () => {
    const result = new DemoBusinessBackend().queryOrders("青岛");
    expect(result.count).toBe(1);
    expect(result.items[0]?.order_id).toBe("SO-1001");
  });

  it("草稿只生成预览", () => {
    const result = new DemoBusinessBackend().prepareAssetDraft("SO-1001", {
      asset_name: "空压机 A",
    });
    expect("valid" in result && result.valid).toBe(true);
    expect("draft" in result && result.draft.asset_name).toBe("空压机 A");
    expect("submitted" in result && result.submitted).toBe(false);
  });

  it("拒绝未知字段", () => {
    const result = new DemoBusinessBackend().prepareAssetDraft("SO-1001", { admin: true });
    expect("valid" in result && result.valid).toBe(false);
    expect("errors" in result && result.errors).toEqual(["未知字段：admin"]);
  });
});
