/**
 * dsh-silicon：硅基保留的 DeepSeek Harness 插件。
 *   注册"硅基保留"模型提供方（adapter.ts）：在 DSH 里选它的模型，就会带上长期记忆，并把对话记进原文日志。
 *   每天 nightlyAt 整理一次记忆（nightly.ts）；DSH 启动后也会把没整理的日子补上。整理用的 DeepSeek 调用走 upstream 路由。
 *   可选的本地人格权重（lora.ts）：默认关；useLora 打开后，闲聊交给本机的硅基保留本地权重服务融合。
 * 数据都在 dataDir（默认 ~/.silicon），格式与硅基保留 Python 版相同。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { PROVIDER, SiliconAdapter } from "./adapter.js";
import { Embedder } from "./embed.js";
import { Lora } from "./lora.js";
import { Memory, acceptSources } from "./memory.js";
import { runNightly, type Ask } from "./nightly.js";
import { Store } from "./store.js";
import { dayOf } from "./when.js";

export const name = "silicon";
export const inject = ["llm"];

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
  userSources?: string[];
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().description("记忆数据目录，默认 ~/.silicon"),
  userName: Schema.string().default("用户").description("她怎么称呼你"),
  aiName: Schema.string().default("她").description("她的名字"),
  upstream: Schema.string().default("deepseek-official").description("转交给哪个 DeepSeek 路由：API key 用 deepseek-official，账号登录用 deepseek-account"),
  summaryModel: Schema.string().default("deepseek-flash").description("夜间整理用的模型"),
  retrievalChars: Schema.natural().default(3000).description("每轮检索原文的字数"),
  nightlyAt: Schema.string().default("03:30").description("每天整理记忆的时间（HH:MM），留空只在启动时补整理"),
  embedModel: Schema.string().default("Xenova/bge-base-zh-v1.5").description("检索用的句向量模型"),
  embedDtype: Schema.string().default("fp16")
    .description("句向量模型精度：fp16（约 200MB，检索结果与评测时 50 条里 49 条相同）、fp32（约 390MB，完全相同）；q8 只有约 2/3 相同，不建议"),
  modelHost: Schema.string().default("https://hf-mirror.com/").description("句向量模型下载源"),
  modelDir: Schema.string().description("已下载好的模型根目录（给了就不联网下载）"),
  useLora: Schema.boolean().default(false)
    .description("开本地人格权重（要 8GB 显卡）：闲聊交给本机的硅基保留本地权重服务融合，先按 README 烘焙并启动服务；默认关，只用 DeepSeek + 记忆"),
  loraServer: Schema.string().default("http://127.0.0.1:8701").description("本地权重服务地址（python -m silicon.lora_server）"),
  loraSpeed: Schema.string().default("").description("融合速度档 fast / medium / strong：越往后越像她、越慢；留空用服务的设置"),
  userSources: Schema.array(Schema.string()).default([])
    .description("另外当作你本人消息的来源 kind（QQ 等桥接插件自己起的名字；user、plugin、plugin:插件名 已默认识别）"),
});

const log = (msg: string) => console.error(`[silicon] ${msg}`);

function msUntil(at: string): number {
  const [h = 3, m = 30] = at.split(":").map(Number);
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (due <= now) due.setDate(due.getDate() + 1);
  return due.getTime() - now.getTime();
}

export function apply(ctx: Context, config: Config = {}): void {
  const dir = config.dataDir || join(homedir(), ".silicon");
  const upstream = config.upstream ?? "deepseek-official";
  acceptSources(config.userSources ?? []);
  const store = new Store(dir, config.userName ?? "用户", config.aiName ?? "她");
  const embed = new Embedder({
    model: config.embedModel ?? "Xenova/bge-base-zh-v1.5",
    dtype: config.embedDtype ?? "fp16",
    host: config.modelHost ?? "https://hf-mirror.com/",
    cacheDir: join(dir, "models"),
    ...(config.modelDir ? { localDir: config.modelDir } : {}),
  });
  const memory = new Memory(store, embed, { retrievalChars: config.retrievalChars ?? 3000 });
  const lora = config.useLora ? new Lora(config.loraServer || "http://127.0.0.1:8701", config.loraSpeed ?? "", log) : undefined;
  ctx.llm.registerAdapter([PROVIDER], new SiliconAdapter(ctx, memory, upstream, lora));

  const ask: Ask = async (prompt, maxTokens = 300) => {
    let text = "";
    for await (const chunk of ctx.llm.stream({
      provider: upstream,
      model: config.summaryModel ?? "deepseek-flash",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens,
      reasoningEffort: "off" as ReasoningEffortId,
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
        throw new Error(`DeepSeek 调用失败（${chunk.reason.kind}）`);
      }
    }
    return text.trim();
  };

  let running = false;
  const nightly = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runNightly(store, ask, dayOf(new Date()), memory.persona());
      if (n) log(`整理了 ${n} 天的记忆`);
    } catch (e) {
      log(`整理记忆失败，下次再试：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  const timers: NodeJS.Timeout[] = [setTimeout(nightly, 30_000).unref()];
  const scheduleNext = () => {
    if (config.nightlyAt === "") return;
    timers.push(setTimeout(() => {
      void nightly();
      scheduleNext();
    }, msUntil(config.nightlyAt ?? "03:30")).unref());
  };
  scheduleNext();

  ctx.effect(() => () => {
    timers.forEach(clearTimeout);
    store.close();
  });
  log(`已就绪：记忆在 ${dir}，${store.days().length} 天的原文；在模型选择里选"硅基保留"开头的模型即可` +
    (lora ? `；本地权重：${lora.server}` : ""));
}
