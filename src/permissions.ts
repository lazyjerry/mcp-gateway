// 權限判斷的唯一來源：tools/list 的過濾與 tools/call 前的檢查都用這裡
import type { ToolDefinition } from './services';

/** 這個 tool 還缺哪些範圍；空陣列代表可以列出、可以執行 */
export function missingScopes(tool: ToolDefinition, granted: readonly string[]): string[] {
  return [...new Set(tool.scopes)].filter((scope) => !granted.includes(scope));
}

/** 列表與呼叫的條件相同：tool 宣告的範圍都要有 */
export function canUse(tool: ToolDefinition, granted: readonly string[]): boolean {
  return missingScopes(tool, granted).length === 0;
}
