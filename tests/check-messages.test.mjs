// 腳本的每一個檢查（錯誤、警告、提示）都要有測試觸發過一次。
// 每一筆：拿一個範例，改掉某些欄位，跑腳本，看預期的那幾句有沒有出現。
// 哪些檢查還沒有測試，用 `node tests/coverage-gate.mjs` 看。
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
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * 跑一次腳本。
 * - 分鏡：example 是範例資料夾（'' 是主範例），bible、ep 是改設定檔與分鏡檔的函式
 * - 分集表：series 是改 series.json 的函式（用 outline-to-episodes 的範例）
 * - 分集劇本：script 是劇本的文字（用 outline-to-episodes 的設定檔）
 * - extra：另外放在設定檔旁邊的檔案
 */
function run(t, { example = '', bible, ep, series, script, extra = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-msg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fromOutline = series !== undefined || script !== undefined;
  const b = readJson(path.join(fromOutline ? OUTLINE : path.join(EXAMPLES, example), 'bible.json'));
  if (bible) bible(b);
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify(b));
  let second;
  if (script !== undefined) {
    second = path.join(dir, 'EP01-script.md');
    fs.writeFileSync(second, script);
  } else if (series !== undefined) {
    const s = readJson(path.join(OUTLINE, 'series.json'));
    if (series) series(s);
    second = path.join(dir, 'series.json');
    fs.writeFileSync(second, JSON.stringify(s));
  } else {
    const e = readJson(path.join(EXAMPLES, example, 'EP01.json'));
    if (ep) ep(e);
    second = path.join(dir, 'EP01.json');
    fs.writeFileSync(second, JSON.stringify(e));
  }
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'bible.json'), second, '--out', path.join(dir, 'out')], { encoding: 'utf8' });
  const checks = r.stdout.split('\n檢查：')[1] || '';
  const file = (name) => fs.readFileSync(path.join(dir, 'out', name), 'utf8');
  return { checks, out: r.stdout + r.stderr, file };
}
const shot = (e, n) => e.shots.find((s) => s.id.endsWith(`-${n}`));
const clone = (x) => JSON.parse(JSON.stringify(x));

const CASES = [
  // ---------- project 參數 ----------
  {
    name: 'project：寫錯的參數值都會說出來',
    bible: (b) => {
      Object.assign(b.project, { video_mode: 'x2v', prompt_langs: ['zh-TW', 'fr'], episode_length: [60], ref_mode: '圖片', ref_max: 0, format: '電影', medium: '油畫', tool_limits: { foo: false, text: 'no' } });
      delete b.project.clip_range;
    },
    expect: [
      /\[警告\] project\.video_mode：video_mode「x2v」請填 i2v/,
      /prompt_langs 的「zh-TW」當成「zh」/,
      /prompt_langs 只認得 zh 與 en，「fr」這次略過/,
      /episode_length：要寫成 \[最短, 最長\] 的秒數/,
      /ref_mode 請填「混合」「參考圖」或「文字」；目前的「圖片」/,
      /ref_max 要是大於 0 的整數/,
      /format 請填 .*目前的「電影」/,
      /medium 請填 .*目前的「油畫」/,
      /tool_limits 不認得「foo」/,
      /tool_limits\.text 要填 true（做得到）或 false（做不好）/,
      /影片工具定了，還沒填單次可生成的秒數/,
    ],
  },
  { name: 'project：tool_limits 寫成清單', bible: (b) => { b.project.tool_limits = ['text']; }, expect: [/tool_limits 要寫成物件/] },
  { name: 'project：工具定了卻沒有 tool_limits', bible: (b) => { delete b.project.tool_limits; }, expect: [/工具定了，還沒填 tool_limits/] },
  { name: 'project：工具還沒定卻填了 tool_limits', example: 'live-action', bible: (b) => { b.project.tool_limits = { text: false }; }, expect: [/還沒填 image_tool 或 video_tool，卻填了 tool_limits/] },
  { name: '設定檔：清單寫成讀不懂的值', bible: (b) => { b.props = 'abc'; }, expect: [/\[錯誤\] 設定檔：props 要寫成清單 \[ \{ … \} \]；目前的寫法讀不懂/] },
  { name: '設定檔旁邊的 series.json 不是合法的 JSON', extra: { 'series.json': '{ "episodes": [' }, expect: [/series\.json 不是合法的 JSON/] },
  {
    name: 'project：suffix 的畫幅與 Midjourney',
    bible: (b) => { Object.assign(b.project, { image_tool: 'Midjourney V8', asset_suffix: '--ar 16:9' }); },
    expect: [/asset_suffix 把畫幅寫死了/, /Midjourney 的畫幅與參數寫在提示詞最後/],
  },
  { name: 'project：image_suffix 的畫幅和影片不一樣', bible: (b) => { b.project.image_suffix = '--ar 16:9'; }, expect: [/\[警告\] project\.image_suffix：image_suffix 的 --ar 16:9 和畫幅 9:16 不一樣/] },
  { name: 'project：沒有原生聲音卻填了 audio_suffix', bible: (b) => { b.project.audio_suffix = '不要字幕'; }, expect: [/audio_suffix 只在聲音方案是「原生音訊」或「原生音效」時用得到/] },
  {
    name: 'project：工具沒有負面詞欄位，卻填了負面詞',
    example: 'en-action',
    bible: (b) => { Object.assign(b.project, { negative_global: 'blur', negative_video: 'flicker' }); },
    ep: (e) => { shot(e, '002').negative = 'blur'; },
    expect: [/project\.negative_global：選定的工具沒有負面詞欄位/, /project\.negative_video：選定的工具沒有負面詞欄位/, /EP01-002\.negative：選定的工具沒有負面詞欄位，這一鏡的負面詞用不到/],
  },
  {
    name: 'project：提示詞超過工具的長度上限',
    bible: (b) => { b.project.prompt_limits = { image: { zh: 50 }, video: { zh: 30 } }; },
    expect: [/首幀圖像提示詞（zh）有 \d+ 字，超過工具上限 50/, /影片提示詞（zh）有 \d+ 字，超過工具上限 30/],
  },

  // ---------- 風格鎖定句 ----------
  { name: '風格鎖定句：沒寫', bible: (b) => { delete b.project.style_lock; }, expect: [/\[錯誤\] project\.style_lock：缺少風格鎖定句/] },
  {
    name: '風格鎖定句：寫了冷暖、頭身比、皮膚',
    bible: (b) => { b.project.style_lock = '暖色調的水彩畫風，約七頭身，皮膚細膩'; },
    expect: [/風格鎖定句寫了冷暖或主色/, /風格鎖定句寫了頭身比/, /風格鎖定句寫到了「膚」/],
  },

  // ---------- 道具與特效的定義 ----------
  {
    name: '道具：缺少編號、編號重複、描述太長',
    bible: (b) => {
      b.props.push({ desc: '一張紙條' }, { id: 'P01', desc: '另一個信封' }, { id: 'P02', desc: '一個封口翻起而且邊角有點皺的白色長方形牛皮紙信封' });
    },
    expect: [/\[錯誤\] props：有道具缺少 id/, /\[錯誤\] P01：道具編號重複/, /道具描述（zh）有 \d+ 字，超過 15/],
  },
  { name: '道具：英文描述用了 with 片語', example: 'en-action', bible: (b) => { b.props[0].desc = 'a tin with a dent'; }, expect: [/道具描述（en）用了 with 片語/] },
  {
    name: '特效：缺少編號、不是 F 開頭、編號重複',
    example: 'creature-fx',
    bible: (b) => { b.effects.push({ desc: '一團光' }, { id: 'X1', desc: '一團光' }, { id: 'F01', desc: '重複的狐火' }); },
    expect: [/\[錯誤\] effects：有特效缺少 id/, /\[警告\] X1：特效編號請用 F 開頭/, /\[錯誤\] F01：特效編號重複/],
  },
  {
    name: '特效：分狀態的寫法、make、快速動態、文字',
    example: 'creature-fx',
    bible: (b) => {
      b.project.tool_limits = { fast_motion: false, text: false };
      const f2 = b.effects.find((f) => f.id === 'F02');
      f2.light_states = '亮';
      f2.motion_states = { 凋謝: '花瓣掉落' };
      b.effects.push({ id: 'F09', name: '數字光球', desc: '一串發光的數字', states: { 小: '小小一串發光的數字', 大: '一大串發光的數字' }, light: '照亮周圍', motion: '光球瞬間炸開', make: '手繪' });
    },
    expect: [
      /\[錯誤\] F02：light_states 要寫成 \{"狀態名稱": "描述"\}/,
      /\[錯誤\] F02：motion_states 的「凋謝」不在 states 裡/,
      /F09：有 2 個狀態（小、大），light 卻只有一段/,
      /F09：make 請填/,
      /F09\.motion：特效的動態用了「爆發／炸開／瞬間」這類字眼/,
      /F09：這個特效看起來包含數字或文字/,
    ],
  },

  // ---------- 角色 ----------
  {
    name: '角色：缺少編號、編號重複、形態缺少編號或重複',
    bible: (b) => {
      b.characters.push({ name: '路人', look: '一個路人', outfit: '灰外套' }, { id: 'C01', name: '重複', tag: '重複的人', look: '一個人', outfit: '灰外套' });
      b.characters[1].variants.push({ outfit: '睡衣' }, { id: 'C01-a', outfit: '睡衣' });
    },
    expect: [/\[錯誤\] characters：有角色缺少 id/, /\[錯誤\] C01：角色編號重複/, /\[錯誤\] C02：有造型變體缺少 id/, /\[錯誤\] C01-a：造型變體編號重複/],
  },
  {
    name: '角色：分類、形態的短稱、短稱、群體、非人的表情、身高、短稱重複',
    bible: (b) => {
      const [c1, c2] = b.characters;
      c1.kind = '精靈';
      c1.group = 1;
      c1.stature = '身高約一百六十公分，比一隻黑貓高很多';
      c1.variants[0].look = '二十歲出頭的女性，短髮';
      b.characters.push(
        { id: 'C09', name: '手下', tag: '兩個黑衣人', look: '兩個穿黑衣的男人', outfit: '黑西裝' },
        { id: 'C08', name: '貓', kind: '動物', tag: '一隻黑貓', look: '一隻黑貓' },
        { id: 'C07', name: '另一人', tag: c1.tag, look: '一個女人', outfit: '白襯衫' },
      );
      delete c2.tag;
    },
    expect: [
      /C01：kind「精靈」不在分類裡/,
      /C01：group 是這一群的人數/,
      /C01\.stature：身高提到了/,
      /C01-a：這個形態有自己的 look，卻沒有自己的 tag/,
      /C02\.tag：缺少短稱（tag）/,
      /C09：短稱「兩個黑衣人」是一群人，卻沒有填 group/,
      /C08：動物角色沒有寫 expressions/,
      /短稱（zh）都是「/,
    ],
  },

  // ---------- 場景 ----------
  {
    name: '場景：缺少編號、編號重複',
    bible: (b) => { b.scenes.push({ name: '走廊', space: '走廊', light: '日光燈' }, { id: 'S01', space: '另一個客廳', light: '日光燈' }); },
    expect: [/\[錯誤\] scenes：有場景缺少 id/, /\[錯誤\] S01：場景編號重複/],
  },
  {
    name: '場景：寫到人、用身體說位置、畫面左右、暖光配冷色 palette、必填的光線',
    bible: (b) => {
      const s = b.scenes[0];
      s.space += '，一個男人坐在沙發上，窗在畫面左邊';
      s.detail = '牆上掛著一個女人的照片';
      s.palette = '以冷藍色為主';
      b.scenes.push({ id: 'S02', name: '樓梯間', space: '昏暗的樓梯間', light: '', time: '晚上' });
    },
    expect: [/S01\.space：場景的 space 寫到了人/, /S01\.detail：場景的 detail 寫到了人/, /S01\.palette：場景的光是暖光，palette 卻以冷色為主/, /S01\.space：場景描述用了「畫面左／右」/, /\[錯誤\] S02\.light：必填，但目前是空的/],
  },
  { name: '場景：用「頭頂」說位置', bible: (b) => { b.scenes[0].light += '，吊燈垂到頭頂的高度'; }, expect: [/S01：場景描述用「頭頂」說位置/] },
  { name: '提示詞語言是中英，片段卻只寫了中文', example: 'live-action', bible: (b) => { b.scenes[0].time = { zh: '晚上' }; }, expect: [/S01\.time：提示詞語言包含 en，但這一段沒有 en 的寫法/] },
  { name: '這一集用到的東西沒寫 detail', bible: (b) => { delete b.scenes[0].detail; }, expect: [/detail：這一集用到的 .*S01.* 沒有寫 detail/] },

  // ---------- 機位 ----------
  {
    name: '機位：缺少編號、重複、場景不存在、缺 desc、寫到人、用身體說位置、沒有鏡頭用到',
    ep: (e) => {
      e.setups.push(
        { scene: 'S01', desc: '沒有編號', bg: '一面牆' },
        { id: 'S01-A', scene: 'S01', desc: '重複', bg: '一面牆' },
        { id: 'S09-A', scene: 'S09', desc: '不存在的場景', bg: '一面牆' },
        { id: 'S01-D', scene: 'S01', bg: '一面牆' },
      );
      e.setups.find((u) => u.id === 'S01-A').bg += '，一個男人站在窗邊';
      e.setups.find((u) => u.id === 'S01-B').detail = '門框上方離頭頂不遠';
    },
    expect: [/\[錯誤\] setups：有機位缺少 id/, /\[錯誤\] S01-A：機位編號重複/, /\[錯誤\] S09-A：機位的場景編號 S09 不在設定檔裡/, /\[警告\] S01-D：機位缺少 desc/, /S01-A\.bg：機位的 bg 寫到了人/, /S01-B\.detail：機位的 detail 用「頭頂」說位置/, /S01-D：沒有任何鏡頭用到這個機位/],
  },

  // ---------- 片段 ----------
  {
    name: '片段：不存在的道具編號、後製特效寫進提示詞、要求畫面寫字',
    example: 'creature-fx',
    bible: (b) => { b.project.tool_limits = { text: false }; },
    ep: (e) => {
      shot(e, '005').props = '{P99}';
      shot(e, '005').motion += '，{F03}浮現';
      shot(e, '002').bg = '櫃台後面的牆上，木牌寫著店名';
    },
    expect: [/\[錯誤\] EP01-005\.props：用了設定檔裡沒有的道具或特效編號/, /EP01-005\.motion：F03（.*）是後製做的特效，不要寫進提示詞/, /EP01-002\.bg：看起來要求畫面出現可讀文字/],
  },

  // ---------- 用詞 ----------
  { name: '用詞表以外的寫法：英文提示詞夾著中文', example: 'en-action', ep: (e) => { shot(e, '004').angle = '斜角'; }, expect: [/\[警告\] EP01-004：角度「斜角」不在用詞表裡，英文提示詞會夾著中文/] },
  { name: '用詞表以外的寫法：中文提示詞照原樣放', ep: (e) => { shot(e, '004').angle = '斜角'; }, expect: [/\[提示\] EP01-004：角度「斜角」不在用詞表裡/] },

  // ---------- 分鏡檔與場次 ----------
  { name: '分鏡檔沒有鏡頭', ep: (e) => { e.shots = []; }, expect: [/\[錯誤\] shots：分鏡檔裡沒有任何鏡頭/] },
  { name: '沒有 plan：提示寫場次設計，beat 指到不存在的場次', ep: (e) => { delete e.plan; }, expect: [/plan：分鏡檔沒有 plan/, /\[錯誤\] EP01-001：beat「1\.1」的場次 1 不在 plan 裡/] },
  { name: 'plan：場次編號重複', ep: (e) => { e.plan.push(clone(e.plan[0])); }, expect: [/\[錯誤\] plan 第 1 場：場次編號重複/] },
  {
    name: 'plan：場景不存在、缺目的與節拍、走位用畫面左右、沒有鏡頭指向這一場',
    ep: (e) => {
      e.plan.push({ id: '2', scene: 'S09', purpose: '不存在的場景', beats: ['走進來'], peak: 1 }, { id: '3', scene: 'S01' });
      e.plan[0].blocking = '林晚坐在畫面左側的桌前';
    },
    expect: [/\[錯誤\] plan 第 2 場：場景編號 S09 不在設定檔裡/, /plan 第 3 場：沒有寫 purpose（目的）、beats（節拍）、peak（高點）/, /plan 第 1 場：blocking 寫的是人在空間裡的位置與路線/, /\[警告\] plan 第 2 場：沒有任何鏡頭的 beat 指向這一場/],
  },
  {
    name: '鏡頭：缺鏡號、鏡號重複、缺 action、duration、source，beat 寫錯或寫成數字',
    ep: (e) => {
      const c = clone(shot(e, '003'));
      delete c.id;
      e.shots.push(c, clone(shot(e, '003')));
      const s7 = shot(e, '007');
      delete s7.action;
      delete s7.source;
      s7.duration = 0;
      shot(e, '004').beat = 'x';
      shot(e, '002').beat = 1.1;
    },
    expect: [/\[錯誤\] 第 9 鏡：缺少鏡號 id/, /\[錯誤\] EP01-003：鏡號重複/, /\[錯誤\] EP01-007：缺少 action/, /\[錯誤\] EP01-007：duration 要是大於 0 的秒數/, /\[警告\] EP01-007：缺少 source/, /\[錯誤\] EP01-004：beat 要寫成「場次\.節拍」/, /EP01-002：beat 請寫成字串/],
  },
  {
    name: '鏡頭：場景不存在、機位不存在、機位屬於別的場景、beat 指到別的場景、接續換了場景',
    bible: (b) => { b.scenes.push({ id: 'S02', name: '樓梯間', space: '昏暗的樓梯間', light: '樓梯間的日光燈' }); },
    ep: (e) => {
      e.plan.push({ id: '2', scene: 'S02', purpose: '在樓梯間', beats: ['他下樓'], peak: 1 });
      Object.assign(shot(e, '007'), { scene: 'S02' });
      Object.assign(shot(e, '008'), { link: '接續' });
      shot(e, '006').scene = 'S09';
      shot(e, '003').setup = 'S01-Z';
      shot(e, '004').beat = '2.1';
    },
    expect: [/\[錯誤\] EP01-006：場景編號 S09 不在設定檔裡/, /\[錯誤\] EP01-003：機位編號 S01-Z 不在這一集的 setups 裡/, /\[錯誤\] EP01-007：機位 S01-B 屬於場景 S01，但這一鏡的場景是 S02/, /\[警告\] EP01-004：beat 指向第 2 場（場景 S02），但這一鏡的場景是 S01/, /\[警告\] EP01-008：「接續」表示沿用上一鏡的最後一幀，但場景和上一鏡不同/],
  },
  { name: '參考圖超過工具一次能掛的張數', bible: (b) => { b.project.ref_max = 1; }, expect: [/這一鏡要掛 \d+ 張參考圖，超過工具上限 1 張/] },
  {
    name: 'cut：寫錯型別、標在最後一鏡；有切點時分鏡表列出建議切點',
    ep: (e) => { shot(e, '003').cut = 5; shot(e, '008').cut = '結尾'; shot(e, '004').cut = '懸念：門開了'; },
    expect: [/\[警告\] EP01-003：cut 要寫成一句理由/, /EP01-008：最後一鏡本來就是結尾，不用標 cut/],
    files: { 'EP01-storyboard.md': [/## 建議切點/, /EP01-004 之後 \| [\d:.]+ \| 懸念：門開了/] },
  },
  { name: '場景的頭三鏡沒有建立鏡頭', ep: (e) => { shot(e, '002').size = '中景'; }, expect: [/EP01-001：場景 S01 出現後的頭三鏡沒有遠景或全景/] },

  // ---------- 鏡頭的拍法 ----------
  {
    name: '運鏡沒有方向、貼地卻俯拍、速度不在用詞表、render 寫錯',
    ep: (e) => {
      shot(e, '004').camera = '搖';
      Object.assign(shot(e, '007'), { height: '地面', angle: '俯拍' });
      shot(e, '003').speed = '超慢';
      shot(e, '005').render = '動畫';
    },
    expect: [/\[警告\] EP01-004：運鏡「搖」沒有方向/, /\[警告\] EP01-007：機位貼近地面卻是俯拍/, /\[警告\] EP01-003：speed「超慢」不在用詞表裡/, /\[警告\] EP01-005：render 請填/],
  },
  {
    name: '靜幀：做不出的運鏡、不動的鏡頭、做不出的速度、說話的鏡頭',
    ep: (e) => {
      shot(e, '001').camera = '右環繞';
      Object.assign(shot(e, '003'), { render: '靜幀', camera: '左搖', speed: '升格' });
      Object.assign(shot(e, '007'), { render: '靜幀', speed: '定格' });
      shot(e, '006').render = '靜幀';
    },
    expect: [/\[警告\] EP01-001：靜幀運鏡是在一張圖上推拉或搖移，做不出「右環繞」/, /EP01-003：靜幀的畫面不動，運鏡「左搖」不會用到/, /\[警告\] EP01-003：靜幀不跑影片，做不出 speed「升格」/, /EP01-007：靜幀本來就不動，不用再標定格/, /EP01-006：靜幀不跑影片，說話的人嘴不會動/],
  },
  { name: '靜幀運鏡卻是固定', ep: (e) => { shot(e, '001').camera = '固定'; }, expect: [/EP01-001：靜幀運鏡卻是固定/] },
  {
    name: '工具做不穩的運鏡沒寫備案',
    bible: (b) => { b.project.tool_limits = { complex_camera: false }; },
    ep: (e) => { Object.assign(shot(e, '007'), { camera: '右環繞' }); delete shot(e, '007').risk; },
    expect: [/EP01-007：環繞要整個背景跟著轉/],
  },
  { name: '原生音訊：慢動作的鏡頭配台詞', example: 'en-action', ep: (e) => { shot(e, '005').speed = '升格'; }, expect: [/EP01-005：慢動作的鏡頭配不上正常速度的台詞/] },
  { name: '近景沒有 bg', ep: (e) => { delete shot(e, '003').bg; }, expect: [/\[警告\] EP01-003：近景沒有寫 bg，也沒有機位的 bg/] },
  {
    name: '走位：同一個角色兩次、角色不存在、缺手部、背對沒設 partial、全景沒寫表情、情緒詞、朝向與視線相反',
    ep: (e) => {
      const s4 = shot(e, '004');
      s4.cast.push(clone(s4.cast[0]), { char: 'C99', pos: '門邊', gaze: '看著屋內', hands: '垂著' });
      s4.cast[0].gaze = '看向畫面右側的窗';
      delete shot(e, '007').cast[0].hands;
      delete shot(e, '002').cast[0].face;
      shot(e, '003').cast[0].face = '難過';
      Object.assign(shot(e, '007').cast[0], { facing: '背面' });
    },
    expect: [/EP01-004：C02 在這一鏡出現兩次/, /\[錯誤\] EP01-004：角色編號 C99 不在設定檔裡/, /\[警告\] EP01-007：C02-a 沒寫 hands/, /EP01-007：C02-a 背對鏡頭，卻沒有設 partial/, /EP01-002：C01-a 沒寫 face；全景裡臉比較小/, /EP01-003：C01-a 的 face 只寫了情緒「難過」/, /EP01-004：C02-a 的 facing 是「半側朝左」，視線卻看向畫面右側/],
  },
  { name: '片段寫到「後製」', ep: (e) => { shot(e, '003').bg = '牆上留一片給後製的空白'; }, expect: [/\[警告\] EP01-003\.bg：片段寫到了「後製」/] },
  {
    name: '這一鏡的特效：不是清單、不存在、狀態不存在、沒寫狀態、沒寫位置、快速的動態',
    example: 'creature-fx',
    bible: (b) => { b.project.tool_limits = { fast_motion: false }; },
    ep: (e) => {
      shot(e, '001').fx = { id: 'F01' };
      const s6 = shot(e, '006');
      s6.fx.push({ id: 'F99', pos: '桌上' });
      delete s6.fx[0].pos;
      s6.fx[0].motion = '火焰瞬間爆開';
      shot(e, '008').fx.find((x) => x.id === 'F02').state = '凋謝';
      (shot(e, '009').fx ||= []).push({ id: 'F02', pos: '攤開的掌心' });
    },
    expect: [/\[錯誤\] EP01-001：fx 要寫成陣列/, /\[錯誤\] EP01-006：特效編號 F99 不在設定檔的 effects 裡/, /\[錯誤\] EP01-008：特效 F02 沒有「凋謝」這個狀態/, /EP01-009：特效 F02（.*）有分狀態/, /\[警告\] EP01-006：特效 F01 沒寫 pos/, /\[警告\] EP01-006：特效 F01 的 motion 用了「爆發／瞬間」這類字眼/],
  },
  {
    name: '暖光的鏡頭配上以冷色為主的 palette',
    bible: (b) => { b.scenes[0].palette = '以冷藍色為主'; },
    ep: (e) => { shot(e, '003').light = '暖黃的檯燈光照在臉上'; },
    expect: [/EP01-003：這一鏡的光是暖光，場景的 palette 卻以冷色為主/],
  },
  {
    name: '冷光的場景，這一鏡換成暖光，palette 裡沒有暖色',
    bible: (b) => { Object.assign(b.scenes[0], { light: '冷白的月光從窗戶照進來，室內偏暗', palette: '暗部偏灰藍' }); },
    ep: (e) => { shot(e, '003').light = '暖橘色的檯燈光照亮桌面'; },
    expect: [/EP01-003：這一鏡把光換成暖光（場景本身的光不暖）/],
  },
  {
    name: '連戲備註寫道具收走、sound 寫配樂、缺 end、last_frame 寫錯、快速動作',
    bible: (b) => { b.project.tool_limits = { fast_motion: false }; },
    ep: (e) => {
      shot(e, '007').continuity = 'P01 收走了';
      shot(e, '002').sound = '背景音樂慢慢進來';
      delete shot(e, '004').end;
      shot(e, '007').last_frame = 'no';
      shot(e, '004').motion = shot(e, '004').motion.replace('把門再推開一些', '猛地把門推開');
    },
    expect: [/EP01-007：continuity 寫到 P01（信）被收走或拿出來/, /EP01-002：sound 寫到了配樂/, /\[警告\] EP01-004：缺少 end/, /\[警告\] EP01-007：last_frame 只能填 false/, /\[警告\] EP01-004：motion 用了「快速／劇烈／瞬間」這類字眼/],
  },
  {
    name: '銜接：link 寫錯、第一鏡接續、接續換了角色與機位又寫轉場',
    ep: (e) => {
      shot(e, '003').link = 'x';
      shot(e, '001').link = '接續';
      Object.assign(shot(e, '005'), { link: '接續', transition: '疊化' });
    },
    expect: [/\[錯誤\] EP01-003：link 只能是「切」或「接續」/, /\[錯誤\] EP01-001：第一鏡不能是「接續」/, /\[警告\] EP01-005：「接續」表示沿用上一鏡的最後一幀，但畫面中的角色和上一鏡不同/, /\[警告\] EP01-005：「接續」表示沿用上一鏡的最後一幀，但機位和上一鏡不同/, /\[警告\] EP01-005：「接續」是同一個鏡頭延續下去/],
  },
  {
    name: '台詞：沒有 text、類型寫錯、說話的人沒入鏡、超過工具秒數',
    ep: (e) => {
      shot(e, '007').line = { type: '對白', who: 'C02' };
      shot(e, '006').line.type = '說話';
      shot(e, '005').line.type = '對白';
      shot(e, '003').duration = 40;
    },
    expect: [/\[警告\] EP01-007：line 沒有 text/, /EP01-006：line\.type 請用/, /EP01-005：這句是「對白」，但說話的 C02 沒有正面入鏡/, /\[警告\] EP01-003：成片 40 秒加上裁頭尾 1 秒，超過工具單次可生成的 30 秒/],
  },
  {
    name: '轉場不在用詞表裡；用詞後面補說明照收',
    ep: (e) => { shot(e, '005').transition = '慢慢轉過去'; shot(e, '007').transition = '疊化，兩秒'; },
    expect: [/EP01-005：transition「慢慢轉過去」不在用詞表裡/],
    absent: [/EP01-007：transition/],
  },
  { name: '沒有嘴的角色說「對白」', example: 'creature-fx', ep: (e) => { shot(e, '003').line.type = '對白'; }, expect: [/EP01-003：C03 .*沒有嘴（mouthless），不會對口型/] },

  // ---------- 跨鏡頭、整場、整集 ----------
  { name: '同一個機位裡左右對調', ep: (e) => { shot(e, '007').cast[0].facing = '半側朝右'; }, expect: [/EP01-007：C02 在機位 S01-B 的 EP01-004 臉朝畫面左，這一鏡朝右/] },
  { name: '同框看得到身體，卻沒寫身高', example: 'live-action', bible: (b) => { delete b.characters[1].stature; }, expect: [/EP01-002：C01、C02 同框而且看得到身體，C02 沒有寫 stature/] },
  {
    name: '聲線：有台詞沒寫 voice，有旁白沒寫 narrator_voice',
    bible: (b) => { delete b.characters[0].voice; delete b.project.narrator_voice; },
    expect: [/C01：林晚 有台詞，沒有寫 voice/, /project\.narrator_voice：有旁白，沒有寫 narrator_voice/],
  },
  { name: '同一個機位，道具沒交代就不見了', ep: (e) => { shot(e, '006').props = ''; }, expect: [/EP01-006：P01（信）在 EP01-005（同一個機位 S01-C）的畫面裡/] },
  { name: '鏡頭都沒有填 beat', ep: (e) => { for (const s of e.shots) delete s.beat; }, expect: [/beat：鏡頭都沒有填 beat/] },
  {
    name: '節拍：有的沒填、每個節拍都只有一鏡、順序倒回、沒寫走位、高點對不上',
    ep: (e) => {
      for (const s of e.shots) delete s.beat;
      Object.assign(shot(e, '002'), { beat: '1.2' });
      Object.assign(shot(e, '004'), { beat: '1.1' });
      Object.assign(shot(e, '006'), { beat: '1.3' });
      Object.assign(shot(e, '008'), { beat: '1.4' });
      delete e.plan[0].blocking;
      e.plan[0].peak = '不存在的節拍';
    },
    expect: [/\[警告\] beat：EP01-001、EP01-003、EP01-005、EP01-007 沒有填 beat/, /plan 第 1 場：4 個節拍都只有一鏡/, /EP01-004：beat 從 1\.2 倒回 1\.1/, /plan 第 1 場：這場戲有 2 個角色，沒有寫 blocking/, /plan 第 1 場：peak「不存在的節拍」對不上任何一個節拍/],
  },
  { name: '舊寫法：鏡頭類型寫在 size 裡', ep: (e) => { shot(e, '005').size = '過肩'; }, expect: [/整體：1 鏡把鏡頭類型寫在 size 裡/] },
  {
    name: '連續四鏡以上同一個景別',
    ep: (e) => { shot(e, '004').size = '近景'; shot(e, '007').size = '近景'; },
    expect: [/EP01-003：從這一鏡起連續 6 鏡都是近景|EP01-004：從這一鏡起連續 5 鏡都是近景/],
  },
  { name: '超過一分鐘卻沒有建議切點', ep: (e) => { shot(e, '002').duration = 45; }, expect: [/整體：整集約 \d+ 秒，沒有標任何建議切點/] },
  { name: '整集超過單集長度上限', bible: (b) => { b.project.episode_length = [10, 15]; }, expect: [/\[警告\] 整體：整集約 \d+ 秒，超過單集長度上限 15 秒/] },
  { name: '整集不到單集長度下限', bible: (b) => { b.project.episode_length = [60, 90]; }, expect: [/\[警告\] 整體：整集約 \d+ 秒，不到單集長度下限 60 秒/] },
  { name: '旁邊的分集表沒有這一集', extra: { 'series.json': JSON.stringify({ episodes: [{ episode: 'EP02' }] }) }, expect: [/分集表：bible\.json 旁邊的 series\.json 裡沒有 EP01/] },
  { name: '所有鏡頭一樣長', ep: (e) => { for (const s of e.shots) s.duration = 3; }, expect: [/整體：所有鏡頭都是 3 秒/] },
  {
    name: '大部分的 motion 都寫「緩慢」',
    ep: (e) => { for (const s of e.shots) if (s.motion) s.motion = `${s.motion}，動作緩慢`; },
    expect: [/整體：\d+\/8 鏡的 motion 都強調「緩慢」/],
  },

  // ---------- 分集表 ----------
  {
    name: '分集表：沒有任何一集、沒有單集長度',
    bible: (b) => { delete b.project.episode_length; },
    series: (s) => { s.episodes = []; },
    expect: [/\[錯誤\] episodes：分集表裡沒有任何一集/, /project\.episode_length：設定檔沒有 episode_length（單集長度）；填了腳本才能檢查每一集的預估秒數/],
  },
  {
    name: '分集表：幕的範圍與轉折、集數、每一集缺的欄位',
    series: (s) => {
      s.total_episodes = 99;
      delete s.acts[0].turn;
      s.acts[1].range = [6, 9];
      s.acts[2].range = [10];
      for (const ep of s.episodes.slice(0, 3)) ep.cliff_type = '危機';
      s.episodes.push(
        { episode: 'EP13', cliff_type: '驚喜', cast: ['C99'], scenes: ['S01', 'S02', 'S03', 'S09'] },
        { episode: 'EP14' },
        clone(s.episodes[0]),
        { logline: '沒有集數的一集' },
      );
    },
    expect: [
      /\[警告\] 第 3 幕：range 要寫成 \[第一集, 最後一集\]/,
      /第 1 幕：沒有寫 turn/,
      /acts：幕與幕的集數範圍有重疊或缺口（1–4 接 6–9）/,
      /acts：最後一幕結束在第 9 集，但 total_episodes 是 99/,
      /\[警告\] EP13：沒有接在 EP04 後面/,
      /\[警告\] EP13：缺少 source/,
      /\[警告\] EP13：缺少 logline/,
      /\[警告\] EP13：缺少 hook/,
      /EP13：cliff_type「驚喜」不在分類裡/,
      /\[警告\] EP13：角色編號 C99 不在設定檔裡/,
      /\[警告\] EP13：場景編號 S09 不在設定檔裡/,
      /EP13：用到 4 個場景/,
      /\[警告\] EP13：缺少 est_seconds/,
      /EP13：不在任何一幕的集數範圍/,
      /\[警告\] EP14：缺少 cast/,
      /\[警告\] EP14：缺少 scenes/,
      /\[錯誤\] EP01：集數重複/,
      /\[錯誤\] 第 8 筆：缺少 episode/,
      /EP01：從這一集起連續 3 集的卡點都是「危機」/,
    ],
  },

  // ---------- 分集劇本 ----------
  {
    name: '分集劇本：沒有場標、說話者不在設定檔、一句太長、開頭沒寫鉤子',
    script: ['△ 當鋪裡，燈很暗。', '路人甲：你好。', `沈小禾：${'我不知道外婆為什麼要把我的記憶押在這裡'.repeat(2)}`].join('\n'),
    expect: [/\[警告\] 劇本：沒有讀到場標/, /第 2 行：說話者「路人甲」不是設定檔裡的角色名稱/, /第 3 行：「.*…」約需 [\d.]+ 秒，一鏡講不完/, /劇本：開頭沒有寫鉤子、爽點、卡點/],
  },
  { name: '分集劇本：讀不到畫面或台詞', script: '# 第一集\n隨便寫寫', expect: [/\[錯誤\] 劇本：沒有讀到任何畫面（△ 開頭）或台詞/] },
  {
    name: '分集劇本：台詞超過單集長度上限',
    script: ['## 第 1 場　當鋪　夜　內', ...Array.from({ length: 30 }, () => '沈小禾：這一句台詞大約要講三秒多一點點。')].join('\n'),
    expect: [/\[警告\] 劇本：台詞與旁白約需 \d+ 秒，已經超過單集長度上限 90 秒/],
  },
  {
    name: '分集劇本：台詞超過單集上限的四分之三',
    script: ['## 第 1 場　當鋪　夜　內', ...Array.from({ length: 20 }, () => '沈小禾：這一句台詞大約要講三秒多一點點。')].join('\n'),
    expect: [/\[警告\] 劇本：台詞與旁白約需 \d+ 秒，超過單集長度上限 90 秒的四分之三/],
  },
  {
    name: '分集劇本：設定檔沒有單集長度',
    bible: (b) => { delete b.project.episode_length; },
    script: '## 第 1 場　當鋪　夜　內\n△ 燈亮著。\n沈小禾：有人嗎？',
    expect: [/project\.episode_length：設定檔沒有 episode_length（單集長度）；填了才能比較台詞長度/],
  },
];

for (const c of CASES) {
  test(c.name, (t) => {
    const r = run(t, c);
    for (const re of c.expect) assert.match(r.checks, re, `${c.name}\n沒有出現：${re}\n${r.out}`);
    for (const re of c.absent || []) assert.doesNotMatch(r.checks, re, `${c.name}\n不該出現：${re}`);
    for (const [name, res] of Object.entries(c.files || {})) for (const re of res) assert.match(r.file(name), re);
  });
}
