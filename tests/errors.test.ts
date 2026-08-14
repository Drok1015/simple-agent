import { describe, expect, it } from "vitest";

import { toPublicAgentError } from "../src/errors.js";

describe("toPublicAgentError", () => {
  it("隐藏模型限流错误的内部链接", () => {
    const message = toPublicAgentError(
      new Error("429 Too many requests https://docs.example.com/internal"),
    );

    expect(message).toBe("模型请求过于频繁，请稍后重试");
  });
});
