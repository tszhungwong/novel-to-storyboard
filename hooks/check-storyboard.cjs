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
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'novel-to-storyboard', 'scripts', 'build_storyboard.mjs');
const MAX_LINES = 40; // 回給模型的錯誤與警告最多幾行
const MAX_EPISODES = 20; // 改了 bible.json 時，最多連帶檢查幾集

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const targets = new Map(); // 要跑的參數組合，key 去重
  for (const raw of changedFiles(input.tool_input)) {
    const file = path.resolve(cwd, raw);
    const kind = classify(file);
    if (!kind) continue;
    const dir = path.dirname(file);
    const bible = path.join(dir, 'bible.json');
    if (!looksLikeBible(bible)) continue;
    if (kind === 'bible') {
      targets.set(bible, [bible]);
      for (const ep of episodesIn(dir)) targets.set(ep, [bible, ep]);
    } else {
      targets.set(file, [bible, file]);
    }
  }
  if (!targets.size || !fs.existsSync(SCRIPT)) return;

  const blocks = [];
  for (const args of targets.values()) blocks.push(runCheck(args, cwd));
  const text = summarize(blocks);
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

function episodesIn(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^EP\d+[^\\/]*\.json$/i.test(n))
      .sort()
      .slice(0, MAX_EPISODES)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function runCheck(args, cwd) {
  const label = path.relative(cwd, args.length > 1 ? args[1] : args[0]) || path.basename(args[0]);
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-check-'));
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--out', tmp], {
      cwd, encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    if (r.error) return { label, failed: `檢查沒有跑完：${r.error.message}` };
    const lines = String(r.stdout || '').split(/\r?\n/);
    const head = lines.findIndex((l) => l.startsWith('檢查：'));
    if (head < 0) {
      const why = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
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

function summarize(blocks) {
  const out = ['[分鏡自動檢查] 剛改的檔案已經跑過 build_storyboard.mjs（只檢查，沒有更新 out/ 的產出）：'];
  const seen = new Set();
  let shown = 0;
  let hidden = 0;
  let hints = 0;
  for (const b of blocks) {
    if (b.failed) {
      out.push(`- ${b.label}：${b.failed}`);
      continue;
    }
    out.push(`- ${b.label}：${b.counts}`);
    for (const line of b.issues) {
      if (line.startsWith('[提示]')) {
        hints++;
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      if (shown < MAX_LINES) {
        out.push(`  ${line}`);
        shown++;
      } else {
        hidden++;
      }
    }
  }
  if (hidden) out.push(`  ⋯還有 ${hidden} 則錯誤或警告沒有列出，執行腳本看全部。`);
  if (hints) out.push(`提示共 ${hints} 則沒有列出，執行腳本看全部。`);
  out.push('錯誤必須修；警告修掉，或有理由保留時在交付中說明。改完照技能的流程執行腳本，產出才會更新。');
  return out.join('\n');
}

try {
  main();
} catch {
  // hook 出錯不能擋住工具：安靜結束
}
process.exit(0);
