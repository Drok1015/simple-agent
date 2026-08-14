export function toPublicAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("429") || message.toLowerCase().includes("rate limit")) {
    return "模型请求过于频繁，请稍后重试";
  }
  if (message.includes("401")) {
    return "模型鉴权失败，请检查 API Key";
  }
  if (message.includes("403")) {
    return "当前 API Key 没有模型调用权限";
  }
  if (message.toLowerCase().includes("timeout")) {
    return "模型调用超时，请稍后重试";
  }

  return message;
}
