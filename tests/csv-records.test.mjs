// 重跑腳本時，CSV 手填紀錄的保留、備份、已移除檔，以及集數與檔名的檢查。
// 執行：node --test tests/（需要 Node 18 以上；腳本本身 Node 16 就能跑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
const EXAMPLE = path.join(ROOT, 'skills', 'novel-to-storyboard', 'examples');

// ---------- 小工具 ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch !== '"') f += ch;
      else if (s[i + 1] === '"') { f += '"'; i++; } else q = false;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (ch !== '\r') f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
const toCsv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const readTable = (p) => parseCsv(fs.readFileSync(p, 'utf8'));
const writeTable = (p, rows) => fs.writeFileSync(p, toCsv(rows), 'utf8');
const col = (rows, name) => rows[0].indexOf(name);
const cellOf = (rows, key, name, keyName = '鏡號') => {
  const r = rows.find((x) => x[col(rows, keyName)] === key);
  return r ? r[col(rows, name)] : undefined;
};
/** 改一格（找不到欄名就在最後加一欄）。 */
function setCell(p, key, name, value, keyName = '鏡號') {
  const rows = readTable(p);
  let c = col(rows, name);
  if (c < 0) {
    rows[0].push(name);
    c = rows[0].length - 1;
  }
  const r = rows.find((x) => x[col(rows, keyName)] === key);
  while (r.length <= c) r.push('');
  r[c] = value;
  writeTable(p, rows);
}

/** 把範例的 bible.json 與 EP01.json 複製到一個暫存資料夾，回傳路徑與執行腳本的函式。 */
function project(t, { epName = 'EP01.json', editBible, editEp } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-test-'));
  t.after(() => {
    for (const f of walk(dir)) {
      try { fs.chmodSync(f, 0o666); } catch { /* 清理用 */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bible = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'bible.json'), 'utf8'));
  const ep = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'EP01.json'), 'utf8'));
  const files = {
    bible: path.join(dir, 'bible.json'),
    ep: path.join(dir, epName),
    out: path.join(dir, 'out'),
  };
  const save = () => {
    fs.writeFileSync(files.bible, JSON.stringify(bible, null, 2));
    fs.writeFileSync(files.ep, JSON.stringify(ep, null, 2));
  };
  if (editBible) editBible(bible);
  if (editEp) editEp(ep);
  save();
  // fail：讓這幾個檔案寫入或刪除時故意失敗（腳本的 STORYBOARD_TEST_FAIL_FILES）
  const run = ({ fail = [] } = {}) => {
    const env = { ...process.env, STORYBOARD_TEST_FAIL_FILES: fail.join(',') };
    const r = spawnSync(process.execPath, [SCRIPT, files.bible, files.ep], { encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, bible, ep, files, save, run, csv: (name) => path.join(files.out, name) };
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
const backups = (p, prefix) => (fs.existsSync(path.join(p.files.out, '備份'))
  ? fs.readdirSync(path.join(p.files.out, '備份')).filter((x) => new RegExp(`^${prefix}-\\d{8}-\\d{6}(-\\d{3})?\\.csv$`).test(x))
  : []);

// ---------- 基本：手填與自己加的欄位會搬回來 ----------
test('重跑時保留手填的 seed 與使用者自己加的欄位', (t) => {
  const p = project(t);
  assert.equal(p.run().code, 0);
  setCell(p.csv('EP01-shots.csv'), 'EP01-002', 'seed', '12345');
  setCell(p.csv('EP01-shots.csv'), 'EP01-003', '剪接備忘', '這一鏡留長一點');
  p.ep.shots[1].duration = 3; // 改了分鏡
  p.save();
  const r = p.run();
  assert.equal(r.code, 0, r.out);
  const rows = readTable(p.csv('EP01-shots.csv'));
  assert.equal(cellOf(rows, 'EP01-002', 'seed'), '12345');
  assert.equal(cellOf(rows, 'EP01-003', '剪接備忘'), '這一鏡留長一點');
  assert.match(r.out, /保留自己加的欄位：剪接備忘/);
});

// ---------- 換了設定後，舊的提示詞欄位不能當成使用者的欄位 ----------
test('use_last_frame 改成 false：舊的尾幀欄位不留下，沒有紀錄的鏡頭刪掉也不搬到已移除', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-002', 'seed', '111');
  p.bible.project.use_last_frame = false;
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-008');
  p.save();
  const r = p.run();
  assert.equal(r.code, 0, r.out);
  const rows = readTable(p.csv('EP01-shots.csv'));
  assert.ok(!rows[0].some((h) => h.startsWith('尾幀提示詞')), `不該留下尾幀欄：${rows[0].join(',')}`);
  assert.doesNotMatch(r.out, /保留自己加的欄位/);
  assert.equal(cellOf(rows, 'EP01-002', 'seed'), '111');
  assert.ok(!fs.existsSync(p.csv('EP01-shots-已移除.csv')), '沒有手填紀錄的鏡頭不該被搬到已移除');
});

test('提示詞語言從雙語改成中文：舊的（英文）欄位不留下', (t) => {
  const p = project(t, { editBible: (b) => { b.project.prompt_langs = ['zh', 'en']; } });
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-001', '驗收結果', '通過');
  p.bible.project.prompt_langs = ['zh'];
  p.save();
  const r = p.run();
  const rows = readTable(p.csv('EP01-shots.csv'));
  assert.ok(!rows[0].some((h) => /（英文）|（中文）/.test(h)), rows[0].join(','));
  assert.equal(cellOf(rows, 'EP01-001', '驗收結果'), '通過');
  assert.doesNotMatch(r.out, /保留自己加的欄位/);
});

// ---------- 同一個鏡號有好幾列 ----------
test('使用者複製一列記第二次抽卡：兩列都保留', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const rows = readTable(file);
  const i = rows.findIndex((r) => r[0] === 'EP01-002');
  const seed = col(rows, 'seed');
  const copy = [...rows[i]];
  rows[i][seed] = '111';
  copy[seed] = '222';
  rows.splice(i + 1, 0, copy);
  writeTable(file, rows);
  const r = p.run();
  assert.equal(r.code, 0, r.out);
  const after = readTable(file).filter((x) => x[0] === 'EP01-002').map((x) => x[seed]);
  assert.deepEqual(after, ['111', '222']);
  assert.match(r.out, /EP01-002 有不只一列紀錄/);
  // 再跑一次也一樣（不會越跑越多）
  p.run();
  assert.deepEqual(readTable(file).filter((x) => x[0] === 'EP01-002').map((x) => x[seed]), ['111', '222']);
});

// ---------- 沒有欄名的欄 ----------
test('沒有欄名的欄裡寫的字會保留，並且先備份', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const rows = readTable(file);
  const width = rows[0].length;
  rows.forEach((r) => { while (r.length < width + 1) r.push(''); });
  rows.find((r) => r[0] === 'EP01-004')[width] = '重拍：手指變形';
  writeTable(file, rows);
  p.run();
  const after = readTable(file);
  const name = `欄位${width + 1}`;
  assert.ok(after[0].includes(name), after[0].join(','));
  assert.equal(cellOf(after, 'EP01-004', name), '重拍：手指變形');
  assert.equal(backups(p, 'EP01-shots').length, 1);
});

// ---------- 寫不進去的時候 ----------
test('主檔寫不進去時，已移除檔不動，紀錄之後還能搬回來', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const removed = p.csv('EP01-shots-已移除.csv');
  setCell(file, 'EP01-008', 'seed', '888');
  const last = p.ep.shots.pop();
  p.save();
  p.run();
  assert.equal(cellOf(readTable(removed), 'EP01-008', 'seed'), '888');
  p.ep.shots.push(last);
  p.save();
  fs.chmodSync(file, 0o444);
  if (probeWritable(file)) {
    t.skip('這個環境設成唯讀也寫得進去（例如以 root 執行）');
    return;
  }
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /EP01-shots\.csv：寫不進去/);
  assert.doesNotMatch(r.out, /搬回 1 列/, '寫不進去時不該說已經搬回');
  assert.ok(fs.existsSync(removed), '主檔沒寫成功，已移除檔不能先刪');
  assert.equal(cellOf(readTable(removed), 'EP01-008', 'seed'), '888');
  fs.chmodSync(file, 0o666);
  const r2 = p.run();
  assert.equal(r2.code, 0, r2.out);
  assert.equal(cellOf(readTable(file), 'EP01-008', 'seed'), '888');
  assert.ok(!fs.existsSync(removed));
});

test('已移除檔寫不進去時，主檔也不更新', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const removed = p.csv('EP01-shots-已移除.csv');
  setCell(file, 'EP01-007', 'seed', '777');
  setCell(file, 'EP01-008', 'seed', '888');
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-008');
  p.save();
  p.run(); // 008 搬到已移除
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-007');
  p.save();
  fs.chmodSync(removed, 0o444);
  if (probeWritable(removed)) {
    t.skip('這個環境設成唯讀也寫得進去');
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /EP01-shots-已移除\.csv/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '主檔不該被改');
  assert.equal(cellOf(readTable(file), 'EP01-007', 'seed'), '777');
});
function probeWritable(p) {
  try {
    fs.closeSync(fs.openSync(p, 'r+'));
    return true;
  } catch {
    return false;
  }
}

// ---------- 備份 ----------
test('內容沒變不備份，也不會產生一樣的備份', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-001', 'seed', '1');
  // 舊檔有手填紀錄，但重跑出來的內容和舊檔一模一樣：沒有東西會被蓋掉，不用備份
  for (let k = 0; k < 3; k++) p.run();
  assert.deepEqual(backups(p, 'EP01-shots'), []);
  // 分鏡改了才備份；之後再跑、內容沒變，不會多出一樣的備份
  p.ep.shots[0].duration = 4;
  p.save();
  for (let k = 0; k < 3; k++) p.run();
  assert.equal(backups(p, 'EP01-shots').length, 1, backups(p, 'EP01-shots').join(','));
});

test('備份保留最近五份，另外保留前幾天各一份', (t) => {
  const p = project(t);
  p.run();
  const dir = path.join(p.files.out, '備份');
  fs.mkdirSync(dir, { recursive: true });
  // 前三天各兩份舊格式（沒有毫秒）的備份
  for (const day of ['20261101', '20261102', '20261103']) {
    for (const time of ['090000', '180000']) fs.writeFileSync(path.join(dir, `EP01-shots-${day}-${time}.csv`), `${day}${time}`);
  }
  for (let k = 0; k < 6; k++) {
    p.ep.shots[0].duration = 3 + k * 0.5; // 每次都改，內容才會不一樣
    p.save();
    p.run();
  }
  const list = backups(p, 'EP01-shots');
  const old = list.filter((x) => /-202611(01|02|03)-/.test(x));
  assert.deepEqual(old.sort(), ['EP01-shots-20261101-180000.csv', 'EP01-shots-20261102-180000.csv', 'EP01-shots-20261103-180000.csv']);
  assert.equal(list.length - old.length, 5);
});

// ---------- 資產換語言 ----------
test('assets.csv：提示詞語言從中文改成英文，定稿檔名跟著搬過去', (t) => {
  const p = project(t, { editBible: (b) => { b.project.prompt_langs = ['zh']; } });
  p.run();
  const file = p.csv('assets.csv');
  const rows = readTable(file);
  const first = rows[1];
  setCell(file, first[0], '定稿檔名', 'C01_final.png', '編號');
  p.bible.project.prompt_langs = ['en'];
  p.save();
  const r = p.run();
  const after = readTable(file);
  const hit = after.find((x) => x[0] === first[0] && x[col(after, '類型')] === first[col(rows, '類型')]);
  assert.equal(hit[col(after, '定稿檔名')], 'C01_final.png', r.out);
  assert.ok(!fs.existsSync(p.csv('assets-已移除.csv')));
});

// ---------- animatic ----------
test('animatic.csv：使用者加的欄位重跑後還在', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-animatic.csv'), 'EP01-003', '素材檔名', 'EP01-003_F.png');
  p.run();
  assert.equal(cellOf(readTable(p.csv('EP01-animatic.csv')), 'EP01-003', '素材檔名'), 'EP01-003_F.png');
});

// ---------- 集數與檔名 ----------
test('EP02.json 的 episode 忘了改：報錯，而且不蓋掉 EP01 的產出', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-002', 'seed', '222');
  const before = fs.readFileSync(p.csv('EP01-shots.csv'), 'utf8');
  const beforeMd = fs.readFileSync(p.csv('EP01-storyboard.md'), 'utf8');
  const ep2 = path.join(p.dir, 'EP02.json');
  fs.copyFileSync(p.files.ep, ep2);
  const r = spawnSync(process.execPath, [SCRIPT, p.files.bible, ep2], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /episode 寫的是 EP01，檔名卻是 EP02\.json/);
  assert.equal(fs.readFileSync(p.csv('EP01-shots.csv'), 'utf8'), before);
  assert.equal(fs.readFileSync(p.csv('EP01-storyboard.md'), 'utf8'), beforeMd);
  assert.ok(!fs.existsSync(p.csv('EP01-shots-已移除.csv')));
});

test('沒填 episode：報錯，檔名照分鏡檔的檔名', (t) => {
  const p = project(t, { epName: 'EP03.json', editEp: (e) => { delete e.episode; } });
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /缺少 episode/);
  assert.ok(fs.existsSync(p.csv('EP03-shots.csv')));
  assert.ok(!fs.existsSync(p.csv('EP-shots.csv')));
});

test('鏡號不是這一集開頭：警告', (t) => {
  const p = project(t, {
    epName: 'EP02.json',
    editEp: (e) => { e.episode = 'EP02'; },
  });
  const r = p.run();
  assert.match(r.out, /\[警告\] 分鏡檔：有 8 鏡的鏡號不是 EP02- 開頭/);
});

// ---------- 第二輪：重新審查後找到的問題 ----------
const rowsOf = (file, id) => readTable(file).filter((x) => x[0] === id);
const removedRows = (p, id) => (fs.existsSync(p.csv('EP01-shots-已移除.csv')) ? rowsOf(p.csv('EP01-shots-已移除.csv'), id) : []);
/** 模擬 Excel「另存成 Unicode 文字」：UTF-16、Tab 分隔，腳本讀不懂。 */
const utf16 = (file) => {
  const text = readTable(file).map((r) => r.join('\t')).join('\r\n');
  fs.writeFileSync(file, Buffer.from(`\uFEFF${text}`, 'utf16le'));
};

test('R1：使用者自己加的「參考圖路徑」「影片提示詞（改）」不會被當成腳本產生的欄位刪掉', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  setCell(file, 'EP01-003', '參考圖路徑', 'D:/refs/EP01-003.png');
  setCell(file, 'EP01-004', '影片提示詞（改）', '動作再慢一點');
  p.ep.shots[0].duration = 4;
  p.save();
  const r = p.run();
  assert.equal(cellOf(readTable(file), 'EP01-003', '參考圖路徑'), 'D:/refs/EP01-003.png', r.out);
  assert.equal(cellOf(readTable(file), 'EP01-004', '影片提示詞（改）'), '動作再慢一點');
  // 那一鏡刪掉時，紀錄要搬到已移除
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-003');
  p.save();
  p.run();
  assert.equal(cellOf(readTable(p.csv('EP01-shots-已移除.csv')), 'EP01-003', '參考圖路徑'), 'D:/refs/EP01-003.png');
});

test('R1：animatic.csv 裡叫「參考圖」「影片提示詞」的欄是使用者的，要保留', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-animatic.csv');
  setCell(file, 'EP01-002', '參考圖', 'ref.png');
  setCell(file, 'EP01-002', '影片提示詞', '自己寫的');
  p.run();
  assert.equal(cellOf(readTable(file), 'EP01-002', '參考圖'), 'ref.png');
  assert.equal(cellOf(readTable(file), 'EP01-002', '影片提示詞'), '自己寫的');
});

test('R2：已移除檔刪不掉時，下次重跑不會變成兩列', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-008', 'seed', '888');
  const last = p.ep.shots.pop();
  p.save();
  p.run();
  p.ep.shots.push(last);
  p.save();
  const r = p.run({ fail: ['EP01-shots-已移除.csv'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /刪不掉/);
  assert.equal(cellOf(readTable(p.csv('EP01-shots.csv')), 'EP01-008', 'seed'), '888');
  p.run();
  assert.equal(rowsOf(p.csv('EP01-shots.csv'), 'EP01-008').length, 1);
  assert.ok(!fs.existsSync(p.csv('EP01-shots-已移除.csv')));
});

test('R2：主檔寫到一半失敗，紀錄不丟、也不重複', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-007', 'seed', '777');
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-007');
  p.save();
  const r = p.run({ fail: ['EP01-shots.csv'] });
  assert.equal(r.code, 1);
  assert.equal(cellOf(readTable(p.csv('EP01-shots-已移除.csv')), 'EP01-007', 'seed'), '777', '要離開主檔的紀錄要先進已移除檔');
  const r2 = p.run();
  assert.equal(r2.code, 0, r2.out);
  assert.equal(rowsOf(p.csv('EP01-shots.csv'), 'EP01-007').length, 0);
  assert.equal(removedRows(p, 'EP01-007').length, 1, '已移除檔裡只能有一列');
});

test('R2：同一次有鏡頭刪掉、也有鏡頭加回來，主檔寫失敗後重跑，兩邊都對', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-007', 'seed', '777');
  setCell(p.csv('EP01-shots.csv'), 'EP01-008', 'seed', '888');
  const s8 = p.ep.shots.find((s) => s.id === 'EP01-008');
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-008');
  p.save();
  p.run(); // 008 到已移除
  p.ep.shots = p.ep.shots.filter((s) => s.id !== 'EP01-007').concat([s8]);
  p.save();
  assert.equal(p.run({ fail: ['EP01-shots.csv'] }).code, 1);
  assert.equal(removedRows(p, 'EP01-008').length, 1, '還沒寫進主檔的 008 不能先從已移除拿掉');
  p.run();
  const main = readTable(p.csv('EP01-shots.csv'));
  assert.deepEqual(main.filter((x) => x[0] === 'EP01-008').map((x) => x[col(main, 'seed')]), ['888']);
  assert.equal(removedRows(p, 'EP01-007').length, 1);
  assert.equal(removedRows(p, 'EP01-008').length, 0);
});

test('R3：已移除檔讀不懂時不刪也不覆蓋，主檔也不更新', (t) => {
  const p = project(t);
  p.run();
  setCell(p.csv('EP01-shots.csv'), 'EP01-008', 'seed', '888');
  const last = p.ep.shots.pop();
  p.save();
  p.run();
  utf16(p.csv('EP01-shots-已移除.csv'));
  const before = fs.readFileSync(p.csv('EP01-shots-已移除.csv'));
  const mainBefore = fs.readFileSync(p.csv('EP01-shots.csv'));
  p.ep.shots.push(last);
  p.save();
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /讀不懂 EP01-shots-已移除\.csv/);
  assert.ok(fs.readFileSync(p.csv('EP01-shots-已移除.csv')).equals(before));
  assert.ok(fs.readFileSync(p.csv('EP01-shots.csv')).equals(mainBefore));
});

test('R4：標題列上面多插一列，紀錄照樣搬', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  setCell(file, 'EP01-002', 'seed', '222');
  writeTable(file, [['第一集抽卡紀錄'], ...readTable(file)]);
  const r = p.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(cellOf(readTable(file), 'EP01-002', 'seed'), '222');
  assert.match(r.out, /標題列上面的 1 列/);
});

test('R4：主檔讀不懂時不覆蓋', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  setCell(file, 'EP01-002', 'seed', '222');
  utf16(file);
  const before = fs.readFileSync(file);
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /讀不懂 EP01-shots\.csv/);
  assert.ok(fs.readFileSync(file).equals(before));
});

test('R4：有手填紀錄卻備份不起來時不覆蓋', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  setCell(file, 'EP01-002', 'seed', '222');
  fs.writeFileSync(path.join(p.files.out, '備份'), '這是一個檔案，不是資料夾');
  p.ep.shots[0].duration = 4;
  p.save();
  const before = fs.readFileSync(file);
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /備份不起來/);
  assert.ok(fs.readFileSync(file).equals(before));
});

test('R5：兩欄都叫「備註」時，兩欄的內容都留著', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const rows = readTable(file);
  rows[0].push('備註');
  rows.slice(1).forEach((r) => { while (r.length < rows[0].length) r.push(''); });
  rows.find((r) => r[0] === 'EP01-001')[col(rows, '備註')] = '第一欄的備註';
  rows.find((r) => r[0] === 'EP01-002')[rows[0].length - 1] = '第二欄的備註';
  writeTable(file, rows);
  p.run();
  const after = readTable(file);
  assert.equal(cellOf(after, 'EP01-001', '備註'), '第一欄的備註');
  assert.equal(cellOf(after, 'EP01-002', '備註(2)'), '第二欄的備註');
});

test('R6：同一個資產有兩列紀錄，換了提示詞語言也一起跟過去', (t) => {
  const p = project(t, { editBible: (b) => { b.project.prompt_langs = ['zh']; } });
  p.run();
  const file = p.csv('assets.csv');
  const rows = readTable(file);
  const name = col(rows, '定稿檔名');
  const kindCol = col(rows, '類型');
  const copy = [...rows[1]];
  rows[1][name] = 'v1.png';
  copy[name] = 'v2.png';
  rows.splice(2, 0, copy);
  writeTable(file, rows);
  const [id, kind] = [rows[1][0], rows[1][kindCol]];
  p.bible.project.prompt_langs = ['en'];
  p.save();
  const r = p.run();
  const after = readTable(file).filter((x) => x[0] === id && x[kindCol] === kind).map((x) => x[name]);
  assert.deepEqual(after, ['v1.png', 'v2.png'], r.out);
  assert.ok(!fs.existsSync(p.csv('assets-已移除.csv')));
});

test('R7：EP01-2.json 寫 EP01-2、EP101.json 寫 S1E01，都不擋', (t) => {
  const a = project(t, { epName: 'EP01-2.json', editEp: (e) => { e.episode = 'EP01-2'; } });
  assert.doesNotMatch(a.run().out, /檔名卻是/);
  assert.ok(fs.existsSync(a.csv('EP01-2-shots.csv')));
  const b = project(t, { epName: 'EP101.json', editEp: (e) => { e.episode = 'S1E01'; } });
  assert.doesNotMatch(b.run().out, /檔名卻是/);
  assert.ok(fs.existsSync(b.csv('S1E01-shots.csv')));
});

test('R7：episode 有控制字元就擋', (t) => {
  const p = project(t, { editEp: (e) => { e.episode = 'EP01\u0001'; } });
  const r = p.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /不能放進檔名的字/);
  assert.doesNotMatch(r.out, /ENOENT/);
});

test('R8：沒填 episode 時，照檔名找分集表的那一集', (t) => {
  const p = project(t, { editEp: (e) => { delete e.episode; } });
  fs.writeFileSync(path.join(p.dir, 'series.json'), JSON.stringify({
    episodes: [{ episode: 'EP01', title: '信', logline: '她把信交給他', hook: '鉤子測試：桌上那封沒拆的信', payoff: '她把信推給他', cliff: '信裡寫了什麼？' }],
  }));
  const r = p.run();
  assert.doesNotMatch(r.out, /series\.json 裡沒有/);
  assert.match(fs.readFileSync(p.csv('EP01-storyboard.md'), 'utf8'), /鉤子測試：桌上那封沒拆的信/);
});

test('R9：舊檔內容和最新一份備份一樣時，不再多一份備份', (t) => {
  const p = project(t);
  p.run();
  const file = p.csv('EP01-shots.csv');
  const v1 = fs.readFileSync(file);
  p.ep.shots[0].duration = 4;
  p.save();
  p.run(); // 備份 v1
  assert.equal(backups(p, 'EP01-shots').length, 1);
  fs.writeFileSync(file, v1); // 使用者從備份還原了 v1，又照同樣的分鏡重跑
  p.run();
  assert.equal(backups(p, 'EP01-shots').length, 1, '內容和最新一份備份一樣，不該再備份');
});
