#!/usr/bin/env node
/**
 * 分鏡自動檢查（PostToolUse hook，Claude Code 與 Codex 共用）
 *
 * 改了 storyboard 資料夾裡的 bible.json、EPxx.json、series.json 或 EPxx-script.md 之後，
 * 自動跑一次 build_storyboard.mjs，把錯誤與警告回給模型。
 *
 * - 只做檢查：產出寫到暫存資料夾、跑完就刪，不動使用者的 out/ 與 CSV 紀錄。
 *   要更新產出，照技能的流程自己執行腳本。
 * - 被改的檔案從 hook 輸入的 tool_input 找：Write／Edit 的 file_path，或 Codex apply_patch
 *   補丁裡的「*** Update File:」「*** Add File:」「*** Move to:」。
 * - 旁邊沒有分鏡用的 bible.json 就不做事。任何意外都安靜結束（exit 0、不輸出），不擋住工具。
 * - 沒有錯誤也沒有警告就不輸出，免得每改一次檔就在對話裡多一段字。
 * - 改了 bible.json 時連帶檢查最近改過的幾集；整個 hook 有時間上限，超過就停，說還有哪些沒檢查。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
const MAX_LINES = 40; // 回給模型的錯誤與警告最多幾行
const MAX_EPISODES = 20; // 改了 bible.json 時，最多連帶檢查幾集（最近改過的）
// 整個 hook 最多跑多久（毫秒）：Codex 的 hook 設定沒有 timeout，集數多時不能讓工具一直等。
// STORYBOARD_HOOK_BUDGET_MS 只給測試用
const BUDGET_MS = Number(process.env.STORYBOARD_HOOK_BUDGET_MS) > 0 ? Number(process.env.STORYBOARD_HOOK_BUDGET_MS) : 45000;

function main() {
  const started = Date.now();
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const targets = new Map(); // 要跑的參數組合，key 去重
  let notChecked = 0; // 集數超過上限、沒有連帶檢查的
  for (const raw of changedFiles(input.tool_input)) {
    const file = path.resolve(cwd, raw);
    const kind = classify(file);
    if (!kind) continue;
    const dir = path.dirname(file);
    const bible = path.join(dir, 'bible.json');
    if (!looksLikeBible(bible)) continue;
    if (kind === 'bible') {
      targets.set(bible, [bible]);
      const eps = episodesIn(dir);
      notChecked += eps.skipped;
      for (const ep of eps.files) targets.set(ep, [bible, ep]);
    } else {
      targets.set(file, [bible, file]);
    }
  }
  if (!targets.size || !fs.existsSync(SCRIPT)) return;

  const blocks = [];
  let outOfTime = 0;
  for (const args of targets.values()) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left <= 0) { outOfTime++; continue; }
    blocks.push(runCheck(args, cwd, Math.min(60000, left)));
  }
  const text = summarize(blocks, { notChecked, outOfTime });
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  }));
}

function changedFiles(toolInput) {
  const out = new Set();
  const visit = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'file_path' || key === 'path' || key === 'filePath') out.add(v);
      for (const m of v.matchAll(/^\*\*\* (?:Update File|Add File|Move to): (.+)$/gm)) out.add(m[1].trim());
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) visit(x, k);
    }
  };
  visit(toolInput, '');
  return [...out];
}

function classify(file) {
  const base = path.basename(file);
  if (base === 'bible.json') return 'bible';
  if (base === 'series.json') return 'series';
  if (/^EP\d+.*-script\.md$/i.test(base)) return 'script';
  if (/^EP\d+[^\\/]*\.json$/i.test(base)) return 'episode';
  return null;
}

// 只認分鏡用的設定檔；改壞了、暫時不是合法 JSON 的也算，讓腳本把錯誤說出來
function looksLikeBible(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return false;
  }
  try {
    const j = JSON.parse(text.replace(/^﻿/, ''));
    return !!j && typeof j === 'object' && (('project' in j) || Array.isArray(j.characters));
  } catch {
    return text.includes('"project"') && text.includes('"characters"');
  }
}

/** 這個資料夾的分集檔：集數多時只取最近改過的 MAX_EPISODES 集（新寫的最需要檢查），再照集數排好。 */
function episodesIn(dir) {
  try {
    const all = fs.readdirSync(dir)
      .filter((n) => /^EP\d+[^\\/]*\.json$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let t = 0;
        try { t = fs.statSync(p).mtimeMs; } catch { /* 讀不到修改時間就排最後 */ }
        return { n, p, t };
      });
    const picked = all.sort((a, b) => b.t - a.t).slice(0, MAX_EPISODES)
      .sort((a, b) => a.n.localeCompare(b.n, 'en', { numeric: true }));
    return { files: picked.map((x) => x.p), skipped: all.length - picked.length };
  } catch {
    return { files: [], skipped: 0 };
  }
}

function runCheck(args, cwd, timeout = 60000) {
  const label = path.relative(cwd, args.length > 1 ? args[1] : args[0]) || path.basename(args[0]);
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-check-'));
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--out', tmp], {
      cwd, encoding: 'utf8', timeout, windowsHide: true,
    });
    if (r.error) return { label, failed: `檢查沒有跑完：${r.error.message}` };
    const lines = String(r.stdout || '').split(/\r?\n/);
    const head = lines.findIndex((l) => l.startsWith('檢查：'));
    if (head < 0) {
      // 腳本當掉時，stderr 前幾行是程式碼的位置；真正說明原因的是「TypeError: …」那一行
      const errLines = String(r.stderr || r.stdout || '').trim().split(/\r?\n/);
      const cause = errLines.find((l) => /^\s*\w*Error\b.*:/.test(l));
      const why = cause ? `${cause.trim()}（${errLines[0].trim()}）` : errLines.slice(0, 3).join(' ');
      return { label, failed: why || `腳本結束碼 ${r.status}` };
    }
    const issues = lines.slice(head + 1).map((l) => l.trim()).filter((l) => /^\[(錯誤|警告|提示)\]/.test(l));
    return { label, counts: lines[head].replace(/^檢查：/, ''), issues };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // 暫存資料夾刪不掉不影響檢查結果
      }
    }
  }
}

/**
 * 整理成一段回給模型的文字。沒有錯誤、警告，也沒有跑不完的檢查時回傳空字串（不輸出）。
 * 改了 bible.json 會連帶跑好幾集，設定檔本身的問題每一集都會出現一次：錯誤與警告只列一次，提示只算不重複的，
 * 同一個原因跑不完的（bible.json 寫壞了）合成一行。
 */
function summarize(blocks, { notChecked = 0, outOfTime = 0 } = {}) {
  const failures = new Map(); // 原因 → 哪幾個檔案
  for (const b of blocks.filter((x) => x.failed)) failures.set(b.failed, [...(failures.get(b.failed) || []), b.label]);
  const seen = new Set();
  const hints = new Set();
  const body = [];
  let shown = 0;
  let hidden = 0;
  for (const b of blocks.filter((x) => !x.failed)) {
    const lines = [];
    for (const line of b.issues) {
      if (line.startsWith('[提示]')) { hints.add(line); continue; }
      if (seen.has(line)) continue;
      seen.add(line);
      if (shown < MAX_LINES) { lines.push(`  ${line}`); shown++; } else hidden++;
    }
    if (lines.length || b.issues.some((l) => !l.startsWith('[提示]'))) body.push(`- ${b.label}：${b.counts}`, ...lines);
  }
  if (!failures.size && !seen.size && !outOfTime) return '';
  const out = ['[分鏡自動檢查] 剛改的檔案已經跑過 build_storyboard.mjs（只檢查，沒有更新 out/ 的產出）：'];
  for (const [why, labels] of failures) out.push(`- ${labels.join('、')}：${why}`);
  out.push(...body);
  if (hidden) out.push(`  ⋯還有 ${hidden} 則錯誤或警告沒有列出，執行腳本看全部。`);
  if (hints.size) out.push(`提示共 ${hints.size} 則沒有列出，執行腳本看全部。`);
  if (outOfTime) out.push(`還有 ${outOfTime} 個檔案沒在時間內檢查，執行腳本看全部。`);
  if (notChecked) out.push(`這個資料夾還有 ${notChecked} 集沒有連帶檢查（只檢查最近改過的 ${MAX_EPISODES} 集）。`);
  out.push('錯誤必須修；警告修掉，或有理由保留時在交付中說明。改完照技能的流程執行腳本，產出才會更新。');
  return out.join('\n');
}

try {
  main();
} catch {
  // hook 出錯不能擋住工具：安靜結束
}
process.exit(0);
