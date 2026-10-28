/**
 * 夜间整理（与硅基保留 Python 版 nightly.py 的记忆部分逐条对应，提示词一字不改）：
 *   概况：涉及的自然周各写一行（≤60 字）→ memory/skeleton.json；一周聊天超过 8000 字的先逐天摘要（memory/day_notes.json）
 *   过完的月、年各写一行 → memory/rollup.json（概况太长时替换最早的周）
 *   相处习惯卡：新日子按周、每段 ≤20000 字喂给 DeepSeek 增量更新，最多 12 条、≤1000 字 → memory/habits.json
 * 进度记在 state.json 的 memory_until，只处理过完的日子。
 */
import { type Day } from "./when.js";
import type { Store } from "./store.js";
export type Ask = (prompt: string, maxTokens?: number) => Promise<string>;
export declare const HABITS_CAP = 1000;
export declare function dayLines(store: Store, day: Day): string[];
/** [日期, 各行] → 若干段文本，每段不超过 size 字，每天以 "== 日期 ==" 开头；一天被切开时，下一段开头补 "== 日期（续）=="。 */
export declare function pieces(days: [Day, string[]][], size: number): string[];
export declare function updateSkeleton(store: Store, days: Day[], ask: Ask, today: Day): Promise<void>;
export declare function updateRollup(store: Store, weeks: {
    from: string;
    to: string;
    line: string;
}[], ask: Ask, today: Day): Promise<void>;
/** 卡每轮都要发，必须封顶；模型常不守字数，超了按条目从后往前截（条目按重要程度排）。 */
export declare function capCard(card: string): string;
export declare function updateHabits(store: Store, days: Day[], ask: Ask, persona: string): Promise<void>;
/** 把还没整理过、已经过完的日子整理进记忆。返回整理了几天。 */
export declare function runNightly(store: Store, ask: Ask, today: Day, persona: string): Promise<number>;
