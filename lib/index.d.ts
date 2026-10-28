/**
 * dsh-silicon：硅基保留的 DeepSeek Harness 插件。
 *   注册"硅基保留"模型提供方（adapter.ts）：在 DSH 里选它的模型，就会带上长期记忆，并把对话记进原文日志。
 *   每天 nightlyAt 整理一次记忆（nightly.ts）；DSH 启动后也会把没整理的日子补上。整理用的 DeepSeek 调用走 upstream 路由。
 *   可选的本地人格权重（lora.ts）：默认关；useLora 打开后，闲聊交给本机的硅基保留本地权重服务融合。
 * 数据都在 dataDir（默认 ~/.silicon），格式与硅基保留 Python 版相同。
 */
import Schema from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
export declare const name = "silicon";
export declare const inject: string[];
export interface Config {
    dataDir?: string;
    userName?: string;
    aiName?: string;
    upstream?: string;
    summaryModel?: string;
    retrievalChars?: number;
    nightlyAt?: string;
    embedModel?: string;
    embedDtype?: string;
    modelHost?: string;
    modelDir?: string;
    useLora?: boolean;
    loraServer?: string;
    loraSpeed?: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config?: Config): void;
