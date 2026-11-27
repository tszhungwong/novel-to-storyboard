// 範例的產出要和 repo 裡的 out/ 一致：改了腳本卻忘了重跑範例，這裡會失敗。
// 失敗時照 README「自己跑檢查腳本」那一節的指令重跑範例，再把 out/ 一起提交。
// 執行：node --test（需要 Node 18 以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
const N = path.join(ROOT, 'skills', 'novel-to-storyboard', 'examples');
const O = path.join(ROOT, 'skills', 'outline-to-episodes', 'examples');

const EXAMPLES = [
  ['novel-to-storyboard/examples', path.join(N, 'bible.json'), path.join(N, 'EP01.json'), path.join(N, 'out')],
  ...['creature-fx', 'en-action', 'live-action'].map((x) => [`novel-to-storyboard/examples/${x}`, path.join(N, x, 'bible.json'), path.join(N, x, 'EP01.json'), path.join(N, x, 'out')]),
  ['outline-to-episodes/examples', path.join(O, 'bible.json'), path.join(O, 'series.json'), path.join(O, 'out')],
];
// Windows 的 git 可能把 .md 取出成 CRLF；比的是內容，不比換行符號
const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

for (const [name, bible, second, committed] of EXAMPLES) {
  test(`範例 ${name} 的 out/ 和腳本現在的產出一致`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-example-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const r = spawnSync(process.execPath, [SCRIPT, bible, second, '--out', tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const made = fs.readdirSync(tmp).filter((f) => fs.statSync(path.join(tmp, f)).isFile()).sort();
    const kept = fs.readdirSync(committed).filter((f) => fs.statSync(path.join(committed, f)).isFile()).sort();
    assert.deepEqual(kept, made, `out/ 裡的檔案和腳本產出的不一樣：${committed}`);
    for (const f of made) {
      assert.equal(norm(fs.readFileSync(path.join(committed, f))), norm(fs.readFileSync(path.join(tmp, f))), `${name}/out/${f} 和腳本現在的產出不一樣；重跑這個範例，再把 out/ 一起提交`);
    }
  });
}
