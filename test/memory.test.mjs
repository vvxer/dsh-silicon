// 记忆接入和提供方转交的行为测试（假的句向量和假的 DSH 模型服务，不联网）。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../lib/store.js";
import { Memory, acceptSources, isRealUser } from "../lib/memory.js";
import { SiliconAdapter } from "../lib/adapter.js";

/** 按字出现与否的假向量：有共同字的句子更相似，够测排序和过滤。 */
const fakeEmbed = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const ch of t) v[ch.codePointAt(0) % 64] = 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

const sys = (text) => ({ id: "s0", role: "system", content: [{ type: "text", text }], source: { kind: "system-prompt" } });
const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const ai = (id, text) => ({ id, role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: "silicon", model: "deepseek-flash" } });

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "silicon-"));
  const st = new Store(dir, "老板", "小硅");
  st.append("user", "我们养的那只猫叫团子", new Date(2026, 6, 1, 9, 0), "old1");
  st.append("assistant", "团子今天又抢你的键盘了吗", new Date(2026, 6, 1, 9, 1));
  st.append("user", "周末去爬山了，腿好酸", new Date(2026, 6, 2, 20, 0), "old2");
  st.append("assistant", "爬山回来记得拉伸", new Date(2026, 6, 2, 20, 1));
  st.writeJson("habits.json", [{ until: "2026-07-02", card: "老板累了 → 小硅说\"先躺平十分钟\"" }]);
  st.writeJson("skeleton.json", [{ from: "2026-06-29", to: "2026-07-02", line: "老板养猫、爬山" }]);
  return [dir, st, new Memory(st, fakeEmbed, { retrievalChars: 3000 })];
}

test("记忆插在系统提示之后和最后一条用户消息之前，原列表不变", async () => {
  const [, , mem] = fresh();
  const msgs = Object.freeze([sys("你是小硅"), user("u1", "早"), ai("a1", "早呀"), user("u2", "团子今天怎么样")]);
  const out = await mem.decorate(msgs, new Date(2026, 6, 3, 10, 0));
  assert.equal(msgs.length, 4);
  assert.equal(out.length, 6);
  assert.equal(out[0].role, "system");
  assert.match(out[1].content[0].text, /相处习惯[\s\S]*先躺平十分钟[\s\S]*老板养猫/);
  assert.equal(out[1].id, undefined, "注入的是仅供请求的输入，没有 id，不进会话历史");
  assert.equal(out[4].id, undefined);
  assert.match(out[4].content[0].text, /认识的第 3 天[\s\S]*团子/);
  assert.equal(out[5].id, "u2");
});

test("已经在上下文里的消息不会被检索回来", async () => {
  const [, , mem] = fresh();
  const out = await mem.decorate([sys("x"), user("old1", "我们养的那只猫叫团子"), ai("a", "嗯"), user("u9", "团子")], new Date(2026, 6, 3, 10, 0));
  const tail = out.find((m) => m.id === undefined && /原文/.test(m.content[0].text));
  assert.ok(!tail || !/团子今天又抢/.test(tail.content[0].text));
});

test("只记这一轮新发的用户消息，不补记旧消息，不重复记", () => {
  const [, st, mem] = fresh();
  const now = new Date(2026, 6, 3, 10, 0);
  const msgs = [sys("x"), user("v1", "很久以前的话"), ai("b1", "嗯"), user("v2", "今天第一句"), user("v3", "第二句")];
  mem.capture(msgs, now);
  mem.capture(msgs, now);
  const today = st.readDay("2026-07-03");
  assert.deepEqual(today.map((r) => r.content), ["今天第一句", "第二句"]);
});

test("QQ 等桥接插件转进来的消息也算用户本人的话，DSH 自己插的上下文不算", () => {
  const [, st, mem] = fresh();
  const from = (id, text, source) => ({ id, role: "user", content: [{ type: "text", text }], source });
  const msgs = [
    sys("x"), ai("b1", "嗯"),
    from("q1", "官方 QQ 机器人", { kind: "user" }),
    from("q2", "dsh-im-qq", { kind: "plugin", plugin: "dsh-im-qq" }),
    from("q3", "dsh-napcat", { kind: "plugin:dsh-napcat" }),
    from("q4", "自定义来源", { kind: "qq-relay" }),
    from("c1", "现在 10:00", { kind: "time-context" }),
    from("c2", "当前目录 D:/", { kind: "workspace", form: "snapshot" }),
    from("c3", "群里冷场了，主动说一句", { kind: "speak-up" }),
  ];
  mem.capture(msgs, new Date(2026, 6, 3, 10, 0));
  assert.deepEqual(st.readDay("2026-07-03").map((r) => r.content), ["官方 QQ 机器人", "dsh-im-qq", "dsh-napcat"]);
  acceptSources(["qq-relay"]);
  try {
    assert.ok(isRealUser(msgs[5]), "配置 userSources 后认得自定义来源");
    assert.ok(!isRealUser(msgs[6]) && !isRealUser(msgs[7]) && !isRealUser(msgs[8]));
  } finally {
    acceptSources([]);
  }
});

test("提供方：加记忆后转交上游、记下她的回答；辅助调用原样转交", async () => {
  const [, st, mem] = fresh();
  const calls = [];
  const ctx = {
    llm: {
      async *stream(opts) {
        calls.push(opts);
        yield { type: "text-delta", index: 0, text: "团子在睡觉" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
      async listModels() { return [{ provider: "deepseek-official", id: "deepseek-flash", name: "DeepSeek Flash" }]; },
      async resolveModelInfo(p, m) { return { provider: p, id: m, name: m, context: { window: 1048576 } }; },
    },
  };
  const ad = new SiliconAdapter(ctx, mem, "deepseek-official");
  assert.equal((await ad.listModels("silicon"))[0].provider, "silicon");
  assert.equal((await ad.resolveModel("silicon", "deepseek-flash")).provider, "silicon");

  const opts = Object.freeze({ provider: "silicon", model: "deepseek-flash", messages: Object.freeze([sys("你是小硅"), user("w1", "团子呢")]) });
  const got = [];
  for await (const c of ad.stream(opts)) got.push(c);
  assert.equal(got.length, 2);
  assert.equal(calls[0].provider, "deepseek-official");
  assert.ok(calls[0].messages.length > 2);
  const logged = st.chunks.at(-1).lines;
  assert.deepEqual(logged, ["老板：团子呢", "小硅：团子在睡觉"]);

  const before = st.chunks.length;
  for await (const _ of ad.stream({ ...opts, purpose: "session-title" })) { /* 消费掉 */ }
  assert.equal(calls[1].messages, opts.messages, "辅助调用不加记忆");
  assert.equal(st.chunks.length, before, "辅助调用不记日志");
});
