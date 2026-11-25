#!/usr/bin/env node
/**
 * build_storyboard.mjs
 *
 * 把「設定檔 (bible.json)」和「分鏡資料 (EPxx.json)」組合成：
 *   - settings.md           設定表（角色、場景、道具、風格、待確認事項）＋ 資產提示詞
 *   - assets.csv            母圖、場景定稿圖、道具圖的提示詞
 *   - <集數>-storyboard.md  精簡表、導演表、每鏡可直接複製的提示詞、檢查結果
 *   - <集數>-shots.csv      同樣內容的試算表版本（含生成狀態欄，Excel 可直接開）
 *
 * 用法：
 *   node build_storyboard.mjs <bible.json>                只做設定表與資產提示詞
 *   node build_storyboard.mjs <bible.json> <EPxx.json>    另外做該集分鏡
 *   可加 --out <資料夾>（預設是 bible.json 旁邊的 out/）
 *
 * 沒有外部相依，Node 16 以上即可。欄位定義見 references/fields.md。
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------- 參數 ----------
function usage(code) {
  console.log(`用法：
  node build_storyboard.mjs <bible.json> [<EPxx.json>] [--out <資料夾>]

  只給 bible.json：產出 settings.md 與 assets.csv
  再給分鏡檔　　：另外產出 <集數>-storyboard.md、<集數>-shots.csv 與檢查結果`);
  process.exit(code);
}
const argv = process.argv.slice(2);
let outDir = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outDir = argv[++i];
  else if (argv[i] === '-h' || argv[i] === '--help') usage(0);
  else files.push(argv[i]);
}
if (files.length < 1 || files.length > 2) usage(2);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error(`讀不到檔案，或內容不是合法的 JSON：${p}\n${e.message}`);
    process.exit(2);
  }
}
const bible = readJson(files[0]);
const ep = files[1] ? readJson(files[1]) : null;
outDir = outDir || path.join(path.dirname(path.resolve(files[0])), 'out');
fs.mkdirSync(outDir, { recursive: true });

// ---------- 專案參數 ----------
const P = bible.project || {};
let langs = (Array.isArray(P.prompt_langs) ? P.prompt_langs : []).filter((l) => l === 'zh' || l === 'en');
if (!langs.length) langs = ['zh', 'en'];
const MODE = P.video_mode === 't2v' ? 't2v' : 'i2v';
const USE_LAST = P.use_last_frame !== false;
const NATIVE_AUDIO = P.audio_plan === '原生音訊';
// 工具可生成的秒數是連續範圍時用 clip_range: [最短, 最長]；是固定幾種時用 clip_lengths
const CLIPS = (Array.isArray(P.clip_lengths) ? P.clip_lengths : []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const RANGE = Array.isArray(P.clip_range) && P.clip_range.length === 2 && P.clip_range.every((n) => Number(n) > 0)
  ? P.clip_range.map(Number).sort((a, b) => a - b)
  : null;
const HAS_CLIP = CLIPS.length > 0 || !!RANGE;
const MAX_CLIP = RANGE ? RANGE[1] : CLIPS[CLIPS.length - 1];
const LIMITS = P.prompt_limits || {}; // {"image": {"zh": 300, "en": 600}, "video": {...}}；zh 算字數，en 算詞數
const TRIM = 1; // 每段裁掉頭尾各約 0.5 秒
const RATE = Number(P.speech_rate) > 0 ? Number(P.speech_rate) : 4.5; // 中文每秒字數
// ---------- 問題收集 ----------
const issues = []; // {level: '錯誤'|'警告'|'提示', where, msg}
const report = (level, where, msg) => {
  if (!issues.some((x) => x.level === level && x.where === where && x.msg === msg)) issues.push({ level, where, msg });
};
const err = (where, msg) => report('錯誤', where, msg);
const warn = (where, msg) => report('警告', where, msg);
const hint = (where, msg) => report('提示', where, msg);

// ---------- 文字工具 ----------
const T = {
  zh: {
    name: '中文',
    sep: '，',
    stop: '。',
    cam: (c) => (/^鏡頭/.test(c) ? c : `鏡頭${c}`),
    says: (who, text, lang) => `${who}${lang ? `用${lang}` : ''}說：“${text}”`, // 各家工具都以雙引號辨識台詞
    sound: (s) => `聲音：${s}`,
    lastFrame: (end, cam) =>
      `以這一鏡的首幀圖為底圖做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}${cam ? `。構圖依運鏡調整（${cam}）` : ''}`,
    reuse: (id) => `沿用 ${id} 的最後一幀當首幀，不另外生成。`,
    sheet: (pose) => `角色設定圖，同一角色的${pose}，純淺灰背景，均勻柔光`,
    pose: '正面、側面、背面全身三視圖，自然站姿，表情平靜',
    variantEdit: (baseId, change) => `以 ${baseId} 的角色設定圖為底圖做圖像編輯，臉、髮型與體型保持不變，造型改成：${change}`,
    faces: (expr) => `同一角色的半身表情組圖，相同角度，表情依序是：${expr}，純淺灰背景，均勻柔光`,
    expr: '平靜、微笑、難過、生氣',
    master: '純場景空鏡，全景，平視',
    prop: '單一物件，置於畫面中央，純淺灰背景，均勻柔光',
  },
  en: {
    name: 'English',
    sep: ', ',
    stop: '. ',
    cam: (c) => c,
    says: (who, text, lang) => `${who} says${lang ? ` in ${lang}` : ''}: "${text}"`,
    sound: (s) => `Audio: ${s}`,
    lastFrame: (end, cam) =>
      `Edit the first-frame image of this shot and keep everything not mentioned here unchanged. End state: ${end}${cam ? `. Adjust the framing for the camera move (${cam})` : ''}`,
    reuse: (id) => `Use the last frame of ${id} as the first frame.`,
    sheet: (pose) => `character reference sheet, the same character shown as ${pose}, plain light grey background, soft even lighting`,
    pose: 'front, side and back full-body views, natural standing pose, calm expression',
    variantEdit: (baseId, change) => `Edit the ${baseId} character reference sheet: keep the face, hairstyle and build unchanged; change the look to: ${change}`,
    faces: (expr) => `expression sheet of the same character, bust view, same angle, expressions in order: ${expr}, plain light grey background, soft even lighting`,
    expr: 'calm, smiling, sad, angry',
    master: 'scenery only, unoccupied, wide shot, eye level',
    prop: 'a single object centred in frame, plain light grey background, soft even lighting',
  },
};
const SIZE_EN = {
  大遠景: 'extreme wide shot', 遠景: 'wide shot', 全景: 'full shot', 中景: 'medium shot',
  中近景: 'medium close-up', 近景: 'close shot', 特寫: 'close-up', 大特寫: 'extreme close-up',
  過肩: 'over-the-shoulder shot', 主觀: 'first-person POV shot', 背影: 'shot from behind',
  空鏡: 'scenery shot', 物件特寫: 'close-up of the object',
};
// 幾個鏡別單獨放進中文提示詞會有歧義，換成說得清楚的寫法
const SIZE_ZH = { 過肩: '過肩鏡頭', 主觀: '第一人稱主觀視角', 背影: '從人物背後拍攝' };
const CAM_EN = {
  固定: 'static camera', 緩慢推近: 'slow, slight push-in', 緩慢拉遠: 'slow, slight pull-out',
  輕微橫移: 'slight lateral move', 輕微跟拍: 'gentle follow shot', 輕微手持: 'subtle handheld sway',
  輕微上搖: 'slight tilt up', 輕微下搖: 'slight tilt down',
};
const WIDE = new Set(['大遠景', '遠景', '全景', '空鏡']);
const CLOSE = new Set(['中近景', '近景', '特寫', '大特寫']);
const CJK = /[㐀-鿿぀-ヿ]/;
const CJK_G = /[㐀-鿿぀-ヿ]/g;

// 道具：片段裡寫 {P01}，會換成設定檔裡那件道具的描述
const propDefs = new Map();
const PROP_RE = /\{(P[0-9A-Za-z_-]*)\}/g;
for (const p of bible.props || []) {
  if (!p.id) { err('props', '有道具缺少 id'); continue; }
  if (propDefs.has(p.id)) err(p.id, '道具編號重複');
  propDefs.set(p.id, p);
}

function rawPick(v, l) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v[l] ?? v.zh ?? v.en ?? '').trim();
  return String(v);
}
/** 取出某個語言的文字，並把 {P01} 換成道具描述。欄位可以是字串，或 {"zh": "…", "en": "…"}。 */
function pick(v, l) {
  return rawPick(v, l).replace(PROP_RE, (m, id) => (propDefs.has(id) ? rawPick(propDefs.get(id).desc, l) : m));
}
const strip = (s) => String(s || '').trim().replace(/[，,。.；;、\s]+$/u, '');
const joinC = (parts, l) => parts.map(strip).filter(Boolean).join(T[l].sep);
const joinS = (parts, l) => {
  let s = parts.map(strip).filter(Boolean);
  if (l === 'en') s = s.map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  return s.length ? s.join(T[l].stop) + T[l].stop.trim() : '';
};
const term = (v, map, l) => {
  if (v && typeof v === 'object') return pick(v, l);
  const s = pick(v, l);
  if (l === 'en' && map[s]) return map[s];
  if (l === 'zh' && map === SIZE_EN && SIZE_ZH[s]) return SIZE_ZH[s];
  return s;
};
/** 表格顯示用：多語言時兩種都列出。 */
const show = (v) => [...new Set(langs.map((l) => pick(v, l)).filter(Boolean))].join('<br>');
const zhOf = (v) => pick(v, 'zh');

const REF_RE = /同上|同前|如前|same as above|as before|as above/i;
const TEXT_RE = /寫著|寫有|字樣|上面的字|that (says|reads)|text reading|with the words/i;
const SCREEN_RE = /畫面(的)?[左右]|鏡頭(的)?[左右]|螢幕[左右]|screen[- ](left|right)|frame[- ](left|right)|(left|right) of (the )?(frame|screen)/i;
const FAST_RE = /快速|迅速|急速|猛烈|劇烈|猛地|猛然|瞬間|飛快|狂奔|飛撲|暴衝|大幅|\b(rapid(ly)?|violent(ly)?|sudden(ly)?|quick(ly)?|fast|dramatic(ally)?|bursts?|lunges?|dash(es)?|sprints?|slams?|whips?)\b/i;
const SLOW_RE = /緩慢|慢慢|緩緩|慢速|\bslow(ly)?\b/i;

/** 檢查一段提示詞片段：語言是否齊全、有沒有指代、未知道具或要求可讀文字。 */
function checkFrag(where, v, required = false) {
  const empty = v == null || (typeof v === 'string' ? !v.trim() : !langs.some((l) => String(v?.[l] ?? '').trim()));
  if (empty) {
    if (required) err(where, '必填，但目前是空的');
    return;
  }
  for (const l of langs) {
    if (typeof v === 'object' && !String(v[l] ?? '').trim()) {
      warn(where, `提示詞語言包含 ${l}，但這一段沒有 ${l} 的寫法`);
      continue;
    }
    const s = pick(v, l);
    if (l === 'en' && typeof v === 'string' && CJK.test(s)) {
      warn(where, '提示詞語言包含 en，但這一段只有中文；請寫成 {"zh": "…", "en": "…"}');
    }
    const unknown = s.match(PROP_RE);
    if (unknown) err(where, `用了設定檔 props 裡沒有的道具編號：${[...new Set(unknown)].join('、')}`);
    if (REF_RE.test(s)) warn(where, '用了「同上／如前」之類的指代；每一鏡都要能單獨看懂，請直接寫出內容');
    if (TEXT_RE.test(s)) warn(where, '看起來要求畫面出現可讀文字；多數生成工具寫不好字，請改成後製加字');
  }
}

// ---------- 建立索引並檢查設定檔 ----------
if (!P.style_lock) err('project.style_lock', '缺少風格鎖定句');
checkFrag('project.style_lock', P.style_lock);
checkFrag('project.negative_global', P.negative_global);
checkFrag('project.speech_lang', P.speech_lang);
checkFrag('project.audio_suffix', P.audio_suffix);
for (const p of propDefs.values()) checkFrag(`${p.id}.desc`, p.desc, true);

const chars = new Map(); // 角色編號或造型變體編號 -> { c, v }
const charList = [];
for (const c of bible.characters || []) {
  if (!c.id) { err('characters', '有角色缺少 id'); continue; }
  if (chars.has(c.id)) err(c.id, '角色編號重複');
  const vs = Array.isArray(c.variants) && c.variants.length
    ? c.variants
    : [{ id: c.id, label: '', outfit: c.outfit || '', state: '' }];
  charList.push({ c, vs });
  chars.set(c.id, { c, v: vs[0] });
  for (const v of vs) {
    if (!v.id) { err(c.id, '有造型變體缺少 id'); continue; }
    if (v.id !== c.id && chars.has(v.id)) err(v.id, '造型變體編號重複');
    chars.set(v.id, { c, v });
    checkFrag(`${v.id}.outfit`, v.outfit, true);
    checkFrag(`${v.id}.outfit_top`, v.outfit_top);
    checkFrag(`${v.id}.state`, v.state);
    checkFrag(`${v.id}.sheet`, v.sheet);
  }
  checkFrag(`${c.id}.look`, c.look, true);
  checkFrag(`${c.id}.marks`, c.marks);
  checkFrag(`${c.id}.expressions`, c.expressions);
  if (!c.tag) warn(`${c.id}.tag`, '缺少短稱（tag）；影片提示詞要用它來指這個角色');
  else checkFrag(`${c.id}.tag`, c.tag);
}

const scenes = new Map();
for (const s of bible.scenes || []) {
  if (!s.id) { err('scenes', '有場景缺少 id'); continue; }
  if (scenes.has(s.id)) err(s.id, '場景編號重複');
  scenes.set(s.id, s);
  checkFrag(`${s.id}.space`, s.space, true);
  checkFrag(`${s.id}.light`, s.light, true);
  checkFrag(`${s.id}.time`, s.time);
  if (langs.some((l) => SCREEN_RE.test(pick(s.space, l)))) {
    warn(`${s.id}.space`, '場景描述用了「畫面左／右」；換個角度拍就會錯，請改寫成空間關係（例如「窗在沙發對面」），畫面位置留給每一鏡的 pos');
  }
}

// ---------- 提示詞組合 ----------
const isPartialText = (e) => e.partial && e.partial !== true;
function subject(entry, shot, l, withBlocking = true) {
  const hit = chars.get(entry.char);
  if (!hit) return '';
  const { c, v } = hit;
  // 近景看不到下半身：有填 outfit_top 就用它
  const outfit = CLOSE.has(zhOf(shot.size)) && pick(v.outfit_top, l) ? pick(v.outfit_top, l) : pick(v.outfit, l);
  let base;
  if (isPartialText(entry)) base = [pick(entry.partial, l)]; // 只入鏡一部分：直接寫看得到的那一部分
  else if (entry.partial === true) base = [pick(c.tag, l), outfit]; // 背影、前景虛焦：不寫臉部細節與狀態
  else base = [pick(c.look, l), outfit, pick(v.state, l), pick(c.marks, l)];
  const block = withBlocking ? [pick(entry.pos, l), pick(entry.gaze, l), pick(entry.hands, l), pick(entry.face, l)] : [];
  return joinC([...base, ...block], l);
}
/** 光線：這一鏡有自己的 light 就用它，否則用場景的光線與時間。 */
const lightOf = (shot, sc, l) => pick(shot.light, l) || joinC([pick(sc.light, l), pick(sc.time, l)], l);
function imagePrompt(shot, l) {
  const sc = scenes.get(shot.scene) || {};
  const subs = (shot.cast || []).map((e) => subject(e, shot, l));
  return joinS([
    ...subs,
    pick(shot.props, l),
    pick(shot.bg, l) || pick(sc.space, l), // 近景只寫看得到的背景；沒寫 bg 才用整段場景描述
    lightOf(shot, sc, l),
    joinC([term(shot.size, SIZE_EN, l), pick(shot.frame, l)], l),
    pick(P.style_lock, l),
  ], l);
}
const camTerm = (shot, l) => term(shot.camera, CAM_EN, l);
function lastFramePrompt(shot, l) {
  const end = strip(pick(shot.end, l));
  if (!end) return '';
  const moving = zhOf(shot.camera) && zhOf(shot.camera) !== '固定';
  return T[l].lastFrame(end, moving ? camTerm(shot, l) : '') + T[l].stop.trim();
}
function audioParts(shot, l) {
  if (!NATIVE_AUDIO) return [];
  const out = [];
  const ln = shot.line;
  if (ln && ln.text && ln.type === '對白') {
    const hit = chars.get(ln.who);
    const who = hit ? pick(hit.c.tag, l) || hit.c.name : ln.who || '';
    out.push(T[l].says(who, strip(pick(ln.text, langs[0])), pick(P.speech_lang, l)));
  }
  if (shot.sound) out.push(T[l].sound(pick(shot.sound, l)));
  if (P.audio_suffix) out.push(pick(P.audio_suffix, l));
  return out;
}
function videoPrompt(shot, l) {
  const cam = T[l].cam(camTerm(shot, l));
  if (MODE === 'i2v') {
    // 圖生影片：首幀圖已經決定了外貌與場景，這裡只寫「怎麼動」
    return joinS([pick(shot.motion, l), cam, ...audioParts(shot, l)], l);
  }
  const sc = scenes.get(shot.scene) || {};
  const subs = (shot.cast || []).map((e) => subject(e, shot, l));
  return joinS([
    ...subs,
    pick(shot.props, l),
    pick(shot.motion, l),
    pick(shot.bg, l) || pick(sc.space, l),
    lightOf(shot, sc, l),
    joinC([term(shot.size, SIZE_EN, l), cam], l),
    pick(P.style_lock, l),
    ...audioParts(shot, l),
  ], l);
}
const negativePrompt = (shot, l) => joinC([pick(P.negative_global, l), pick(shot.negative, l)], l);
/** 建議生成秒數：undefined＝沒填工具秒數；null＝超過工具上限。 */
const genLength = (d) => {
  if (!HAS_CLIP) return undefined;
  const need = d + TRIM;
  if (RANGE) return need > RANGE[1] ? null : Math.max(RANGE[0], Math.ceil(need));
  return CLIPS.find((c) => c >= need) ?? null;
};
const measure = (s, l) => (l === 'zh' ? [...s].length : (s.match(/\S+/g) || []).length);
function checkLimit(id, kind, s, l) {
  const max = Number(LIMITS?.[kind]?.[l]);
  if (!(max > 0)) return;
  const n = measure(s, l);
  if (n > max) {
    warn(id, `${kind === 'image' ? '首幀圖像' : '影片'}提示詞（${l}）有 ${n} ${l === 'zh' ? '字' : '個詞'}，超過工具上限 ${max}；用 bg 縮短背景、把背影角色設成 partial、填 outfit_top，或精簡走位描述`);
  }
}

// ---------- 資產提示詞（母圖、場景定稿圖、道具圖） ----------
const assets = []; // {id, kind, lang, prompt}
for (const { c, vs } of charList) {
  vs.forEach((v, i) => {
    for (const l of langs) {
      if (i > 0 && !pick(v.sheet, l)) {
        // 第二個以後的造型：從第一個造型的設定圖改，臉才不會變
        const change = joinC([pick(v.outfit, l), pick(v.state, l)], l);
        assets.push({ id: v.id, kind: `設定圖（由 ${vs[0].id} 改）`, lang: l, prompt: T[l].variantEdit(vs[0].id, change) + T[l].stop.trim() });
      } else {
        const who = joinC([pick(c.look, l), pick(v.outfit, l), pick(v.state, l), pick(c.marks, l)], l);
        assets.push({ id: v.id, kind: '設定圖', lang: l, prompt: joinS([who, T[l].sheet(pick(v.sheet, l) || T[l].pose), pick(P.style_lock, l)], l) });
      }
    }
  });
  if (!c.minor) {
    for (const l of langs) {
      const v = vs[0];
      const who = joinC([pick(c.look, l), pick(v.outfit_top, l) || pick(v.outfit, l), pick(c.marks, l)], l);
      assets.push({ id: c.id, kind: '表情組圖', lang: l, prompt: joinS([who, T[l].faces(pick(c.expressions, l) || T[l].expr), pick(P.style_lock, l)], l) });
    }
  }
}
for (const s of scenes.values()) {
  for (const l of langs) {
    assets.push({
      id: s.id, kind: '場景定稿圖', lang: l,
      prompt: joinS([pick(s.space, l), joinC([pick(s.light, l), pick(s.time, l)], l), T[l].master, pick(P.style_lock, l)], l),
    });
  }
}
for (const p of propDefs.values()) {
  for (const l of langs) {
    assets.push({ id: p.id, kind: '道具圖', lang: l, prompt: joinS([pick(p.desc, l), T[l].prop, pick(P.style_lock, l)], l) });
  }
}

// ---------- 檢查分鏡 ----------
const shots = ep && Array.isArray(ep.shots) ? ep.shots : [];
const castKey = (s) => (s.cast || []).map((e) => e.char).sort().join('+');
const sizeKey = (s) => zhOf(s.size);
function speakSeconds(text) {
  const t = rawPick(text, langs[0]);
  const cjk = (t.match(CJK_G) || []).length;
  const words = (t.replace(CJK_G, ' ').match(/[A-Za-z0-9']+/g) || []).length;
  return cjk / RATE + words / 2.8;
}
if (ep) {
  if (!shots.length) err('shots', '分鏡檔裡沒有任何鏡頭');
  const seenIds = new Set();
  const seenScenes = new Set();
  let slow = 0;
  shots.forEach((s, i) => {
    const id = s.id || `第 ${i + 1} 鏡`;
    if (!s.id) err(id, '缺少鏡號 id');
    else if (seenIds.has(s.id)) err(id, '鏡號重複');
    seenIds.add(s.id);

    for (const k of ['size', 'camera', 'action']) if (!s[k]) err(id, `缺少 ${k}`);
    if (!(Number(s.duration) > 0)) err(id, 'duration 要是大於 0 的秒數');
    if (!s.source) warn(id, '缺少 source（原文對應）；沒有它，使用者很難核對有沒有漏劇情');
    if (s.cut != null && s.cut !== true && s.cut !== false && typeof s.cut !== 'string') warn(id, 'cut 要寫成一句理由（例如「懸念：她看見訊息」）');
    if (s.cut && i === shots.length - 1) hint(id, '最後一鏡本來就是結尾，不用標 cut');
    if (!scenes.has(s.scene)) err(id, `場景編號 ${s.scene ?? '（空）'} 不在設定檔裡`);
    else if (!seenScenes.has(s.scene)) {
      seenScenes.add(s.scene);
      // 漫劇的第一鏡常是鉤子（特寫或細節），不提示
      const hook = P.format === '漫劇' && i === 0;
      if (!WIDE.has(sizeKey(s)) && !hook) hint(id, `場景 ${s.scene} 第一次出現，考慮在前後兩三鏡內給一個全景或遠景交代環境（目前是${sizeKey(s)}）`);
    }

    // 角色與走位
    const cast = Array.isArray(s.cast) ? s.cast : [];
    cast.forEach((e) => {
      if (!chars.has(e.char)) { err(id, `角色編號 ${e.char ?? '（空）'} 不在設定檔裡`); return; }
      const miss = ['pos', 'gaze', 'hands'].filter((k) => !e[k]);
      if (miss.length) warn(id, `${e.char} 沒寫 ${miss.join('、')}；沒寫的地方生成工具會自己猜`);
      for (const k of ['pos', 'gaze', 'hands', 'face']) checkFrag(`${id} ${e.char}.${k}`, e[k]);
      if (isPartialText(e)) checkFrag(`${id} ${e.char}.partial`, e.partial);
    });
    for (const k of ['props', 'frame', 'bg', 'light', 'negative', 'end']) checkFrag(`${id}.${k}`, s[k]);
    checkFrag(`${id}.motion`, s.motion, true);
    if (NATIVE_AUDIO) checkFrag(`${id}.sound`, s.sound);
    if (USE_LAST && cast.length && !s.end) warn(id, '缺少 end（尾幀與首幀的差別）；有首尾幀控制時動作最穩');

    // 動作描述
    const motions = langs.map((l) => pick(s.motion, l));
    if (motions.some((m) => FAST_RE.test(m))) warn(id, 'motion 用了「快速／劇烈／瞬間」這類字眼，容易變形；改用剪接表現速度，單鏡內寫正常速度、小幅度');
    if (motions.some((m) => SLOW_RE.test(m))) slow++;
    const fullCast = cast.filter((e) => !isPartialText(e));
    if (fullCast.length) {
      for (const l of langs) {
        const m = pick(s.motion, l).toLowerCase();
        const tags = fullCast.map((e) => pick(chars.get(e.char)?.c.tag, l).toLowerCase()).filter(Boolean);
        if (m && tags.length && !tags.some((t) => m.includes(t))) {
          warn(id, `motion（${l}）沒有用到任何角色的短稱（tag）；請用短稱指人，不要用代名詞或名字`);
        }
      }
    }

    // 銜接
    if (s.link !== '切' && s.link !== '接續') err(id, 'link 只能是「切」或「接續」');
    if (s.link === '接續') {
      const prev = shots[i - 1];
      if (!prev) err(id, '第一鏡不能是「接續」');
      else {
        if (prev.scene !== s.scene) warn(id, '「接續」表示沿用上一鏡的最後一幀，但場景和上一鏡不同；應該是「切」');
        if (castKey(prev) !== castKey(s)) warn(id, '「接續」表示沿用上一鏡的最後一幀，但畫面中的角色和上一鏡不同；應該是「切」');
      }
    }

    // 時長
    const d = Number(s.duration) || 0;
    if (s.line && s.line.text) {
      const need = speakSeconds(s.line.text) + 0.3;
      if (need > d) warn(id, `對白／旁白約需 ${need.toFixed(1)} 秒（字數 ÷ ${RATE} + 0.3），但這一鏡只有 ${d} 秒；請拆成兩鏡、縮短句子，或把句子分到相鄰兩鏡的 line`);
      if (!['VO', 'OS', '對白'].includes(s.line.type)) hint(id, 'line.type 建議用 VO（旁白或畫外音）、OS（內心獨白）或 對白');
      if (P.audio_plan === '旁白' && s.line.type === '對白') hint(id, '聲音方案是「旁白」，這句卻是對白；角色的台詞要當畫外音時，type 用 VO、who 填角色編號');
    }
    if (HAS_CLIP && genLength(d) === null) {
      warn(id, `成片 ${d} 秒加上裁頭尾 ${TRIM} 秒，超過工具單次可生成的 ${MAX_CLIP} 秒；請拆鏡`);
    }

    // 提示詞長度
    for (const l of langs) {
      if (s.link !== '接續') checkLimit(id, 'image', imagePrompt(s, l), l);
      checkLimit(id, 'video', videoPrompt(s, l), l);
    }
  });

  // 連續相同鏡別
  let run = 1;
  for (let i = 1; i <= shots.length; i++) {
    if (i < shots.length && sizeKey(shots[i]) === sizeKey(shots[i - 1]) && shots[i].scene === shots[i - 1].scene) run++;
    else {
      if (run >= 3) warn(shots[i - run].id, `從這一鏡起連續 ${run} 鏡都是${sizeKey(shots[i - 1])}，畫面會平；穿插不同鏡別或反應鏡頭`);
      run = 1;
    }
  }
  const totalSec = shots.reduce((n, s) => n + (Number(s.duration) || 0), 0);
  if (totalSec > 60 && !shots.slice(0, -1).some((s) => s.cut)) {
    hint('整體', `整集約 ${Math.round(totalSec)} 秒，沒有標任何建議切點；在場景結束或懸念處加上 cut，使用者想切短時才有地方下刀`);
  }
  const durs = new Set(shots.map((s) => Number(s.duration)));
  if (shots.length >= 6 && durs.size === 1) hint('整體', `所有鏡頭都是 ${[...durs][0]} 秒，節奏會單調；依內容給長短變化`);
  if (shots.length >= 5 && slow / shots.length > 0.6) {
    hint('整體', `${slow}/${shots.length} 鏡的 motion 都強調「緩慢」，成片容易像慢動作；多數鏡頭寫「自然速度、幅度小」即可`);
  }
}
if (Array.isArray(bible.pending) && bible.pending.length) {
  hint('設定檔', `還有 ${bible.pending.length} 項待確認設定，交付時要請使用者確認`);
}

// ---------- 輸出工具 ----------
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
].join('\n');
const code = (s) => '```text\n' + s + '\n```';
const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const langLabel = (l) => (langs.length > 1 ? `（${T[l].name}）` : '');
const issueTable = () => (issues.length
  ? table(['等級', '位置', '說明'], issues.map((x) => [x.level, x.where, x.msg]))
  : '腳本檢查沒有發現問題。');
const write = (name, text) => {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
};
const written = [];

// ---------- settings.md / assets.csv ----------
{
  const L = [];
  L.push(`# ${P.title || '未命名專案'}　設定表`, '');
  L.push('## 本次參數', '');
  L.push(table(['項目', '內容'], [
    ['形式', P.format || ''],
    ['畫幅', P.aspect ? `${P.aspect}（在生成工具裡選，提示詞不含畫幅）` : ''],
    ['圖像工具', P.image_tool || ''],
    ['影片工具', P.video_tool || ''],
    ['影片生成方式', MODE === 'i2v' ? '圖生影片（先出首幀圖）' : '文字生影片'],
    ['首尾幀', USE_LAST ? '使用' : '不使用'],
    ['聲音方案', P.audio_plan || ''],
    ['提示詞語言', langs.map((l) => T[l].name).join('＋')],
    ['單次可生成秒數', RANGE ? `${RANGE[0]} 到 ${RANGE[1]}` : CLIPS.length ? CLIPS.join(' / ') : '未填'],  ]), '');
  if (Array.isArray(bible.pending) && bible.pending.length) {
    L.push('## 待確認設定', '', '以下是原文沒寫、先補上的暫定值。要改請直接說，改一處所有鏡頭會一起更新。', '');
    for (const p of bible.pending) L.push(`- ${p}`);
    L.push('');
  }
  L.push('## 角色', '');
  L.push(table(['編號', '名稱', '短稱', '固定外貌', '辨識特徵', '造型變體'], charList.map(({ c, vs }) => [
    c.id, c.name || '', show(c.tag), show(c.look), show(c.marks),
    vs.map((v) => `${v.id}${v.label ? `（${v.label}）` : ''}：${show(v.outfit)}${show(v.state) ? `；${show(v.state)}` : ''}`).join('<br>'),
  ])), '');
  L.push('## 場景', '');
  L.push(table(['編號', '名稱', '空間', '光線', '時間／天氣'], [...scenes.values()].map((s) => [
    s.id, s.name || '', show(s.space), show(s.light), show(s.time),
  ])), '');
  if (propDefs.size) {
    L.push('## 道具', '');
    L.push(table(['編號', '名稱', '固定描述'], [...propDefs.values()].map((p) => [p.id, p.name || '', show(p.desc)])), '');
  }
  L.push('## 風格鎖定句', '', ...langs.map((l) => code(pick(P.style_lock, l))), '');
  if (langs.some((l) => pick(P.negative_global, l))) {
    L.push('## 通用負面詞', '', '貼在工具的負面提示詞欄位，整個專案共用。', '', ...langs.map((l) => code(pick(P.negative_global, l))), '');
  }
  L.push('## 資產提示詞', '', '先生成這些圖並定稿，之後每一鏡都掛它們當參考圖。', '');
  let last = '';
  for (const a of assets) {
    const h = `### ${a.id}　${a.kind}`;
    if (h !== last) { L.push(h, ''); last = h; }
    L.push(code(a.prompt), '');
  }
  if (Array.isArray(bible.log) && bible.log.length) {
    L.push('## 進度紀錄', '');
    for (const g of bible.log) L.push(`- ${g}`);
    L.push('');
  }
  if (!ep) L.push('## 檢查結果', '', issueTable(), '');
  written.push(write('settings.md', L.join('\n')));
  written.push(write('assets.csv', csv([
    ['編號', '類型', '語言', '提示詞', '模型', 'seed', '定稿檔名', '備註'],
    ...assets.map((a) => [a.id, a.kind, T[a.lang].name, a.prompt, '', '', '', '']),
  ])));
}

// ---------- 分鏡輸出 ----------
if (ep) {
  const epId = ep.episode || 'EP';
  const total = shots.reduce((n, s) => n + (Number(s.duration) || 0), 0);
  const who = (s) => (s.cast || []).map((e) => e.char).join('、') || '—';
  const lineText = (s) => {
    const ln = s.line;
    if (!ln || !ln.text) return '';
    const hit = chars.get(ln.who);
    const name = hit ? hit.c.name || ln.who : ln.who || '';
    return `${ln.type || ''}${name ? ` ${name}` : ''}：「${rawPick(ln.text, langs[0])}」`;
  };
  const note = (s) => [s.risk ? `風險：${s.risk}` : '', s.continuity ? `連戲：${s.continuity}` : ''].filter(Boolean).join('；');
  const firstFrame = (s, i, l) => (s.link === '接續' && shots[i - 1] ? T[l].reuse(shots[i - 1].id) : imagePrompt(s, l));
  // 累計時間：播到這一鏡結束是第幾秒（用成片秒數，也就是裁完頭尾的長度）
  const ends = [];
  shots.reduce((acc, s) => { ends.push(acc + (Number(s.duration) || 0)); return ends[ends.length - 1]; }, 0);
  const tc = (sec) => {
    const t = Math.round(sec * 10) / 10;
    const m = Math.floor(t / 60);
    const rest = Math.round((t - m * 60) * 10) / 10;
    const whole = Math.floor(rest);
    const frac = Math.round((rest - whole) * 10);
    return `${m}:${String(whole).padStart(2, '0')}${frac ? `.${frac}` : ''}`;
  };
  const isLast = (i) => i === shots.length - 1;
  const cutOf = (s, i) => (s.cut && !isLast(i) ? (s.cut === true ? '✂' : `✂ ${s.cut}`) : '');
  const cuts = shots.map((s, i) => ({ s, i })).filter(({ s, i }) => s.cut && !isLast(i));

  const L = [];
  L.push(`# ${P.title || '未命名專案'}　${epId}　分鏡表`, '');
  if (ep.source_title) L.push(`原文範圍：${ep.source_title}`, '');
  L.push(`共 ${shots.length} 鏡，成片約 ${Math.round(total)} 秒${P.aspect ? `，畫幅 ${P.aspect}（在生成工具裡選）` : ''}。設定表與資產提示詞見 settings.md。`, '');
  if (Array.isArray(ep.changes) && ep.changes.length) {
    L.push('## 對原文的改動', '');
    for (const c of ep.changes) L.push(`- ${c}`);
    L.push('');
  }
  L.push('## 精簡表', '', '貼到對話裡用這一張。「累計」是播到這一鏡結束的時間；有 ✂ 的鏡頭後面適合切開。', '');
  L.push(table(
    ['鏡號', '秒', '累計', '鏡別', '動作', '對白／旁白', '切點'],
    shots.map((s, i) => [s.id, s.duration, tc(ends[i]), zhOf(s.size), zhOf(s.action), lineText(s), cutOf(s, i)]),
  ), '');
  if (cuts.length) {
    L.push('## 建議切點', '', '想切成較短的片段時，從這些位置挑。時間是播到該鏡結束的累計時間。', '');
    L.push(table(['切在', '累計', '理由'], cuts.map(({ s, i }) => [`${s.id} 之後`, tc(ends[i]), s.cut === true ? '' : s.cut])), '');
  }
  L.push('## 導演表', '');
  L.push(table(
    ['鏡號', '原文對應', '場景', '角色', '秒', '累計', '鏡別', '運鏡', '銜接', '動作', '對白／旁白', '聲音', '備註', '切點'],
    shots.map((s, i) => [s.id, s.source || '', s.scene, who(s), s.duration, tc(ends[i]), zhOf(s.size), zhOf(s.camera), s.link, zhOf(s.action), lineText(s), zhOf(s.sound), note(s), cutOf(s, i)]),
  ), '');
  L.push('## 各鏡生成資料', '');
  shots.forEach((s, i) => {
    L.push(`### ${s.id}`, '');
    for (const e of s.cast || []) {
      L.push(`- ${e.char}${e.partial ? '（局部入鏡）' : ''}　位置：${zhOf(e.pos) || '—'}｜視線：${zhOf(e.gaze) || '—'}｜手部／道具：${zhOf(e.hands) || '—'}${e.face ? `｜表情：${zhOf(e.face)}` : ''}`);
    }
    if (s.props) L.push(`- 場上道具：${zhOf(s.props)}`);
    if (s.bg) L.push(`- 看得到的背景：${zhOf(s.bg)}`);
    if (s.light) L.push(`- 這一鏡的光線：${zhOf(s.light)}`);
    if (Array.isArray(s.refs) && s.refs.length) L.push(`- 參考圖：${s.refs.join('＋')}`);
    const g = genLength(Number(s.duration) || 0);
    if (g) L.push(`- 成片 ${s.duration} 秒，建議生成 ${g} 秒段再裁頭尾`);
    L.push('');
    for (const l of langs) {
      L.push(`首幀圖像提示詞${langLabel(l)}`, '', code(firstFrame(s, i, l)), '');
      if (USE_LAST && lastFramePrompt(s, l)) L.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`, '', code(lastFramePrompt(s, l)), '');
      L.push(`影片提示詞${langLabel(l)}`, '', code(videoPrompt(s, l)), '');
      if (pick(s.negative, l)) L.push(`這一鏡額外的負面詞${langLabel(l)}`, '', code(pick(s.negative, l)), '');
    }
  });
  L.push('## 檢查結果', '', issueTable(), '');
  written.push(write(`${epId}-storyboard.md`, L.join('\n')));

  const head = ['鏡號', '原文對應', '場景', '角色', '成片秒數', '累計', '建議生成秒數', '鏡別', '運鏡', '銜接', '動作', '對白／旁白', '聲音', '建議切點'];
  for (const l of langs) {
    head.push(`首幀圖像提示詞${langLabel(l)}`);
    if (USE_LAST) head.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`);
    head.push(`影片提示詞${langLabel(l)}`, `負面詞${langLabel(l)}`);
  }
  head.push('參考圖', '風險', '連戲備註', '模型', 'seed', '抽卡次數', '採用版本', '備註');
  const rows = shots.map((s, i) => {
    const r = [s.id, s.source || '', s.scene, who(s), s.duration, tc(ends[i]), genLength(Number(s.duration) || 0) ?? '', zhOf(s.size), zhOf(s.camera), s.link, zhOf(s.action), lineText(s), zhOf(s.sound), cutOf(s, i)];
    for (const l of langs) {
      r.push(firstFrame(s, i, l));
      if (USE_LAST) r.push(lastFramePrompt(s, l));
      r.push(videoPrompt(s, l), negativePrompt(s, l));
    }
    r.push((s.refs || []).join('＋'), s.risk || '', s.continuity || '', '', '', '', '', '');
    return r;
  });
  written.push(write(`${epId}-shots.csv`, csv([head, ...rows])));

  console.log(`${epId}：${shots.length} 鏡，成片約 ${Math.round(total)} 秒`);
}

// ---------- 結果 ----------
console.log('已寫出：');
for (const p of written) console.log(`  ${p}`);
const count = (lv) => issues.filter((x) => x.level === lv).length;
console.log(`檢查：錯誤 ${count('錯誤')}、警告 ${count('警告')}、提示 ${count('提示')}`);
for (const x of issues) console.log(`  [${x.level}] ${x.where}：${x.msg}`);
process.exit(count('錯誤') ? 1 : 0);
