/**
 * "硅基保留"模型提供方：把请求加上记忆后，转交给 DSH 里已经配好的 DeepSeek 路由（upstream）。
 * 鉴权、思考模式、工具调用、重试都沿用上游；会话标题、压缩摘要这类辅助调用原样转交，不加记忆、不记日志。
 * 只有选了本提供方的会话才会被记进原文日志，用 DSH 干别的活不会被记。
 * 开了本地权重（lora）时，闲聊改由本地权重服务融合（见 lora.ts），服务用不了就照常转交上游。
 */
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { localView, plain, wantsFusion } from "./lora.js";
export const PROVIDER = "silicon";
export class SiliconAdapter extends LlmAdapter {
    ctx;
    memory;
    upstream;
    lora;
    constructor(ctx, memory, upstream, lora) {
        super();
        this.ctx = ctx;
        this.memory = memory;
        this.upstream = upstream;
        this.lora = lora;
    }
    providerInfo(provider) {
        return { id: provider, name: "硅基保留" };
    }
    async listModels(provider) {
        const models = await this.ctx.llm.listModels(this.upstream);
        return models.map((m) => ({ ...m, provider, name: `硅基保留 · ${m.name}` }));
    }
    async resolveModel(provider, model, signal) {
        const info = await this.ctx.llm.resolveModelInfo(this.upstream, model, signal);
        return { ...info, provider, name: `硅基保留 · ${info.name}` };
    }
    async *stream(options) {
        if (options.purpose) {
            yield* this.ctx.llm.stream({ ...options, provider: this.upstream });
            return;
        }
        const now = new Date();
        let messages = options.messages;
        try {
            this.memory.rememberPersona(messages);
            this.memory.capture(messages, now);
            messages = await this.memory.decorate(messages, now);
        }
        catch (e) {
            console.error(`[silicon] 记忆出错，这一轮按原样转交：${e instanceof Error ? e.message : String(e)}`);
        }
        let source = null;
        if (this.lora && wantsFusion(options.messages, !!options.tools?.length)) {
            source = await this.lora.start(plain(messages), localView(options.messages, this.memory.store.seen), options.signal);
        }
        let text = "";
        let ok = false;
        for await (const chunk of source ?? this.ctx.llm.stream({ ...options, provider: this.upstream, messages })) {
            if (chunk.type === "text-delta")
                text += chunk.text;
            if (chunk.type === "finish")
                ok = chunk.reason.kind === "stop" || chunk.reason.kind === "tool-calls" || chunk.reason.kind === "max-tokens";
            yield chunk;
        }
        if (ok && text.trim())
            this.memory.store.append("assistant", text.trim(), new Date());
    }
}
