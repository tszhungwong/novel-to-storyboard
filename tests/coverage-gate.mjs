#!/usr/bin/env node
// 把關：腳本裡每一個檢查（err、warn、hint）都要有測試觸發過至少一次。
// 用 NODE_V8_COVERAGE 跑完整的 `node --test`（測試裡另外開的腳本行程也會記下來），
// 再看每一個呼叫點本身有沒有執行過。有沒觸發過的檢查就列出來並失敗。
// 執行：node tests/coverage-gate.mjs（需要 Node 18 以上；CI 在跑完 node --test 之後跑它）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
// 真的測不到的檢查：寫訊息開頭的一段字，並說明為什麼。目前沒有
const ALLOW = [];

const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-cov-'));
try {
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: covDir }, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stdout.write(r.stdout.split('\n').filter((l) => /^(not ok|# (tests|pass|fail))/.test(l)).join('\n') + '\n');
    console.error('node --test 沒有全部通過，先修好測試再看覆蓋');
    process.exit(1);
  }

  const src = fs.readFileSync(TARGET, 'utf8');
  const url = decodeURIComponent(pathToFileURL(TARGET).href).toLowerCase();
  const hit = new Uint8Array(src.length);
  let runs = 0;
  for (const f of fs.readdirSync(covDir)) {
    const data = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8'));
    for (const sc of data.result || []) {
      if (decodeURIComponent(sc.url).toLowerCase() !== url) continue;
      runs++;
      // 範圍是巢狀的：外層先填、內層蓋上去，最後每個字元是最內層那一段的執行次數
      const ranges = sc.functions.flatMap((fn) => fn.ranges)
        .sort((a, b) => a.startOffset - b.startOffset || (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
      const cnt = new Int32Array(src.length);
      for (const g of ranges) cnt.fill(g.count, g.startOffset, Math.min(g.endOffset, src.length));
      for (let i = 0; i < src.length; i++) if (cnt[i] > 0) hit[i] = 1;
    }
  }
  if (!runs) {
    console.error(`沒有收到 ${path.relative(ROOT, TARGET)} 的覆蓋資料；測試有沒有跑到腳本？`);
    process.exit(1);
  }

  const lines = src.split('\n');
  const sites = [];
  for (const m of src.matchAll(/(?<![\w.])(err|warn|hint)\(/g)) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    if (/^\s*(function|const)\s+(err|warn|hint)\b/.test(lines[lineNo - 1])) continue; // 定義本身
    const text = src.slice(m.index, m.index + 200).split('\n')[0];
    sites.push({ lineNo, text, hit: !!hit[m.index] });
  }
  const missed = sites.filter((s) => !s.hit && !ALLOW.some((a) => s.text.includes(a.text)));
  console.log(`${path.relative(ROOT, TARGET)}：${sites.length} 個檢查，測試觸發過 ${sites.length - missed.length} 個（腳本跑了 ${runs} 次）`);
  if (missed.length) {
    console.log('\n這些檢查沒有任何測試觸發過；在 tests/check-messages.test.mjs 加一筆會觸發它的案例：');
    for (const s of missed) console.log(`  ${s.lineNo}: ${s.text.slice(0, 120)}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(covDir, { recursive: true, force: true });
}
