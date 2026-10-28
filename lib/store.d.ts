/**
 * 记忆存储：原文永久保存（每天一个 JSONL，只追加），按"一问一答"切块做向量检索，按时间说法过滤。
 * 目录结构和日志格式与硅基保留 Python 版相同（logs/、memory/、state.json），两边可以共用一份数据：
 *   logs/YYYY-MM-DD.jsonl    {"time": "HH:MM", "role": "user"|"assistant", "content": "...", "id"?: DSH 消息 id}
 *   memory/skeleton.json     每周一行概况；memory/rollup.json 月、年概况；memory/habits.json 相处习惯卡各版本
 *   memory/emb-node.*        本插件的向量缓存（Python 版用自己的 emb.pt，互不影响）
 */
import { type Day } from "./when.js";
import type { Embedder } from "./embed.js";
export declare const QUERY_PREFIX = "\u4E3A\u8FD9\u4E2A\u53E5\u5B50\u751F\u6210\u8868\u793A\u4EE5\u7528\u4E8E\u68C0\u7D22\u76F8\u5173\u6587\u7AE0\uFF1A";
export declare const SKELETON_CAP = 1200;
export interface LogRecord {
    time: string;
    role: "user" | "assistant";
    content: string;
    id?: string;
}
export interface Chunk {
    key: string;
    date: Day;
    time: string;
    at: number;
    lines: string[];
    /** 这一块里各条消息的 DSH 消息 id（已在当前上下文里的块检索时要跳过）。 */
    ids: string[];
    plain: string;
    text: string;
}
export declare class Store {
    readonly dir: string;
    readonly userName: string;
    readonly aiName: string;
    readonly logs: string;
    readonly mem: string;
    chunks: Chunk[];
    private vecs;
    private unsaved;
    /** 已记入日志的 DSH 消息 id → 记录时间（毫秒）：防止同一条消息记两遍，本地权重也用它给用户的话加时间。 */
    readonly seen: Map<string, number>;
    constructor(dir: string, userName: string, aiName: string);
    append(role: LogRecord["role"], content: string, t?: Date, id?: string): void;
    days(): Day[];
    readDay(day: Day): LogRecord[];
    private add;
    private loadVecs;
    private flush;
    private ensureVecs;
    /** 关闭前把还没写盘的向量写下来（没写的下次启动会重算，不会出错，只是慢一点）。 */
    close(): void;
    /**
     * 按用户原话检索原文：话里有时间说法就只在那段时间里找；按相似度排，按字数预算打包，按时间顺序输出。
     * hide 里的消息已经在本次请求的上下文里，含有它们的块不再重复取；now 之后的记录一律不取。
     */
    retrieve(embed: Embedder, query: string, now: Date, budget: number, hide: ReadonlySet<string>): Promise<string>;
    private readJson;
    writeJson(name: string, value: unknown): void;
    memoryJson<T>(name: string, fallback: T): T;
    /** 相处习惯卡的最新版。 */
    habits(): string;
    /** 分层概况：每周一行；超过 cap 时从最早的开始把整月换成月概况，还超就把整年换成年概况。 */
    skeleton(cap?: number): string;
    state(): Record<string, string>;
    setState(patch: Record<string, string>): void;
}
