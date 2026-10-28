/**
 * 记忆存储：原文永久保存（每天一个 JSONL，只追加），按"一问一答"切块做向量检索，按时间说法过滤。
 * 目录结构和日志格式与硅基保留 Python 版相同（logs/、memory/、state.json），两边可以共用一份数据：
 *   logs/YYYY-MM-DD.jsonl    {"time": "HH:MM", "role": "user"|"assistant", "content": "...", "id"?: DSH 消息 id}
 *   memory/skeleton.json     每周一行概况；memory/rollup.json 月、年概况；memory/habits.json 相处习惯卡各版本
 *   memory/emb-node.*        本插件的向量缓存（Python 版用自己的 emb.pt，互不影响）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WEEK, dayOf, hhmm, parseWhen, weekday, type Day } from "./when.js";
import type { Embedder } from "./embed.js";

export const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
export const SKELETON_CAP = 1200;
const SAVE_EVERY = 64;

export interface LogRecord {
  time: string;
  role: "user" | "assistant";
  content: string;
  id?: string;
}

export interface Chunk {
  key: string;
  date: Day;
  time: string;
  at: number;
  lines: string[];
  /** 这一块里各条消息的 DSH 消息 id（已在当前上下文里的块检索时要跳过）。 */
  ids: string[];
  plain: string;
  text: string;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export class Store {
  readonly logs: string;
  readonly mem: string;
  chunks: Chunk[] = [];
  private vecs = new Map<string, { hash: string; v: Float32Array }>();
  private unsaved: Chunk[] = [];
  /** 已记入日志的 DSH 消息 id，防止同一条消息记两遍。 */
  readonly seen = new Set<string>();

  constructor(readonly dir: string, readonly userName: string, readonly aiName: string) {
    this.logs = join(dir, "logs");
    this.mem = join(dir, "memory");
    mkdirSync(this.logs, { recursive: true });
    mkdirSync(this.mem, { recursive: true });
    for (const day of this.days()) for (const rec of this.readDay(day)) this.add(day, rec);
    this.loadVecs();
  }

  // ---- 原文 ----
  append(role: LogRecord["role"], content: string, t: Date = new Date(), id?: string): void {
    if (id && this.seen.has(id)) return;
    const rec: LogRecord = { time: hhmm(t), role, content, ...(id ? { id } : {}) };
    appendFileSync(join(this.logs, `${dayOf(t)}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
    this.add(dayOf(t), rec);
  }

  days(): Day[] {
    return readdirSync(this.logs).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();
  }

  readDay(day: Day): LogRecord[] {
    const f = join(this.logs, `${day}.jsonl`);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogRecord);
  }

  private add(day: Day, rec: LogRecord): void {
    if (rec.id) this.seen.add(rec.id);
    const who = rec.role === "user" ? this.userName : this.aiName;
    let c = this.chunks.at(-1);
    if (rec.role === "user" || !c || c.date !== day) {
      const [h, mi] = rec.time.split(":").map(Number) as [number, number];
      const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
      c = { key: `${day}#${String(this.chunks.length).padStart(7, "0")}`, date: day, time: rec.time,
            at: new Date(y, mo - 1, d, h, mi).getTime(), lines: [], ids: [], plain: "", text: "" };
      this.chunks.push(c);
    }
    c.lines.push(`${who}：${rec.content}`);
    if (rec.id) c.ids.push(rec.id);
    c.plain = c.lines.join(" / ");
    c.text = `[${c.date} 星期${WEEK[weekday(c.date)]} ${c.time}] ${c.plain}`;
  }

  // ---- 向量缓存：idx.jsonl 每行 {key, hash, off, dim}，f32 文件只追加；同一 key 以最后一行为准 ----
  private loadVecs(): void {
    const idx = join(this.mem, "emb-node.idx.jsonl");
    const bin = join(this.mem, "emb-node.f32");
    if (!existsSync(idx) || !existsSync(bin)) return;
    const buf = readFileSync(bin);
    const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    for (const line of readFileSync(idx, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { key, hash, off, dim } = JSON.parse(line) as { key: string; hash: string; off: number; dim: number };
      if (off + dim <= all.length) this.vecs.set(key, { hash, v: all.slice(off, off + dim) });
    }
  }

  private flush(): void {
    if (!this.unsaved.length) return;
    const idx = join(this.mem, "emb-node.idx.jsonl");
    const bin = join(this.mem, "emb-node.f32");
    let off = existsSync(bin) ? Math.floor(statSync(bin).size / 4) : 0;
    const lines: string[] = [];
    const parts: Buffer[] = [];
    for (const c of this.unsaved) {
      const e = this.vecs.get(c.key);
      if (!e) continue;
      parts.push(Buffer.from(e.v.buffer, e.v.byteOffset, e.v.byteLength));
      lines.push(JSON.stringify({ key: c.key, hash: e.hash, off, dim: e.v.length }));
      off += e.v.length;
    }
    appendFileSync(bin, Buffer.concat(parts));
    appendFileSync(idx, lines.join("\n") + "\n", "utf8");
    this.unsaved = [];
  }

  private async ensureVecs(embed: Embedder, pool: Chunk[]): Promise<void> {
    const todo = pool.filter((c) => this.vecs.get(c.key)?.hash !== sha(c.plain));
    if (!todo.length) return;
    const vs = await embed.embed(todo.map((c) => c.plain));
    todo.forEach((c, i) => this.vecs.set(c.key, { hash: sha(c.plain), v: vs[i]! }));
    this.unsaved.push(...todo);
    if (this.unsaved.length >= SAVE_EVERY) this.flush();
  }

  /** 关闭前把还没写盘的向量写下来（没写的下次启动会重算，不会出错，只是慢一点）。 */
  close(): void {
    this.flush();
  }

  /**
   * 按用户原话检索原文：话里有时间说法就只在那段时间里找；按相似度排，按字数预算打包，按时间顺序输出。
   * hide 里的消息已经在本次请求的上下文里，含有它们的块不再重复取；now 之后的记录一律不取。
   */
  async retrieve(embed: Embedder, query: string, now: Date, budget: number, hide: ReadonlySet<string>): Promise<string> {
    let pool = this.chunks.filter((c) => c.at < now.getTime() && !c.ids.some((id) => hide.has(id)));
    if (!pool.length || !query.trim()) return "";
    const when = parseWhen(query, dayOf(now));
    if (when) {
      const inRange = pool.filter((c) => when[0] <= c.date && c.date <= when[1]);
      if (inRange.length) pool = inRange;
    }
    await this.ensureVecs(embed, pool);
    const [q] = await embed.embed([QUERY_PREFIX + query]);
    const score = (c: Chunk) => {
      const v = this.vecs.get(c.key)!.v;
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i]! * q![i]!;
      return s;
    };
    const ranked = pool.map((c) => [score(c), c] as const).sort((a, b) => b[0] - a[0]);
    const picked: Chunk[] = [];
    let used = 0;
    for (const [, c] of ranked) {
      if (used + c.text.length <= budget) {
        picked.push(c);
        used += c.text.length;
      }
    }
    return picked.sort((a, b) => (a.key < b.key ? -1 : 1)).map((c) => c.text).join("\n");
  }

  // ---- 夜间整理的产物 ----
  private readJson<T>(name: string, fallback: T): T {
    const f = join(this.mem, name);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
  }

  writeJson(name: string, value: unknown): void {
    writeFileSync(join(this.mem, name), JSON.stringify(value, null, 1), "utf8");
  }

  memoryJson<T>(name: string, fallback: T): T {
    return this.readJson(name, fallback);
  }

  /** 相处习惯卡的最新版。 */
  habits(): string {
    return this.readJson<{ until: string; card: string }[]>("habits.json", []).at(-1)?.card ?? "";
  }

  /** 分层概况：每周一行；超过 cap 时从最早的开始把整月换成月概况，还超就把整年换成年概况。 */
  skeleton(cap: number = SKELETON_CAP): string {
    const weeks = this.readJson<{ from: string; to: string; line: string }[]>("skeleton.json", []);
    if (!weeks.length) return "";
    const roll = this.readJson<{ months?: Record<string, string>; years?: Record<string, string> }>("rollup.json", {});
    let lines: [string, string, string][] = weeks.map((w) => [w.from.slice(0, 7), w.from.slice(0, 4), `${w.from}~${w.to}：${w.line}`]);
    const size = () => lines.reduce((s, [, , t]) => s + t.length + 1, 0);
    for (const [pos, level, label] of [[0, "months", "整月"], [1, "years", "全年"]] as const) {
      const done = roll[level] ?? {};
      for (const key of [...new Set(lines.map((ln) => ln[pos]))].sort()) {
        if (size() <= cap) break;
        const idx = lines.flatMap((ln, i) => (ln[pos] === key ? [i] : []));
        if (done[key] !== undefined && idx.length > 1) {
          lines = [...lines.slice(0, idx[0]), [key.slice(0, 7), key.slice(0, 4), `${key} ${label}：${done[key]}`],
                   ...lines.slice(idx.at(-1)! + 1)];
        }
      }
    }
    return lines.map(([, , t]) => t).join("\n");
  }

  // ---- 进度 ----
  state(): Record<string, string> {
    const f = join(this.dir, "state.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, string>) : {};
  }

  setState(patch: Record<string, string>): void {
    writeFileSync(join(this.dir, "state.json"), JSON.stringify({ ...this.state(), ...patch }, null, 1), "utf8");
  }
}
