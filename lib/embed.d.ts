/**
 * 检索用的句向量：bge-base-zh-v1.5 的 ONNX 版，在 Node 里用 CPU 跑（transformers.js）。
 * 和 Python 版一致：CLS 向量、L2 归一化、截断到 256 token。第一次用时从 modelHost 下载（默认 hf-mirror）。
 * 精度实测（阶段 3 的 90 天数据，50 条探针，与 Python 版 fp32 比检索结果）：fp32 50/50 相同，fp16 49/50，
 * q8（int8 量化）只有 1/50 相同、平均重合 0.67——量化把向量余弦拉到 0.96 左右，足以打乱排序。所以默认 fp16。
 */
export interface EmbedOptions {
    model: string;
    dtype: string;
    /** 下载源，默认 https://hf-mirror.com/ */
    host: string;
    /** 下载缓存目录 */
    cacheDir: string;
    /** 已经下好的本地模型根目录（目录下是 <model>/config.json 等），给了就不联网 */
    localDir?: string;
}
export declare class Embedder {
    private readonly opts;
    private loading?;
    constructor(opts: EmbedOptions);
    private load;
    embed(texts: string[]): Promise<Float32Array[]>;
}
