// 可选本地权重的行为测试：假的本地权重服务（本机 HTTP）和假的 DSH 模型服务，不联网、不要显卡。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../lib/store.js";
import { Memory } from "../lib/memory.js";
import { SiliconAdapter } from "../lib/adapter.js";
import { Lora, localView, plain, wantsFusion } from "../lib/lora.js";

const sys = (text) => ({ id: "s0", role: "system", content: [{ type: "text", text }], source: { kind: "system-prompt" } });
const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const ai = (id, text, extra = []) => ({ id, role: "assistant", content: [{ type: "text", text }, ...extra], source: { kind: "model" } });
const tool = (id) => ({ id, role: "tool", content: [{ type: "text", text: "ls 的结果" }], source: { kind: "tool" } });
const input = (text) => ({ role: "user", content: [{ type: "text", text }] });
const noEmbed = { async embed(texts) { return texts.map(() => new Float32Array(8).fill(1 / Math.sqrt(8))); } };

/** 起一个假的本地权重服务，handler(req, body, res)；返回 [地址, 收到的请求体, 关闭]。 */
async function fakeServer(handler) {
  const got = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      got.push(body);
      handler(req, body, res);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return [`http://127.0.0.1:${srv.address().port}`, got, () => new Promise((r) => srv.close(r))];
}

const ndjson = (res, events) => {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const e of events) res.write(JSON.stringify(e) + "\n");
  res.end();
};

async function collect(it) {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
}

test("只有一轮的第一步走融合；带工具的会话里像是干活的话照常走 DeepSeek", () => {
  const chat = [sys("你是小硅"), user("u1", "今天好累")];
  assert.equal(wantsFusion(chat, true), true);
  const snapshot = { id: "c1", role: "user", content: [{ type: "text", text: "当前目录 D:/" }], source: { kind: "workspace", form: "snapshot" } };
  assert.equal(wantsFusion([...chat, snapshot], true), true, "DSH 附在后面的上下文快照不算");
  assert.equal(wantsFusion([sys("x"), user("u1", "帮我搜一下明天的天气")], true), false);
  assert.equal(wantsFusion([sys("x"), user("u1", "帮我写首诗")], false), true, "没有工具时干活的话也融合");
  assert.equal(wantsFusion([...chat, ai("a1", "", [{ type: "tool-call", id: "t1", name: "ls", arguments: "{}" }]), tool("r1")], false), false);
  assert.equal(wantsFusion([sys("x"), input("记忆")], false), false, "最后一条不是用户本人发的");
});

test("发给 DeepSeek 的消息去掉工具调用和结果，本地模型只看原话并带时间", () => {
  const msgs = [sys("你是小硅"), input("（记忆）习惯卡"), user("u1", "早"), ai("a1", "早呀"),
    ai("a2", "", [{ type: "tool-call", id: "t1", name: "ls", arguments: "{}" }]), tool("r1"), input("（记忆）检索"), user("u2", "团子呢")];
  assert.deepEqual(plain(msgs).map((m) => [m.role, m.content]), [
    ["system", "你是小硅"], ["user", "（记忆）习惯卡"], ["user", "早"], ["assistant", "早呀"], ["user", "（记忆）检索"], ["user", "团子呢"]]);
  const times = new Map([["u2", new Date(2026, 6, 7, 21, 5).getTime()]]);   // 2026-07-07 是星期二
  assert.deepEqual(localView(msgs, times), [
    { role: "user", content: "早" }, { role: "assistant", content: "早呀" }, { role: "user", content: "[星期二 21:05] 团子呢" }]);
});

test("融合正常时逐字转成文字块，服务用不了时返回 null", async () => {
  const [url, got, close] = await fakeServer((req, body, res) => {
    if (body.local.at(-1).content === "503") return res.writeHead(503).end("{}");
    if (body.local.at(-1).content === "坏") return ndjson(res, [{ type: "error", message: "显存不够" }]);
    if (body.local.at(-1).content === "断") return ndjson(res, [{ type: "delta", text: "说到一半" }]);
    ndjson(res, [{ type: "delta", text: "老板，" }, { type: "delta", text: "先躺平十分钟。" }, { type: "done", stats: {} }]);
  });
  const logs = [];
  const lora = new Lora(url, "fast", (m) => logs.push(m));
  try {
    const ok = await collect(await lora.start([{ role: "user", content: "累" }], [{ role: "user", content: "累" }]));
    assert.equal(got[0].speed, "fast");
    assert.deepEqual(ok.map((c) => c.type), ["block-start", "text-delta", "text-delta", "block-end", "finish"]);
    assert.equal(ok[3].block.text, "老板，先躺平十分钟。");
    assert.equal(ok[4].reason.kind, "stop");

    assert.equal(await lora.start([], [{ role: "user", content: "503" }]), null);
    assert.equal(await lora.start([], [{ role: "user", content: "坏" }]), null);
    assert.equal(logs.length, 2);
    const cut = await collect(await lora.start([], [{ role: "user", content: "断" }]));
    assert.equal(cut.at(-1).reason.kind, "error");
  } finally {
    await close();
  }
  assert.equal(await new Lora(url, "", () => {}).start([], [{ role: "user", content: "x" }]), null, "服务没开");
});

test("提供方：闲聊走本地权重并记日志；服务用不了就转交上游", async () => {
  const [url, got, close] = await fakeServer((req, body, res) =>
    ndjson(res, [{ type: "delta", text: "团子在睡觉，别吵它。" }, { type: "done" }]));
  const store = new Store(mkdtempSync(join(tmpdir(), "silicon-")), "老板", "小硅");
  const calls = [];
  const ctx = {
    llm: {
      async *stream(opts) {
        calls.push(opts);
        yield { type: "text-delta", index: 0, text: "（上游）" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  try {
    const ad = new SiliconAdapter(ctx, new Memory(store, noEmbed, { retrievalChars: 3000 }), "deepseek-official",
      new Lora(url, "", () => {}));
    const out = await collect(ad.stream({ provider: "silicon", model: "deepseek-flash", messages: [sys("你是小硅"), user("u1", "团子呢")] }));
    assert.equal(calls.length, 0);
    assert.equal(out.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "团子在睡觉，别吵它。");
    assert.equal(got[0].messages[0].role, "system");
    assert.match(got[0].local.at(-1).content, /^\[星期.\s\d\d:\d\d\] 团子呢$/);
    const day = store.days().at(-1);
    assert.deepEqual(store.readDay(day).map((r) => [r.role, r.content]), [["user", "团子呢"], ["assistant", "团子在睡觉，别吵它。"]]);

    await collect(ad.stream({ provider: "silicon", model: "deepseek-flash", tools: [{ name: "search" }],
      messages: [sys("你是小硅"), user("u2", "帮我搜一下天气")] }));
    assert.equal(calls.length, 1, "带工具时干活的话转交上游");
  } finally {
    await close();
  }
  const down = new SiliconAdapter(ctx, new Memory(store, noEmbed, { retrievalChars: 3000 }), "deepseek-official",
    new Lora(url, "", () => {}));
  const out = await collect(down.stream({ provider: "silicon", model: "deepseek-flash", messages: [sys("x"), user("u3", "在吗")] }));
  assert.equal(out[0].text, "（上游）", "服务关了就转交上游");
});
