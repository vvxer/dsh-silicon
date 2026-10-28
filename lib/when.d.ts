/**
 * 日期工具和时间说法解析（与硅基保留 Python 版 memory.py 的 parse_when 逐条对应）。
 * 日期一律用 "YYYY-MM-DD" 字符串，按字典序比较就是按时间比较。
 */
export type Day = string;
export declare const WEEK = "\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u65E5";
/** 本地时间的日期。 */
export declare function dayOf(t: Date): Day;
export declare function hhmm(t: Date): string;
export declare function addDays(d: Day, n: number): Day;
/** 星期一 = 0 … 星期日 = 6。 */
export declare function weekday(d: Day): number;
export declare function daysBetween(a: Day, b: Day): number;
export declare function cn2int(s: string): number;
/** 从一句话里找时间说法，返回 [起, 止] 日期闭区间；找不到返回 null。 */
export declare function parseWhen(text: string, now: Day): [Day, Day] | null;
