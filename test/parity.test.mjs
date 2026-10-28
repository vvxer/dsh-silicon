// 与硅基保留 Python 版逐条对照：标准答案由 Python 版的函数生成（test/fixtures/parity.json）。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cn2int, parseWhen } from "../lib/when.js";
import { pieces } from "../lib/nightly.js";
import { Store } from "../lib/store.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

test("时间说法解析与 Python 版一致", () => {
  for (const c of fx.when) assert.deepEqual(parseWhen(c.text, c.now), c.out, `${c.text} @ ${c.now}`);
});

test("中文数字与 Python 版一致", () => {
  for (const [s, n] of Object.entries(fx.cn)) assert.equal(cn2int(s), n, s);
});

test("分段与 Python 版一致", () => {
  for (const c of fx.pieces) assert.deepEqual(pieces(c.days, c.size), c.out, `size ${c.size}`);
});

test("分层概况与 Python 版一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "silicon-"));
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "skeleton.json"), JSON.stringify(fx.skeleton.weeks));
  writeFileSync(join(dir, "memory", "rollup.json"), JSON.stringify(fx.skeleton.rollup));
  const st = new Store(dir, "老板", "小硅");
  for (const [cap, out] of Object.entries(fx.skeleton.out)) assert.equal(st.skeleton(Number(cap)), out, `cap ${cap}`);
});
