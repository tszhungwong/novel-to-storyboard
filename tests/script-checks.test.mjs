// 腳本的檢查與產出：審查清單第 6、10–19 項。
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
const EXAMPLES = path.join(ROOT, 'skills', 'novel-to-storyboard', 'examples');
const OUTLINE = path.join(ROOT, 'skills', 'outline-to-episodes', 'examples');
const HOOK = path.join(ROOT, 'hooks', 'check-storyboard.cjs');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 把範例複製到暫存資料夾，改完再跑。回傳腳本的輸出與產出的檔案。 */
function run(t, { example = '', editBible, editEp, second = 'EP01.json', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(EXAMPLES, example);
  const bible = readJson(path.join(src, 'bible.json'));
  const ep = readJson(path.join(src, 'EP01.json'));
  if (editBible) editBible(bible);
  if (editEp) editEp(ep);
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify(bible, null, 2));
  fs.writeFileSync(path.join(dir, second), typeof ep === 'string' ? ep : JSON.stringify(ep, null, 2));
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'bible.json'), path.join(dir, second)], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const file = (name) => fs.readFileSync(path.join(dir, 'out', name), 'utf8');
  return { code: r.status, out, checks: out.split('檢查：')[1] || '', file, dir };
}

test('#6：這一鏡覆寫了光線，場景的時間與天氣還在', (t) => {
  const r = run(t, { example: 'creature-fx' });
  const md = r.file('EP01-storyboard.md');
  // creature-fx 的第 005 鏡覆寫了 light；場景的 time 是「深夜，下著小雨」
  const sec = md.split('### EP01-005')[1].split('### EP01-006')[0];
  assert.match(sec, /吊燈的暖光[^\n]*深夜，下著小雨/);
});

test('#10：很短的鏡頭，字幕也不會疊在一起', (t) => {
  const r = run(t, {
    editEp: (e) => {
      e.shots[0].duration = 0.5;
      e.shots[0].line = { type: '旁白', who: '旁白', text: '那封信。' };
      e.shots[1].duration = 0.6;
      e.shots[1].line = { type: '旁白', who: '旁白', text: '放了三天。' };
    },
  });
  const toSec = (s) => { const [h, m, rest] = s.split(':'); const [sec, ms] = rest.split(','); return +h * 3600 + +m * 60 + +sec + +ms / 1000; };
  const cues = [...r.file('EP01.srt').matchAll(/(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})/g)].map((m) => [toSec(m[1]), toSec(m[2])]);
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k - 1][1] <= cues[k][0], `第 ${k} 句和下一句重疊：${cues[k - 1]} / ${cues[k]}`);
});

test('#11：audio_plan 寫成簡體照認，打錯的要警告', (t) => {
  const a = run(t, { editBible: (b) => { b.project.audio_plan = '原生音频'; } });
  assert.match(a.checks, /audio_plan「原生音频」當成「原生音訊」/);
  const b = run(t, { editBible: (bb) => { bb.project.audio_plan = '原聲'; } });
  assert.match(b.checks, /\[警告\] project\.audio_plan：audio_plan「原聲」不是/);
});

test('#11：video_mode 大寫照認、prompt_langs 寫成字串照讀，不出假警告', (t) => {
  const r = run(t, { editBible: (b) => { b.project.video_mode = 'T2V'; b.project.prompt_langs = 'zh'; } });
  assert.match(r.checks, /video_mode「T2V」當成「t2v」/);
  assert.match(r.checks, /prompt_langs 要寫成清單/);
  assert.doesNotMatch(r.checks, /但這一段只有中文/);
  assert.doesNotMatch(r.file('EP01-shots.csv'), /（英文）/);
});

test('#12：沒寫 cast 要警告；cast 是空的、動作卻寫到角色也要警告', (t) => {
  const a = run(t, { editEp: (e) => { delete e.shots[0].cast; } });
  assert.match(a.checks, /\[警告\] EP01-001：缺少 cast/);
  const b = run(t, {
    editEp: (e) => {
      e.shots[0].cast = [];
      e.shots[0].motion = '黑髮及肩的年輕女子眨了一下眼';
    },
  });
  assert.match(b.checks, /\[警告\] EP01-001：cast 是空的，但 action 或 motion 寫到了/);
});

test('#13：line 寫成字串要警告', (t) => {
  const r = run(t, { editEp: (e) => { e.shots[1].line = '林晚：你好'; } });
  assert.match(r.checks, /\[警告\] EP01-002：line 要寫成/);
});

test('#14：沒換掉的 {p01}、{P01:} 要警告', (t) => {
  const r = run(t, { editEp: (e) => { e.shots[0].cast[0].hands = '右手握著{p01}，左手拿著{P01:}'; } });
  assert.match(r.checks, /有沒換掉的 \{p01\}、\{P01:\}/);
});

test('#15：清單寫成物件、混了 null，不會當掉', (t) => {
  const r = run(t, {
    editBible: (b) => {
      b.scenes.push(null);
      b.characters = Object.fromEntries(b.characters.map((c) => [c.id, c]));
    },
    editEp: (e) => {
      e.shots[0].cast = e.shots[0].cast[0]; // 一個人寫成物件
      e.shots[1].cast.push(null);
      e.shots.push(null);
      e.plan.push(null);
      e.setups.push(null);
    },
  });
  assert.doesNotMatch(r.out, /TypeError|at file:/);
  assert.equal(r.code, 1);
  assert.match(r.checks, /characters 要寫成清單/);
  assert.match(r.checks, /cast 要寫成清單 \[ \{ … \} \]，目前是一個物件；這次當成只有一筆/);
  assert.ok(fs.existsSync(path.join(r.dir, 'out', 'EP01-storyboard.md')), '還是要產出分鏡表');
});

test('#15：腳本停下來時，hook 會把原因回報給模型（這裡用寫壞的 JSON）', (t) => {
  // 已知會讓腳本當掉的寫法都修掉了，造不出 TypeError；這裡只確認腳本中途停下時，原因有傳回對話
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify({ project: {}, characters: [] }));
  fs.writeFileSync(path.join(dir, 'EP01.json'), '{ "episode": "EP01", "shots": [ ');
  const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'EP01.json') } });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /EP01\.json：/);
  assert.match(ctx, /不是合法的 JSON|Unexpected|SyntaxError/);
});

test('#16：「男子宿舍」「洗臉台」不算寫到人；「宛如前世」不算指代', (t) => {
  const r = run(t, {
    editBible: (b) => { b.scenes[0].space = `男子宿舍的公用浴室，牆邊一排洗臉台，${b.scenes[0].space}`; },
    editEp: (e) => { e.shots[0].motion = `宛如前世的記憶，${e.shots[0].motion}`; },
  });
  assert.doesNotMatch(r.checks, /寫到了人/);
  assert.doesNotMatch(r.checks, /同上／如前/);
});

test('#16：真的寫了「同上」還是要警告', (t) => {
  const r = run(t, { editEp: (e) => { e.shots[2].motion = '動作同上'; } });
  assert.match(r.checks, /同上／如前/);
});

test('#17：不認得的欄位要警告，放錯層的說明要放到 cast；底線開頭的備註不管', (t) => {
  const r = run(t, {
    editEp: (e) => {
      e.shots[0].hands = '雙手交疊';
      e.shots[1].motoin = '打錯字';
      e.shots[2]._note = '給自己看的';
      e.plan[0].peek = '1';
    },
  });
  assert.match(r.checks, /EP01-001：不認得「hands」這個欄位；hands 是 cast 裡每個人的欄位/);
  assert.match(r.checks, /EP01-002：不認得「motoin」這個欄位（是不是「motion」？）/);
  assert.match(r.checks, /plan 第 1 場：不認得「peek」這個欄位（是不是「peak」？）/);
  assert.doesNotMatch(r.checks, /不認得「_note」/);
});

test('#18：卡點的問句要在最後；119.6 秒印成 2 分 0 秒', (t) => {
  const series = readJson(path.join(OUTLINE, 'series.json'));
  series.episodes = series.episodes.slice(0, 2);
  series.episodes[0].est_seconds = 59.8;
  series.episodes[1].est_seconds = 59.8;
  series.episodes[0].cliff = '她問：你是誰？門關上了。';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-series-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(OUTLINE, 'bible.json'), path.join(dir, 'bible.json'));
  fs.writeFileSync(path.join(dir, 'series.json'), JSON.stringify(series));
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'bible.json'), path.join(dir, 'series.json')], { encoding: 'utf8' });
  assert.match(r.stdout, new RegExp(`${series.episodes[0].episode}：cliff 只寫了最後發生什麼`));
  assert.match(r.stdout, /預估約 2 分 0 秒/);
  assert.doesNotMatch(r.stdout, /60 秒/);
});

test('#19：分集劇本的台詞遠少於單集長度時要提示', (t) => {
  const r = spawnSync(process.execPath, [SCRIPT, path.join(OUTLINE, 'bible.json'), path.join(OUTLINE, 'EP01-script.md')], { encoding: 'utf8' });
  assert.match(r.stdout, /\[提示\] 劇本：台詞與旁白約 \d+ 秒，單集至少 60 秒/);
});

test('範例都還是乾淨的（0 錯誤、0 警告）', () => {
  const cases = [
    [path.join(EXAMPLES, 'bible.json'), path.join(EXAMPLES, 'EP01.json')],
    ...['creature-fx', 'en-action', 'live-action'].map((x) => [path.join(EXAMPLES, x, 'bible.json'), path.join(EXAMPLES, x, 'EP01.json')]),
    [path.join(OUTLINE, 'bible.json'), path.join(OUTLINE, 'series.json')],
  ];
  for (const [b, e] of cases) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-example-'));
    const r = spawnSync(process.execPath, [SCRIPT, b, e, '--out', out], { encoding: 'utf8' });
    fs.rmSync(out, { recursive: true, force: true });
    assert.match(r.stdout, /檢查：錯誤 0、警告 0、/, `${e}\n${r.stdout.split('檢查：')[1]}`);
  }
});
