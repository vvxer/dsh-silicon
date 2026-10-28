/**
 * 检索用的句向量：bge-base-zh-v1.5 的 ONNX 版，在 Node 里用 CPU 跑（transformers.js）。
 * 和 Python 版一致：CLS 向量、L2 归一化、截断到 256 token。第一次用时从 modelHost 下载（默认 hf-mirror）。
 * 精度实测（阶段 3 的 90 天数据，50 条探针，与 Python 版 fp32 比检索结果）：fp32 50/50 相同，fp16 49/50，
 * q8（int8 量化）只有 1/50 相同、平均重合 0.67——量化把向量余弦拉到 0.96 左右，足以打乱排序。所以默认 fp16。
 */

import type { PreTrainedModel, PreTrainedTokenizer, Tensor } from "@huggingface/transformers";

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

export class Embedder {
  private loading?: Promise<[PreTrainedTokenizer, PreTrainedModel]>;

  constructor(private readonly opts: EmbedOptions) {}

  private load(): Promise<[PreTrainedTokenizer, PreTrainedModel]> {
    this.loading ??= (async () => {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = this.opts.cacheDir;
      t.env.remoteHost = this.opts.host;
      if (this.opts.localDir) {
        t.env.localModelPath = this.opts.localDir;
        t.env.allowRemoteModels = false;
      } else {
        t.env.allowLocalModels = false;
      }
      const tok = await t.AutoTokenizer.from_pretrained(this.opts.model);
      const model = await t.AutoModel.from_pretrained(this.opts.model, { dtype: this.opts.dtype as "q8" });
      return [tok, model] as [PreTrainedTokenizer, PreTrainedModel];
    })();
    this.loading.catch(() => (this.loading = undefined));       // 下载失败下次重试
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const [tok, model] = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32);
      const inputs = tok(batch, { padding: true, truncation: true, max_length: 256 });
      const { last_hidden_state: h } = (await model(inputs)) as { last_hidden_state: Tensor };
      const [n, len, dim] = h.dims as [number, number, number];
      const data = h.data as Float32Array;
      for (let j = 0; j < n; j++) {
        const v = data.slice(j * len * dim, j * len * dim + dim);
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < dim; k++) v[k] = v[k]! / norm;
        out.push(v);
      }
    }
    return out;
  }
}
