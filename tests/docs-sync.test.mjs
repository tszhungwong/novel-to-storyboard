// references/fields.md 和腳本要對得上：文件寫的欄位與用詞，腳本都認得；腳本認得的，文件都有寫。
// 只改了一邊（新增欄位卻沒寫文件、改了用詞卻沒改腳本），這裡會失敗。
// 執行：node --test（需要 Node 18 以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MD = fs.readFileSync(path.join(ROOT, 'skills', 'novel-to-storyboard', 'references', 'fields.md'), 'utf8').replace(/\r\n/g, '\n');
const JS = fs.readFileSync(path.join(ROOT, 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs'), 'utf8').replace(/\r\n/g, '\n');

// ---------- 讀文件 ----------
/** fields.md 某一節（## 或 ### 標題，到下一個標題為止）裡所有表格的第一欄，不含標題列 */
function firstColumn(heading) {
  const sec = MD.split(/\n(?=#{2,3} )/).find((s) => s.split('\n')[0].replace(/^#+\s*/, '') === heading);
  assert.ok(sec, `fields.md 找不到「${heading}」這一節`);
  const cells = [];
  let block = [];
  for (const line of [...sec.split('\n'), '']) {
    if (line.startsWith('|')) block.push(line);
    else {
      cells.push(...block.slice(2).map((l) => l.split('|')[1].trim()));
      block = [];
    }
  }
  return { cells, text: sec };
}
/** 欄位名稱：第一欄裡 `name` 或 `name[]` 的部分（「`clip_range` 或 `clip_lengths`」算兩個） */
const docFields = (heading) => [...new Set(firstColumn(heading).cells.flatMap((c) => [...c.matchAll(/`(\w+)(?:\[\])?`/g)].map((m) => m[1])))];
/** 用詞：第一欄的詞，「推近、拉遠」這種寫在同一格的拆開 */
const docTerms = (heading) => firstColumn(heading).cells.flatMap((c) => c.split('、')).map((x) => x.replace(/`/g, '').trim()).filter(Boolean);

// ---------- 讀腳本 ----------
/** const NAME = ['a', 'b'] 的內容 */
function arrayConst(name) {
  const m = JS.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `腳本裡找不到 const ${name} = [ … ]`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
/** const NAME = { key: …, … }; 的鍵：每一筆各佔一行，或整個物件寫在同一行 */
function objectKeys(name) {
  const multi = JS.match(new RegExp(`const ${name} = \\{\\n([\\s\\S]*?)\\n\\};`));
  if (multi) return [...multi[1].matchAll(/^ {2}(?:'([^']+)'|([^\s:'/]+)):/gm)].map((x) => x[1] || x[2]);
  const one = JS.match(new RegExp(`const ${name} = \\{([^\\n]*)\\};`));
  assert.ok(one, `腳本裡找不到 const ${name} = { … }`);
  return [...one[1].matchAll(/(?:^|,)\s*(?:'([^']+)'|([^\s:',]+)):/g)].map((x) => x[1] || x[2]);
}
const sameSet = (doc, code, what) => {
  const d = new Set(doc);
  const c = new Set(code);
  const onlyDoc = [...d].filter((x) => !c.has(x));
  const onlyCode = [...c].filter((x) => !d.has(x));
  assert.deepEqual({ 文件有腳本沒有: onlyDoc, 腳本有文件沒有: onlyCode }, { 文件有腳本沒有: [], 腳本有文件沒有: [] }, what);
};

test('project 的欄位：文件寫的就是腳本讀的', () => {
  const reads = [...new Set([...JS.matchAll(/\bP\.(\w+)/g)].map((m) => m[1]))];
  sameSet(docFields('project'), reads, 'fields.md 的 project 表 vs 腳本讀的 P.xxx');
});

test('分鏡檔的欄位：EPxx.json、plan、setups、shots、cast 和腳本認得的欄位一致', () => {
  sameSet(docFields('EPxx.json'), arrayConst('EP_KEYS'), 'EPxx.json 最外層 vs EP_KEYS');
  sameSet(docFields('plan[]'), arrayConst('PLAN_KEYS'), 'plan[] vs PLAN_KEYS');
  sameSet(docFields('setups[]'), arrayConst('SETUP_KEYS'), 'setups[] vs SETUP_KEYS');
  sameSet(docFields('shots[]'), arrayConst('SHOT_KEYS'), 'shots[] vs SHOT_KEYS');
  sameSet(docFields('cast[]'), arrayConst('CAST_KEYS'), 'cast[] vs CAST_KEYS');
});

test('設定檔與分集表：文件寫的每一個欄位，腳本都有讀', () => {
  const read = (n) => new RegExp(`(\\.|\\['|'|")${n}\\b`).test(JS) || (n.endsWith('_states') && JS.includes('${key}_states'));
  for (const h of ['characters[]', 'scenes[]', 'props[]', 'effects[]', '其他', 'series.json', 'episodes[]']) {
    const unread = docFields(h).filter((n) => !read(n));
    assert.deepEqual(unread, [], `fields.md 的 ${h} 寫了這些欄位，腳本卻沒有讀：${unread.join('、')}`);
  }
});

test('用詞表：文件列的詞就是腳本認得的詞', () => {
  sameSet(docTerms('景別（`size`）'), objectKeys('SIZES'), '景別');
  sameSet(docTerms('人物朝向（`cast[].facing`）'), objectKeys('FACINGS'), '人物朝向');
  sameSet(docTerms('鏡頭類型（`type`）'), objectKeys('TYPES'), '鏡頭類型');
  sameSet(docTerms('角度（`angle`）'), objectKeys('ANGLES'), '角度');
  sameSet(docTerms('機位高度（`height`）'), objectKeys('HEIGHTS'), '機位高度');
  sameSet(docTerms('焦段（`lens`）'), objectKeys('LENSES'), '焦段');
  sameSet(docTerms('運鏡（`camera`）'), objectKeys('MOVES'), '運鏡');
  sameSet(docTerms('速度（`speed`）'), objectKeys('SPEEDS'), '速度');
  sameSet(docTerms('生成方式（`render`）'), arrayConst('RENDERS'), '生成方式');
  sameSet(docTerms('轉場（`transition`）'), arrayConst('TRANSITIONS'), '轉場');
  // 台詞類型：VO、OS 是舊檔的寫法，腳本照收，文件在表格下面說明
  const lineTypes = arrayConst('LINE_TYPES');
  sameSet(docTerms('台詞類型（`line.type`）'), lineTypes.filter((x) => !['VO', 'OS'].includes(x)), '台詞類型');
  assert.match(firstColumn('台詞類型（`line.type`）').text, /`VO`、`OS`/);
});

test('運鏡的前綴：腳本認得的每一個，文件都有寫', () => {
  const text = firstColumn('運鏡（`camera`）').text;
  for (const p of objectKeys('MOVE_PREFIX')) assert.match(text, new RegExp(`「${p}」`), `運鏡一節沒有提到前綴「${p}」`);
});
