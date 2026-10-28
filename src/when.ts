/**
 * 日期工具和时间说法解析（与硅基保留 Python 版 memory.py 的 parse_when 逐条对应）。
 * 日期一律用 "YYYY-MM-DD" 字符串，按字典序比较就是按时间比较。
 */

export type Day = string;

export const WEEK = "一二三四五六日";
const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地时间的日期。 */
export function dayOf(t: Date): Day {
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

export function hhmm(t: Date): string {
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** 用户消息前的时间戳 "[星期二 21:05]"（与 Python 版 memory.stamp 相同）。 */
export function stamp(t: Date): string {
  return `[星期${WEEK[(t.getDay() + 6) % 7]} ${hhmm(t)}]`;
}

function toUtc(d: Day): number {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd);
}

export function addDays(d: Day, n: number): Day {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 星期一 = 0 … 星期日 = 6。 */
export function weekday(d: Day): number {
  return (new Date(toUtc(d)).getUTCDay() + 6) % 7;
}

export function daysBetween(a: Day, b: Day): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 合法日期才返回（2 月 30 日之类返回 null，和 Python 的 date() 抛错对应）。 */
function mk(y: number, m: number, d: number): Day | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function cn2int(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.startsWith("十")) return 10 + (s.length > 1 ? CN_NUM[s.slice(1)] ?? 0 : 0);
  if (s.includes("十")) {
    const [a = "", b = ""] = s.split("十");
    return (CN_NUM[a] ?? 0) * 10 + (b ? CN_NUM[b] ?? 0 : 0);
  }
  return CN_NUM[s] ?? 0;
}

/** 从一句话里找时间说法，返回 [起, 止] 日期闭区间；找不到返回 null。 */
export function parseWhen(text: string, now: Day): [Day, Day] | null {
  if (!text) return null;
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = mk(+m[1]!, +m[2]!, +m[3]!);
    if (d) return [d, d];
  }
  m = text.match(/(\d{1,2}|[一二三四五六七八九十]+)月(\d{1,2}|[一二三四五六七八九十]+)[日号]/);
  if (m) {
    const d = mk(+now.slice(0, 4), cn2int(m[1]!), cn2int(m[2]!));
    if (d) return [d, d];
  }
  m = text.match(/(上个?月|这个?月|本月)(初|上旬|中旬|下旬|底|末)?/);
  if (m) {
    const thisFirst = `${now.slice(0, 7)}-01`;
    const first = m[1]!.startsWith("上") ? `${addDays(thisFirst, -1).slice(0, 7)}-01` : thisFirst;
    const last = addDays(`${addDays(`${first.slice(0, 8)}28`, 4).slice(0, 7)}-01`, -1);
    const lastDay = +last.slice(8);
    const parts: Record<string, [number, number]> = {
      初: [1, 10], 上旬: [1, 10], 中旬: [11, 20], 下旬: [21, lastDay], 底: [21, lastDay], 末: [21, lastDay],
    };
    const [a, b] = parts[m[2] ?? ""] ?? [1, lastDay];
    return [`${first.slice(0, 8)}${pad(a)}`, `${first.slice(0, 8)}${pad(b)}`];
  }
  for (const [w, n] of [["大前天", 3], ["前天", 2], ["昨天", 1], ["昨晚", 1]] as const) {
    if (text.includes(w)) {
      const d = addDays(now, -n);
      return [d, d];
    }
  }
  m = text.match(/(\d+|[一二三四五六七八九十两]+)天前/);
  if (m) {
    const d = addDays(now, -cn2int(m[1]!));
    return [d, d];
  }
  const mon = addDays(now, -weekday(now));
  m = text.match(/(上上|上)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])?/);
  if (m) {
    const start = addDays(mon, -7 * (m[1] === "上上" ? 2 : 1));
    if (m[2]) {
      const d = addDays(start, "日天".includes(m[2]) ? 6 : "一二三四五六".indexOf(m[2]));
      return [d, d];
    }
    return [start, addDays(start, 6)];
  }
  return null;
}
