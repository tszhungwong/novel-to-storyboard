// hooks/check-storyboard.cjs：改了分鏡檔之後自動檢查，把錯誤與警告回給模型。
// 每個測試在暫存資料夾建一個專案，餵 hook 和 Claude Code／Codex 一樣的輸入。
// 執行：node --test（需要 Node 18 以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'check-storyboard.cjs');
const EXAMPLE = path.join(ROOT, 'skills', 'novel-to-storyboard', 'examples');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * 用主範例建一個專案：bible.json 加上 count 集分集檔（EP01、EP02⋯，第二集起是第一集改了集數）。
 * editBible、editEp(e, 第幾集) 改內容。
 */
function project(t, { count = 1, editBible, editEp } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bible = readJson(path.join(EXAMPLE, 'bible.json'));
  if (editBible) editBible(bible);
  fs.writeFileSync(path.join(dir, 'bible.json'), typeof bible === 'string' ? bible : JSON.stringify(bible));
  const base = fs.readFileSync(path.join(EXAMPLE, 'EP01.json'), 'utf8');
  for (let k = 1; k <= count; k++) {
    const name = `EP${String(k).padStart(2, '0')}`;
    const ep = JSON.parse(base.split('EP01').join(name));
    if (editEp) editEp(ep, k);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(ep));
  }
  return dir;
}
/** 跑一次 hook；回傳給模型的文字（沒有輸出就是空字串）。 */
function hook(cwd, toolInput, env = {}) {
  const input = JSON.stringify({ cwd, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: toolInput });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}
const unknownChar = (id) => (e) => { e.shots[2].cast.push({ char: id, pos: '門邊', gaze: '看著屋內', hands: '垂著' }); };
const count = (text, s) => text.split(s).length - 1;

test('改了一集：只檢查這一集，列出錯誤', (t) => {
  const dir = project(t, { count: 2, editEp: (e, k) => { if (k === 1) unknownChar('C99')(e); } });
  const ctx = hook(dir, { file_path: path.join(dir, 'EP01.json') });
  assert.match(ctx, /- EP01\.json：錯誤 1/);
  assert.match(ctx, /\[錯誤\] EP01-003：角色編號 C99 不在設定檔裡/);
  assert.doesNotMatch(ctx, /EP02\.json/);
  assert.match(ctx, /只檢查，沒有更新 out\//);
});

test('沒有錯誤也沒有警告：不輸出（提示不算）', (t) => {
  const dir = project(t);
  assert.equal(hook(dir, { file_path: path.join(dir, 'EP01.json') }), '');
  assert.equal(hook(dir, { file_path: path.join(dir, 'bible.json') }), '');
});

test('無關的檔案、旁邊沒有分鏡用的 bible.json：不輸出', (t) => {
  const dir = project(t, { editEp: unknownChar('C99') });
  fs.writeFileSync(path.join(dir, 'notes.md'), '筆記');
  assert.equal(hook(dir, { file_path: path.join(dir, 'notes.md') }), '');
  const other = path.join(dir, 'other');
  fs.mkdirSync(other);
  fs.copyFileSync(path.join(dir, 'EP01.json'), path.join(other, 'EP01.json'));
  fs.writeFileSync(path.join(other, 'bible.json'), JSON.stringify({ name: '不是分鏡的設定檔' }));
  assert.equal(hook(dir, { file_path: path.join(other, 'EP01.json') }), '');
});

test('改了 bible.json：連帶檢查各集；設定檔的警告只列一次，提示只算不重複的', (t) => {
  const dir = project(t, { count: 2, editBible: (b) => { b.project.style_lock = `${b.project.style_lock}，暖色調`; } });
  const ctx = hook(dir, { file_path: path.join(dir, 'bible.json') });
  assert.match(ctx, /- bible\.json：/);
  assert.match(ctx, /- EP01\.json：/);
  assert.match(ctx, /- EP02\.json：/);
  assert.equal(count(ctx, '風格鎖定句寫了冷暖或主色'), 1, ctx);
  // 「還有幾項待確認設定」三次檢查都會出現，只算一則
  assert.match(ctx, /提示共 1 則沒有列出/);
});

test('bible.json 寫壞了：同一個原因只寫一行，列出受影響的檔案', (t) => {
  const dir = project(t, { count: 2, editBible: () => {} });
  fs.writeFileSync(path.join(dir, 'bible.json'), '{ "project": { "title": "x", }, "characters": [] }');
  const ctx = hook(dir, { file_path: path.join(dir, 'bible.json') });
  const lines = ctx.split('\n').filter((l) => /不是合法的 JSON|Unexpected|SyntaxError/.test(l));
  assert.equal(lines.length, 1, ctx);
  assert.match(lines[0], /^- bible\.json、EP01\.json、EP02\.json：/);
});

test('集數很多：只檢查最近改過的 20 集，並說還有幾集沒檢查', (t) => {
  const dir = project(t, { count: 25, editEp: (e, k) => { if (k === 1 || k === 25) unknownChar(`C9${k}`)(e); } });
  // EP01–EP05 是很久以前改的；照檔名取前 20 集會檢查到 EP01，照修改時間不會
  const old = new Date('2020-01-01');
  for (let k = 1; k <= 5; k++) fs.utimesSync(path.join(dir, `EP0${k}.json`), old, old);
  const ctx = hook(dir, { file_path: path.join(dir, 'bible.json') });
  assert.match(ctx, /- EP25\.json：錯誤 1/);
  assert.doesNotMatch(ctx, /EP01\.json/);
  assert.match(ctx, /這個資料夾還有 5 集沒有連帶檢查/);
});

test('時間上限：用完就停，說還有幾個檔案沒檢查', (t) => {
  const dir = project(t, { count: 3, editEp: unknownChar('C99') });
  const ctx = hook(dir, { file_path: path.join(dir, 'bible.json') }, { STORYBOARD_HOOK_BUDGET_MS: '1' });
  assert.match(ctx, /還有 \d+ 個檔案沒在時間內檢查/);
});

test('錯誤太多：只列 40 則，說還有幾則', (t) => {
  const dir = project(t, { editEp: (e) => { for (let k = 0; k < 50; k++) unknownChar(`C${200 + k}`)(e); } });
  const ctx = hook(dir, { file_path: path.join(dir, 'EP01.json') });
  assert.equal(ctx.split('\n').filter((l) => l.startsWith('  [')).length, 40);
  assert.match(ctx, /⋯還有 \d+ 則錯誤或警告沒有列出/);
});

test('Codex 的 apply_patch：從補丁裡找出改了哪個檔案（相對路徑照 cwd）', (t) => {
  const dir = project(t, { editEp: unknownChar('C99') });
  const patch = ['*** Begin Patch', '*** Update File: EP01.json', '@@', '-x', '+y', '*** End Patch'].join('\n');
  const ctx = hook(dir, { command: ['apply_patch', patch] });
  assert.match(ctx, /- EP01\.json：錯誤 1/);
});
