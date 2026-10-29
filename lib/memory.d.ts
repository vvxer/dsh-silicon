/**
 * 把记忆接到一次模型请求上（只改这一次请求，不写进 DSH 的会话历史）：
 *   固定段（习惯卡 + 分层概况）：紧跟在系统提示之后。每晚才变，前缀一天内不变，能命中 DeepSeek 的缓存。
 *   尾段（现在时间 + 认识第几天 + 这句话相关的原文 + 规则）：放在最后一条用户消息之前，只有这一小段和最后一轮不命中缓存。
 * 同时把这一轮新发的用户消息记进原文日志；她的回答由适配器在流结束后记。
 */
import type { RequestMessage } from "@deepseek-ai/dsh-llm";
import type { Store } from "./store.js";
import type { Embedder } from "./embed.js";
export interface MemoryOptions {
    retrievalChars: number;
}
type Msg = RequestMessage;
export declare function textOf(m: Msg): string;
/** 配置 userSources：另外当作用户本人消息的来源 kind（桥接插件自己起的名字）。 */
export declare function acceptSources(kinds: readonly string[]): void;
/**
 * 用户本人发的消息（不是压缩摘要、DSH 插进来的上下文或仅供请求的输入）。
 * DSH 网页和命令行发的是 kind "user"；QQ 等桥接插件转进来的，有的也是 "user"，有的是 "plugin" 或 "plugin:插件名"
 * （dsh-im-qq、dsh-napcat、dsh-onebot）。DSH 自己插的上下文（时间、快照、计划模式……）各有自己的 kind，有的还带 form。
 */
export declare function isRealUser(m: Msg): boolean;
export declare class Memory {
    readonly store: Store;
    readonly embed: Embedder;
    readonly opts: MemoryOptions;
    /** 用户消息 id → 这条消息的尾段，同一轮里的多个步骤复用，前缀保持稳定。 */
    private tails;
    private personaHash;
    constructor(store: Store, embed: Embedder, opts: MemoryOptions);
    /** 记下这一轮新发的用户消息：最后一条她的回答之后的那些。更早的（插件装上之前的、续聊的旧会话）不补记，免得时间记错。 */
    capture(messages: readonly Msg[], now: Date): void;
    /** 习惯卡整理时要对照人格档案，免得把人格卡里已有的性格重复写进卡。DSH 里人格写在系统提示里，记下最近一次的。 */
    rememberPersona(messages: readonly Msg[]): void;
    persona(): string;
    staticBlock(): string;
    tailBlock(query: string, now: Date, hide: ReadonlySet<string>): Promise<string>;
    /** 返回加上记忆的新消息列表（原列表是冻结的，不改它）。检索失败时只少尾段里的原文，不影响回答。 */
    decorate(messages: readonly Msg[], now: Date): Promise<Msg[]>;
}
export {};
