// plugin 的設定檔：三份 manifest 都讀得懂、版號一致；技能與代理的 name 和檔名對得上。
// 執行：node --test（需要 Node 18 以上）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const frontmatter = (p) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(p, 'utf8'));
  assert.ok(m, `${p} 沒有 frontmatter`);
  return Object.fromEntries(m[1].split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]]));
};

test('三份 manifest 的版號一致', () => {
  const claude = readJson('.claude-plugin/plugin.json');
  const codex = readJson('.codex-plugin/plugin.json');
  const market = readJson('.agents/plugins/marketplace.json').plugins.find((p) => p.name === claude.name);
  readJson('.claude-plugin/marketplace.json');
  assert.match(claude.version, /^\d+\.\d+\.\d+$/);
  assert.equal(codex.version, claude.version, '.codex-plugin/plugin.json 的版號');
  assert.equal(market?.version, claude.version, '.agents/plugins/marketplace.json 的版號');
});

test('每個技能的 name 和資料夾同名，description 不超過 1024 字', () => {
  const dir = path.join(ROOT, 'skills');
  const skills = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(skills.length >= 3);
  for (const s of skills) {
    const fm = frontmatter(path.join(dir, s, 'SKILL.md'));
    assert.equal(fm.name, s);
    assert.ok(fm.description && [...fm.description].length <= 1024, `${s} 的 description 有 ${[...(fm.description || '')].length} 字`);
  }
});

test('每個審查代理的 name 和檔名同名，而且只能讀檔', () => {
  const dir = path.join(ROOT, 'agents');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const fm = frontmatter(path.join(dir, f));
    assert.equal(fm.name, f.replace(/\.md$/, ''));
    assert.doesNotMatch(fm.tools || '', /Write|Edit|Bash/, `${f} 不該能改檔`);
  }
});
