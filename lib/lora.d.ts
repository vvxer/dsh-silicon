/**
 * 可选的本地人格权重：把闲聊转给本机的硅基保留本地权重服务（Python 版，python -m silicon.lora_server），
 * DeepSeek 写内容，本地 2B + LoRA 按她的说话方式改写。服务没开、还没烘焙或者正在夜间巩固，就退回普通 DeepSeek。
 * 融合只出文字、不会调用工具，所以带工具的会话里，像是让她干活的消息（写、查、代码……）照常走 DeepSeek；
 * 工具调用之后的步骤也走 DeepSeek。融合固定用 DeepSeek 的非思考模式（要用候选词的概率）。
 */
import type { RequestMessage, StreamChunk } from "@deepseek-ai/dsh-llm";
export interface Plain {
    role: "system" | "user" | "assistant";
    content: string;
}
/**
 * 这一步走不走融合：一轮的第一步（用户本人最后那句话之后还没有她的回答和工具结果；DSH 可能在后面附上下文快照），
 * 而且会话里有工具时，这句话不像是要她干活。
 */
export declare function wantsFusion(messages: readonly RequestMessage[], hasTools: boolean): boolean;
/** 发给 DeepSeek 的纯文字消息：工具调用、工具结果、思考过程都去掉（融合这一步只聊天）。 */
export declare function plain(messages: readonly RequestMessage[]): Plain[];
/**
 * 本地模型看的对话：只有用户和她的原话，不带系统提示和记忆；用户的话前面加上时间，和夜间巩固训练时的格式一样。
 * times：消息 id → 记日志的时间（插件装上之前的消息没有，就不加时间）。
 */
export declare function localView(messages: readonly RequestMessage[], times: ReadonlyMap<string, number>): Plain[];
export declare class Lora {
    readonly server: string;
    readonly speed: string;
    private readonly log;
    private lastWarning;
    constructor(server: string, speed: string, log: (msg: string) => void);
    /** 开始一次融合，等到第一个事件。服务用不了（没开、没烘焙、夜间巩固中、出错）返回 null，由调用方改走普通 DeepSeek。 */
    start(messages: Plain[], local: Plain[], signal?: AbortSignal): Promise<AsyncIterable<StreamChunk> | null>;
    private chunks;
}
