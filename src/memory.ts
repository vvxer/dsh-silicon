/**
 * 把记忆接到一次模型请求上（只改这一次请求，不写进 DSH 的会话历史）：
 *   固定段（习惯卡 + 分层概况）：紧跟在系统提示之后。每晚才变，前缀一天内不变，能命中 DeepSeek 的缓存。
 *   尾段（现在时间 + 认识第几天 + 这句话相关的原文 + 规则）：放在最后一条用户消息之前，只有这一小段和最后一轮不命中缓存。
 * 同时把这一轮新发的用户消息记进原文日志；她的回答由适配器在流结束后记。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestMessage } from "@deepseek-ai/dsh-llm";
import { WEEK, dayOf, daysBetween, hhmm, weekday } from "./when.js";
import type { Store } from "./store.js";
import type { Embedder } from "./embed.js";

export interface MemoryOptions {
  retrievalChars: number;
}

type Msg = RequestMessage;

export function textOf(m: Msg): string {
  return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/** 用户本人发的消息（不是压缩摘要、插件注入或仅供请求的输入）。 */
export function isRealUser(m: Msg): boolean {
  return m.role === "user" && "source" in m && m.source?.kind === "user";
}

const input = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });

export class Memory {
  /** 用户消息 id → 这条消息的尾段，同一轮里的多个步骤复用，前缀保持稳定。 */
  private tails = new Map<string, string>();
  private personaHash = "";

  constructor(readonly store: Store, readonly embed: Embedder, readonly opts: MemoryOptions) {}

  /** 记下这一轮新发的用户消息：最后一条她的回答之后的那些。更早的（插件装上之前的、续聊的旧会话）不补记，免得时间记错。 */
  capture(messages: readonly Msg[], now: Date): void {
    const fresh: Msg[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== "assistant"; i--) {
      if (isRealUser(messages[i]!)) fresh.unshift(messages[i]!);
    }
    for (const m of fresh) {
      const id = (m as { id?: string }).id;
      const text = textOf(m);
      if (id && text && !this.store.seen.has(id)) this.store.append("user", text, now, id);
    }
  }

  /** 习惯卡整理时要对照人格档案，免得把人格卡里已有的性格重复写进卡。DSH 里人格写在系统提示里，记下最近一次的。 */
  rememberPersona(messages: readonly Msg[]): void {
    const sys = messages.find((m) => m.role === "system");
    if (!sys) return;
    const text = textOf(sys).slice(0, 4000);
    const h = createHash("sha1").update(text).digest("hex");
    if (h !== this.personaHash) {
      this.personaHash = h;
      writeFileSync(join(this.store.mem, "persona-seen.txt"), text, "utf8");
    }
  }

  persona(): string {
    for (const f of [join(this.store.dir, "persona.md"), join(this.store.mem, "persona-seen.txt")]) {
      if (existsSync(f)) return readFileSync(f, "utf8").slice(0, 4000);
    }
    return "（无）";
  }

  staticBlock(): string {
    const { userName: user } = this.store;
    const card = this.store.habits();
    const skel = this.store.skeleton();
    if (!card && !skel) return "";
    return [
      `以下是硅基保留记忆插件提供的长期记忆，是你和${user}过去的相处整理出来的，不是${user}这次发的消息。`,
      card && `你和${user}的相处习惯（从过去的聊天里整理）：\n${card}`,
      skel && `过去的概况（近期按周，更早按月、按年）：\n${skel}`,
    ].filter(Boolean).join("\n\n");
  }

  async tailBlock(query: string, now: Date, hide: ReadonlySet<string>): Promise<string> {
    const { userName: user } = this.store;
    const days = this.store.days();
    if (!days.length) return "";
    const today = dayOf(now);
    const head = `（硅基保留记忆插件）现在是 ${today} 星期${WEEK[weekday(today)]} ${hhmm(now)}。` +
      `你和${user}的第一条聊天记录是 ${days[0]}，到今天是认识的第 ${daysBetween(days[0]!, today) + 1} 天。`;
    const snip = await this.store.retrieve(this.embed, query, now, this.opts.retrievalChars, hide);
    return [
      head,
      snip && `以下是和${user}下面这句话可能相关的过往聊天记录（原文，按时间排序）：\n${snip}`,
      `回答${user}时，只依据上面的记录和你确定知道的信息；记录里没有的过去的事，就直说不记得，不要编造。` +
        "问到日期、天数，以上面写明的日期为准，不要自己推算。",
    ].filter(Boolean).join("\n\n");
  }

  /** 返回加上记忆的新消息列表（原列表是冻结的，不改它）。检索失败时只少尾段里的原文，不影响回答。 */
  async decorate(messages: readonly Msg[], now: Date): Promise<Msg[]> {
    const out = [...messages];
    let last = -1;
    for (let i = out.length - 1; i >= 0; i--) if (isRealUser(out[i]!)) { last = i; break; }
    if (last >= 0) {
      const lastId = (out[last] as { id?: string }).id ?? "";
      let tail = this.tails.get(lastId);
      if (tail === undefined) {
        const hide = new Set(messages.flatMap((m) => ("id" in m && m.id ? [m.id as string] : [])));
        try {
          tail = await this.tailBlock(textOf(out[last]!), now, hide);
        } catch (e) {
          console.error(`[silicon] 检索失败，这一轮不带原文：${e instanceof Error ? e.message : String(e)}`);
          tail = "";
        }
        this.tails.set(lastId, tail);
        if (this.tails.size > 64) this.tails.delete(this.tails.keys().next().value!);
      }
      if (tail) out.splice(last, 0, input(tail));
    }
    const block = this.staticBlock();
    if (block) {
      let at = 0;
      while (at < out.length && out[at]!.role === "system") at++;
      out.splice(at, 0, input(block));
    }
    return out;
  }
}
