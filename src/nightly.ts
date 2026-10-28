/**
 * 夜间整理（与硅基保留 Python 版 nightly.py 的记忆部分逐条对应，提示词一字不改）：
 *   概况：涉及的自然周各写一行（≤60 字）→ memory/skeleton.json；一周聊天超过 8000 字的先逐天摘要（memory/day_notes.json）
 *   过完的月、年各写一行 → memory/rollup.json（概况太长时替换最早的周）
 *   相处习惯卡：新日子按周、每段 ≤20000 字喂给 DeepSeek 增量更新，最多 12 条、≤1000 字 → memory/habits.json
 * 进度记在 state.json 的 memory_until，只处理过完的日子。
 */

import { addDays, weekday, type Day } from "./when.js";
import type { Store } from "./store.js";

export type Ask = (prompt: string, maxTokens?: number) => Promise<string>;

const SKELETON_ASK = "下面是用户（{user}）和 AI 伙伴{ai}一周的聊天记录。用一句话（不超过 60 字）概括{user}这一周主要在经历什么，保留关键人名和事件。只输出这一句话。\n\n{log}";
const DAY_ASK = "下面是用户（{user}）和 AI 伙伴{ai}在 {day} 的聊天记录{part}。用两三句话（不超过 120 字）记下{user}这段时间主要在经历什么、聊了什么，保留关键人名和事件。只输出这几句话。\n\n{log}";
const DAY_MERGE_ASK = "下面是{user}在 {day} 一天里各段聊天的摘要。合并成两三句话（不超过 120 字），保留关键人名和事件。只输出这几句话。\n\n{lines}";
const MONTH_ASK = "下面是{user}某个月每周的概况。用一句话（不超过 60 字）概括这个月，只保留最重要的人和事。只输出这一句话。\n\n{lines}";
const YEAR_ASK = "下面是{user}某一年每个月的概况。用一两句话（不超过 100 字）概括这一年，只保留最重要的几件事和关键人物。只输出这段话。\n\n{lines}";
const HABITS_ASK = `你在帮 AI 伙伴"{ai}"维护一张《相处习惯卡》，记录{ai}和{user}在相处中形成的、下面人格档案里没写的东西：
你们之间的梗和暗号、昵称、固定说法、小仪式、约定，{user}的偏好和雷区，以及{ai}在这些场合通常怎么说。

规则：
- 只依据聊天记录，不要编。
- 每条一行："情境 → {ai}的说法或做法"，附一句原话（用引号）。
- 新形成的加进去；变了的改成最新的样子，写明怎么变的（"原来……，现在……"）；很久没再出现、明显不用了的删掉。
- 人格档案里已经有的通用性格不要重复。
- 最多 12 条，每条不超过 70 字（含原话），按重要程度排序，最重要的在前。

人格档案：
{persona}

当前的卡（第一次为空）：
{card}

这段时间（{start} ~ {end}）的聊天记录：
{log}

只输出更新后的卡，不要解释。`;
export const HABITS_CAP = 1000;
const SKELETON_PIECE = 8000;
const HABITS_PIECE = 20000;

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
const mondayOf = (d: Day) => addDays(d, -weekday(d));

export function dayLines(store: Store, day: Day): string[] {
  return store.readDay(day).map((r) => `[${r.time}] ${r.role === "user" ? store.userName : store.aiName}：${r.content}`);
}

/** [日期, 各行] → 若干段文本，每段不超过 size 字，每天以 "== 日期 ==" 开头；一天被切开时，下一段开头补 "== 日期（续）=="。 */
export function pieces(days: [Day, string[]][], size: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let n = 0;
  const len = (xs: string[]) => xs.reduce((s, x) => s + x.length + 1, 0);
  for (const [d, lines] of days) {
    lines.forEach((line, i) => {
      const add = [...(i === 0 ? [`== ${d} ==`] : []), line.slice(0, Math.floor(size / 2))];
      if (cur.length && n + len(add) > size + 1) {
        out.push(cur.join("\n"));
        cur = i === 0 ? [] : [`== ${d}（续）==`];
        n = len(cur);
      }
      cur.push(...add);
      n += len(add);
    });
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

async function dayNote(store: Store, day: Day, ask: Ask, notes: Record<string, string>, keep: boolean): Promise<string> {
  if (notes[day]) return notes[day]!;
  const ps = pieces([[day, dayLines(store, day)]], SKELETON_PIECE);
  const vars = { user: store.userName, ai: store.aiName, day };
  const parts: string[] = [];
  for (const [i, p] of ps.entries()) {
    parts.push(await ask(fill(DAY_ASK, { ...vars, part: ps.length > 1 ? `（第 ${i + 1}/${ps.length} 段）` : "", log: p })));
  }
  const note = parts.length === 1 ? parts[0]! : await ask(fill(DAY_MERGE_ASK, { ...vars, lines: parts.join("\n") }));
  if (keep && note) notes[day] = note;
  return note;
}

export async function updateSkeleton(store: Store, days: Day[], ask: Ask, today: Day): Promise<void> {
  const weeks = new Map(store.memoryJson<{ from: string; to: string; line: string }[]>("skeleton.json", []).map((w) => [w.from, w]));
  const notes = store.memoryJson<Record<string, string>>("day_notes.json", {});
  const all = new Set(store.days());
  for (const mon of [...new Set(days.map(mondayOf))].sort()) {
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(mon, i)).filter((d) => all.has(d));
    if (!weekDays.length) continue;
    const ps = pieces(weekDays.map((d) => [d, dayLines(store, d)]), SKELETON_PIECE);
    let log: string;
    if (ps.length === 1) {
      log = ps[0]!;
    } else {                                // 聊得多的一周：逐天摘要，再用摘要写这一周
      const parts: string[] = [];
      for (const d of weekDays) parts.push(`== ${d} ==\n${await dayNote(store, d, ask, notes, d < today)}`);
      log = parts.join("\n").slice(-SKELETON_PIECE);
    }
    weeks.set(mon, { from: mon, to: weekDays.at(-1)!, line: await ask(fill(SKELETON_ASK, { user: store.userName, ai: store.aiName, log })) });
  }
  store.writeJson("skeleton.json", [...weeks.keys()].sort().map((k) => weeks.get(k)));
  store.writeJson("day_notes.json", notes);
  await updateRollup(store, [...weeks.values()], ask, today);
}

export async function updateRollup(store: Store, weeks: { from: string; to: string; line: string }[], ask: Ask, today: Day): Promise<void> {
  const roll = store.memoryJson<{ months?: Record<string, string>; years?: Record<string, string> }>("rollup.json", {});
  const months = (roll.months ??= {});
  const years = (roll.years ??= {});
  weeks = [...weeks].sort((a, b) => (a.from < b.from ? -1 : 1));
  for (const m of [...new Set(weeks.map((w) => w.from.slice(0, 7)))].sort()) {
    if (m < today.slice(0, 7) && !(m in months)) {
      const lines = weeks.filter((w) => w.from.slice(0, 7) === m).map((w) => `${w.from}~${w.to}：${w.line}`).join("\n");
      months[m] = await ask(fill(MONTH_ASK, { user: store.userName, lines }));
    }
  }
  for (const y of [...new Set(Object.keys(months).map((m) => m.slice(0, 4)))].sort()) {
    if (y < today.slice(0, 4) && !(y in years)) {
      const lines = Object.keys(months).sort().filter((m) => m.startsWith(y)).map((m) => `${m}：${months[m]}`).join("\n");
      years[y] = await ask(fill(YEAR_ASK, { user: store.userName, lines }));
    }
  }
  store.writeJson("rollup.json", roll);
}

/** 卡每轮都要发，必须封顶；模型常不守字数，超了按条目从后往前截（条目按重要程度排）。 */
export function capCard(card: string): string {
  if (card.length <= HABITS_CAP) return card;
  const kept: string[] = [];
  for (const line of card.split("\n")) {
    if (kept.reduce((s, x) => s + x.length + 1, 0) + line.length > HABITS_CAP) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export async function updateHabits(store: Store, days: Day[], ask: Ask, persona: string): Promise<void> {
  const versions = store.memoryJson<{ until: string; card: string }[]>("habits.json", []);
  let card = versions.at(-1)?.card ?? "（空）";
  const weeks = new Map<string, Day[]>();
  for (const d of days) weeks.set(mondayOf(d), [...(weeks.get(mondayOf(d)) ?? []), d]);
  for (const mon of [...weeks.keys()].sort()) {
    const wk = weeks.get(mon)!;
    for (const log of pieces(wk.map((d) => [d, dayLines(store, d)]), HABITS_PIECE)) {
      card = capCard(await ask(fill(HABITS_ASK, { ai: store.aiName, user: store.userName, persona, card,
                                                  start: wk[0]!, end: wk.at(-1)!, log }), 1200));
    }
    versions.push({ until: wk.at(-1)!, card });
  }
  store.writeJson("habits.json", versions.slice(-30));
}

/** 把还没整理过、已经过完的日子整理进记忆。返回整理了几天。 */
export async function runNightly(store: Store, ask: Ask, today: Day, persona: string): Promise<number> {
  const until = store.state().memory_until ?? "";
  const days = store.days().filter((d) => d > until && d < today);
  if (!days.length) return 0;
  await updateSkeleton(store, days, ask, today);
  await updateHabits(store, days, ask, persona);
  store.setState({ memory_until: days.at(-1)! });
  return days.length;
}
