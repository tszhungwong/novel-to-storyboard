// 審查代理埋錯測試的資料檢查（不跑審查代理，那一步要手動，見 README）。
// 確認 defects.json 的每一條：還套得上現在的範例、腳本抓不到（不然主流程會先改掉，輪不到審查代理）、
// 而且改動真的出現在審查代理會讀的檔案裡。
// 執行：node --test（需要 Node 18 以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFECTS, loadBase, applyDefects, build } from './reviewer-defects/build.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-defects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const READ_BY_REVIEWERS = ['EP01-storyboard.md', 'settings.md'];
const outText = (dir) => READ_BY_REVIEWERS.map((f) => fs.readFileSync(path.join(dir, 'out', f), 'utf8')).join('\n');

test('defects.json：每一條都有編號、審查角色、位置與判定標準，編號不重複', () => {
  const ids = DEFECTS.defects.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of DEFECTS.defects) {
    assert.ok(['camera', 'acting', 'art'].includes(d.reviewer), `${d.id} 的 reviewer`);
    assert.ok(d.where && d.title && d.expect && d.edits.length, `${d.id} 缺欄位`);
  }
  for (const r of ['camera', 'acting', 'art']) {
    assert.ok(DEFECTS.defects.filter((d) => d.reviewer === r).length >= 3, `${r} 至少要三條`);
  }
});

test('埋錯：每一條單獨套上都套得上、腳本抓不到，而且審查代理讀的檔案真的變了', (t) => {
  const dir = tmp(t);
  const clean = build(path.join(dir, 'clean'), loadBase());
  assert.equal(clean.errors, 0);
  assert.equal(clean.warnings, 0);
  const cleanText = outText(path.join(dir, 'clean'));
  for (const d of DEFECTS.defects) {
    const sub = path.join(dir, d.id);
    const r = build(sub, applyDefects(loadBase(), [d.id]));
    assert.equal(r.status, 0, `${d.id}：腳本沒有正常結束\n${r.output}`);
    assert.deepEqual(r.messages, clean.messages, `${d.id}：腳本的檢查結果和沒埋錯時不一樣，這一條腳本抓得到，換一個或移到 check-messages 測試`);
    assert.notEqual(outText(sub), cleanText, `${d.id}：分鏡表與 settings.md 都沒有變，審查代理看不到這個錯`);
  }
});

test('埋錯：全部一起套上，腳本的檢查結果和沒埋錯時一樣', (t) => {
  const dir = tmp(t);
  const clean = build(path.join(dir, 'clean'), loadBase());
  const all = build(path.join(dir, 'all'), applyDefects(loadBase()));
  assert.equal(all.status, 0, all.output);
  assert.deepEqual(all.messages, clean.messages);
});

test('埋錯：from 和範例對不上時會說出是哪一條', () => {
  const files = loadBase();
  files['EP01.json'].shots.find((s) => s.id === 'EP01-006').lens = '標準';
  assert.throws(() => applyDefects(files, ['C5']), /C5 .*範例改過了/);
});
