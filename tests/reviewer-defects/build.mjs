// 做出審查代理埋錯測試要用的分鏡：拿 defects.json 的底，套上（或不套）埋的錯，跑一次腳本產出 out/。
// 用法：
//   node tests/reviewer-defects/build.mjs <輸出資料夾>            套上全部埋的錯
//   node tests/reviewer-defects/build.mjs <輸出資料夾> --clean    不套，當對照組
//   node tests/reviewer-defects/build.mjs <輸出資料夾> --only C1,A2
// 輸出資料夾裡會有 bible.json、EP01.json 與 out/；把路徑交給三個審查代理（見 README 的「審查代理的埋錯測試」）。
// 不要把 defects.json 的路徑給審查代理，也不要用看得出有沒有埋錯的資料夾名稱。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SCRIPT = path.join(ROOT, 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
export const DEFECTS = JSON.parse(fs.readFileSync(path.join(HERE, 'defects.json'), 'utf8'));

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function loadBase() {
  const dir = path.join(ROOT, DEFECTS.base);
  return { 'bible.json': readJson(path.join(dir, 'bible.json')), 'EP01.json': readJson(path.join(dir, 'EP01.json')) };
}

// path 的每一段：字串是物件的鍵，數字是陣列索引，{ 鍵: 值 } 是在陣列裡找那個鍵等於值的元素
function step(node, seg, where) {
  if (seg && typeof seg === 'object') {
    if (!Array.isArray(node)) throw new Error(`${where}：${JSON.stringify(seg)} 要用在陣列上`);
    const [k, v] = Object.entries(seg)[0];
    const hit = node.find((x) => x && x[k] === v);
    if (!hit) throw new Error(`${where}：找不到 ${k} = ${v}`);
    return hit;
  }
  if (node == null || !(seg in node)) throw new Error(`${where}：找不到 ${seg}`);
  return node[seg];
}

/** 把 ids 裡的錯（預設全部）套到 files（{ 'bible.json': {...}, 'EP01.json': {...} }）上；from 對不上就丟錯 */
export function applyDefects(files, ids = DEFECTS.defects.map((d) => d.id)) {
  for (const id of ids) {
    const d = DEFECTS.defects.find((x) => x.id === id);
    if (!d) throw new Error(`defects.json 沒有 ${id}`);
    for (const e of d.edits) {
      const where = `${id} ${e.file} ${JSON.stringify(e.path)}`;
      let node = files[e.file];
      for (const seg of e.path.slice(0, -1)) node = step(node, seg, where);
      const last = e.path[e.path.length - 1];
      const cur = node[last];
      if (e.from === null ? cur !== undefined : !isDeepStrictEqual(cur, e.from)) {
        throw new Error(`${where}：範例現在的值和 from 不一樣，範例改過了，請更新 defects.json\n現在：${JSON.stringify(cur)}`);
      }
      node[last] = JSON.parse(JSON.stringify(e.to));
    }
  }
  return files;
}

/** 把 files 寫進 dir，跑腳本到 dir/out，回傳檢查結果 */
export function build(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n');
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'bible.json'), path.join(dir, 'EP01.json'), '--out', path.join(dir, 'out')], { encoding: 'utf8' });
  const tail = r.stdout.split('\n檢查：')[1] || '';
  const count = (label) => Number((tail.match(new RegExp(`${label} (\\d+)`)) || [])[1] ?? NaN);
  const messages = tail.split('\n').map((l) => l.trim()).filter((l) => /^\[(錯誤|警告|提示)\]/.test(l));
  return { status: r.status, errors: count('錯誤'), warnings: count('警告'), hints: count('提示'), messages, output: r.stdout + r.stderr };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--only');
  if (!out) {
    console.error('用法：node tests/reviewer-defects/build.mjs <輸出資料夾> [--clean | --only C1,A2]');
    process.exit(2);
  }
  const onlyAt = args.indexOf('--only');
  const ids = args.includes('--clean') ? [] : onlyAt >= 0 ? args[onlyAt + 1].split(',') : undefined;
  const files = applyDefects(loadBase(), ids);
  const r = build(path.resolve(out), files);
  console.log(`${path.resolve(out)}：埋了 ${ids ? ids.length : DEFECTS.defects.length} 條；腳本檢查 錯誤 ${r.errors}、警告 ${r.warnings}、提示 ${r.hints}`);
  for (const m of r.messages) console.log('  ' + m);
  process.exit(r.status ?? 1);
}
