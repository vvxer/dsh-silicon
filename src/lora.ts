/**
 * 可选的本地人格权重：把闲聊转给本机的硅基保留本地权重服务（Python 版，python -m silicon.lora_server），
 * DeepSeek 写内容，本地 2B + LoRA 按她的说话方式改写。服务没开、还没烘焙或者正在夜间巩固，就退回普通 DeepSeek。
 * 融合只出文字、不会调用工具，所以带工具的会话里，像是让她干活的消息（写、查、代码……）照常走 DeepSeek；
 * 工具调用之后的步骤也走 DeepSeek。融合固定用 DeepSeek 的非思考模式（要用候选词的概率）。
 */

import type { FinishReason, RequestMessage, StreamChunk } from "@deepseek-ai/dsh-llm";
import { isRealUser, textOf } from "./memory.js";
import { stamp } from "./when.js";

export interface Plain {
  role: "system" | "user" | "assistant";
  content: string;
}

type Event = { type: "delta"; text: string } | { type: "done"; stats?: unknown } | { type: "error"; message: string };

/** 与 Python 版 fusion.TASK 相同，再加上常要用工具的说法。 */
const TASK = /写|帮我|帮忙|列(个|一下|出)|整理|总结|翻译|代码|程序|脚本|方案|周报|日报|报告|提纲|大纲|邮件|解释|分析|计划|清单|改一下|改写|润色|生成|设计|优化|对比|步骤|教程|怎么(做|写|弄|配|装)|搜|查|打开|运行|文件|网页|链接/;

/**
 * 这一步走不走融合：一轮的第一步（用户本人最后那句话之后还没有她的回答和工具结果；DSH 可能在后面附上下文快照），
 * 而且会话里有工具时，这句话不像是要她干活。
 */
export function wantsFusion(messages: readonly RequestMessage[], hasTools: boolean): boolean {
  let i = messages.length - 1;
  for (; i >= 0 && !isRealUser(messages[i]!); i--) {
    if (messages[i]!.role === "assistant" || messages[i]!.role === "tool") return false;
  }
  return i >= 0 && !(hasTools && TASK.test(textOf(messages[i]!)));
}

/** 发给 DeepSeek 的纯文字消息：工具调用、工具结果、思考过程都去掉（融合这一步只聊天）。 */
export function plain(messages: readonly RequestMessage[]): Plain[] {
  const out: Plain[] = [];
  for (const m of messages) {
    const role = m.role === "system" || m.role === "developer" ? "system" : m.role === "user" || m.role === "assistant" ? m.role : null;
    const text = role ? textOf(m) : "";
    if (role && text) out.push({ role, content: text });
  }
  return out;
}

/**
 * 本地模型看的对话：只有用户和她的原话，不带系统提示和记忆；用户的话前面加上时间，和夜间巩固训练时的格式一样。
 * times：消息 id → 记日志的时间（插件装上之前的消息没有，就不加时间）。
 */
export function localView(messages: readonly RequestMessage[], times: ReadonlyMap<string, number>): Plain[] {
  const out: Plain[] = [];
  for (const m of messages) {
    const text = textOf(m);
    if (!text || !(isRealUser(m) || m.role === "assistant")) continue;
    const t = isRealUser(m) ? times.get((m as { id?: string }).id ?? "") : undefined;
    const content = t === undefined ? text : `${stamp(new Date(t))} ${text}`;
    const prev = out.at(-1);
    if (prev && prev.role === m.role) prev.content += "\n" + content;
    else out.push({ role: m.role as "user" | "assistant", content });
  }
  return out;
}

async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  let buf = "";
  for await (const part of body.pipeThrough(new TextDecoderStream())) {
    buf += part;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line) as Event;
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Lora {
  private lastWarning = "";

  constructor(readonly server: string, readonly speed: string, private readonly log: (msg: string) => void) {}

  /** 开始一次融合，等到第一个事件。服务用不了（没开、没烘焙、夜间巩固中、出错）返回 null，由调用方改走普通 DeepSeek。 */
  async start(messages: Plain[], local: Plain[], signal?: AbortSignal): Promise<AsyncIterable<StreamChunk> | null> {
    let it: AsyncIterator<Event>;
    let first: IteratorResult<Event>;
    try {
      const res = await fetch(new URL("/v1/fuse", this.server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, local, ...(this.speed ? { speed: this.speed } : {}) }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      it = events(res.body)[Symbol.asyncIterator]();
      first = await it.next();
      if (first.done) throw new Error("没有返回内容");
      if (first.value.type === "error") throw new Error(first.value.message);
    } catch (e) {
      if (signal?.aborted) throw e;
      const why = e instanceof TypeError ? `连不上 ${this.server}，本地权重服务（python -m silicon.lora_server）开了吗？` : message(e);
      const warning = `本地权重暂时用不了，先只用 DeepSeek：${why}`;
      if (warning !== this.lastWarning) this.log(warning);
      this.lastWarning = warning;
      return null;
    }
    this.lastWarning = "";
    return this.chunks(first.value, it, signal);
  }

  private async *chunks(first: Event, it: AsyncIterator<Event>, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    yield { type: "block-start", index: 0, blockType: "text" };
    let text = "";
    let reason: FinishReason = { kind: "stop" };
    try {
      let ev: Event | undefined = first;
      for (; ev && ev.type !== "done"; ev = await it.next().then((r) => (r.done ? undefined : r.value))) {
        if (ev.type === "error") throw new Error(ev.message);
        text += ev.text;
        yield { type: "text-delta", index: 0, text: ev.text };
      }
      if (!ev) throw new Error("连接中途断了");
    } catch (e) {
      reason = signal?.aborted
        ? { kind: "aborted", failure: { message: "已取消", code: "ABORTED" } }
        : { kind: "error", failure: { message: `本地权重服务出错：${message(e)}`, code: "SILICON_LORA" } };
    }
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason };
  }
}
