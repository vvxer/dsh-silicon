/**
 * "硅基保留"模型提供方：把请求加上记忆后，转交给 DSH 里已经配好的 DeepSeek 路由（upstream）。
 * 鉴权、思考模式、工具调用、重试都沿用上游；会话标题、压缩摘要这类辅助调用原样转交，不加记忆、不记日志。
 * 只有选了本提供方的会话才会被记进原文日志，用 DSH 干别的活不会被记。
 */
import type { Context } from "@deepseek-ai/cordis";
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Memory } from "./memory.js";
export declare const PROVIDER = "silicon";
export declare class SiliconAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly memory;
    private readonly upstream;
    constructor(ctx: Context, memory: Memory, upstream: string);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
