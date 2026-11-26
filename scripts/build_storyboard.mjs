#!/usr/bin/env node
/**
 * build_storyboard.mjs
 *
 * 把「設定檔 (bible.json)」和「分鏡資料 (EPxx.json)」組合成：
 *   - settings.md           設定表（角色、場景、道具、風格、待確認事項）＋ 資產提示詞
 *   - assets.csv            母圖、場景定稿圖、道具圖、特效參考圖的提示詞
 *   - <集數>-storyboard.md  精簡表、導演表、每鏡可直接複製的提示詞、檢查結果
 *   - <集數>-shots.csv      同樣內容的試算表版本（含生成狀態與驗收欄，Excel 可直接開）
 *   - <集數>-assets.csv     這一集的機位背景圖提示詞（分鏡檔有 setups 時）
 *   - series.md             分集表（輸入是大綱時，整季每一集演什麼）
 *
 * 用法：
 *   node build_storyboard.mjs <bible.json>                   只做設定表與資產提示詞
 *   node build_storyboard.mjs <bible.json> <EPxx.json>       另外做該集分鏡
 *   node build_storyboard.mjs <bible.json> <series.json>     另外做分集表 series.md
 *   node build_storyboard.mjs <bible.json> <EPxx-script.md>  只檢查分集劇本（台詞長度、說話者），不寫檔案
 *   可加 --out <資料夾>（預設是 bible.json 旁邊的 out/）
 *
 * 沒有外部相依，Node 16 以上即可。欄位定義見 references/fields.md。
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------- 參數 ----------
function usage(code) {
  console.log(`用法：
  node build_storyboard.mjs <bible.json> [<EPxx.json> | <series.json> | <EPxx-script.md>] [--out <資料夾>]

  只給 bible.json：產出 settings.md 與 assets.csv
  再給分鏡檔　　：另外產出 <集數>-storyboard.md、<集數>-shots.csv 與檢查結果
  再給分集表　　：另外產出 series.md 與檢查結果
  再給分集劇本　：只檢查台詞長度與說話者，結果印在畫面上，不寫檔案`);
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
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    console.error(`讀不到檔案：${p}\n${e.message}`);
    process.exit(2);
  }
}
const bible = readJson(files[0]);
// 第二個檔案可以是分鏡檔（有 shots）、分集表（有 episodes）或分集劇本（.md）
const second = files[1] || null;
const scriptText = second && /\.(md|markdown|txt)$/i.test(second) ? readText(second) : null;
const secondJson = second && scriptText == null ? readJson(second) : null;
const series = secondJson && Array.isArray(secondJson.episodes) && !Array.isArray(secondJson.shots) ? secondJson : null;
const ep = secondJson && !series ? secondJson : null;
// 拆某一集時，bible.json 旁邊有分集表就讀進來，把這一集的鉤子、爽點、卡點列在分鏡表最上面
let seriesForEp = null;
let seriesReadError = '';
if (ep) {
  const sp = path.join(path.dirname(path.resolve(files[0])), 'series.json');
  if (fs.existsSync(sp)) {
    try { seriesForEp = JSON.parse(fs.readFileSync(sp, 'utf8').replace(/^﻿/, '')); } catch (e) { seriesReadError = e.message; }
  }
}
const epPlan = ep && seriesForEp && Array.isArray(seriesForEp.episodes)
  ? seriesForEp.episodes.find((e) => e && e.episode === ep.episode) || null
  : null;
outDir = outDir || path.join(path.dirname(path.resolve(files[0])), 'out');
if (scriptText == null) fs.mkdirSync(outDir, { recursive: true });

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
// 參考圖模式：角色、背景、道具改用「圖1中的…」指向參考圖，不再把整段外貌寫進每一鏡
const REF_MODE = P.ref_mode === '參考圖';
const REF_MAX = Number(P.ref_max) > 0 ? Number(P.ref_max) : 0; // 工具一次最多能掛幾張參考圖
// ---------- 問題收集 ----------
const issues = []; // {level: '錯誤'|'警告'|'提示', where, msg}
const report = (level, where, msg) => {
  if (!issues.some((x) => x.level === level && x.where === where && x.msg === msg)) issues.push({ level, where, msg });
};
const err = (where, msg) => report('錯誤', where, msg);
const warn = (where, msg) => report('警告', where, msg);
const hint = (where, msg) => report('提示', where, msg);

// 單集長度 [最短, 最長]（秒）：使用者或大綱指定了才有。不填就是一章一集、不設上限
const EP_LEN = Array.isArray(P.episode_length) && P.episode_length.length === 2 && P.episode_length.every((n) => Number(n) > 0)
  ? P.episode_length.map(Number).sort((a, b) => a - b)
  : null;
if (P.episode_length != null && !EP_LEN) {
  hint('project.episode_length', '要寫成 [最短, 最長] 的秒數，例如 [60, 90]；目前的寫法腳本讀不懂，不會檢查單集長度');
}
const SHORT_EP = !!EP_LEN && EP_LEN[1] <= 120; // 兩分鐘以內的短集不用標建議切點
if (P.ref_mode != null && !['文字', '參考圖'].includes(P.ref_mode)) {
  hint('project.ref_mode', `ref_mode 請填「文字」或「參考圖」；目前的「${P.ref_mode}」當成「文字」處理`);
}
if (P.ref_max != null && !REF_MAX) hint('project.ref_max', 'ref_max 要是大於 0 的整數（工具一次最多能掛幾張參考圖）；目前不檢查張數');
if (seriesReadError) hint('series.json', `bible.json 旁邊的 series.json 不是合法的 JSON，分鏡表不會列出這一集的鉤子與卡點：${seriesReadError}`);

// ---------- 文字工具 ----------
const T = {
  zh: {
    name: '中文',
    sep: '，',
    stop: '。',
    cam: (c) => (/^鏡頭/.test(c) ? c : `鏡頭${c}`),
    // 各家工具都以雙引號辨識台詞；語氣用敘述帶出（可靈、Seedance、Google 的官方範例都是這樣寫）
    says: (who, text, lang, tone) => `${who}${tone ? `以${tone}的語氣` : ''}${lang ? `用${lang}` : ''}說：“${text}”`,
    sound: (s) => `聲音：${s}`,
    lastFrame: (end, cam) =>
      `以這一鏡的首幀圖為底圖做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}${cam ? `。構圖依運鏡調整（${cam}）` : ''}`,
    reuse: (id) => `沿用 ${id} 的最後一幀當首幀，不另外生成。`,
    sheet: (pose) => `角色設定圖，同一角色的${pose}，純淺灰背景，均勻柔光`,
    pose: '正面、側面、背面全身三視圖，自然站姿，表情平靜',
    poseScale: '正面、側面、背面全身三視圖，旁邊站著一個灰色的成年人剪影作為比例參考',
    fx: '特效參考圖，單獨呈現，置於畫面中央，純黑背景',
    variantEdit: (baseId, change) => `以 ${baseId} 的角色設定圖為底圖做圖像編輯，臉、髮型與體型保持不變，造型改成：${change}`,
    faces: (expr) => `同一角色的半身表情組圖，相同角度，表情依序是：${expr}，純淺灰背景，均勻柔光`,
    expr: '平靜、微笑、難過、生氣',
    states: (expr) => `同一角色的狀態組圖，相同角度，依序是：${expr}，純淺灰背景，均勻柔光`,
    master: '純場景空鏡，全景，平視',
    prop: '單一物件，置於畫面中央，純淺灰背景，均勻柔光',
    plate: '純背景空景，取景比這個機位的鏡頭略寬',
    // 參考圖模式：用工具的指稱語法（預設「圖1」）指出每樣東西參照哪一張圖
    refDefault: '圖{n}',
    refWho: (t, tag) => `${t}中的${tag}`,
    refTag: (t) => `（${t}）`,
    refPart: (t) => `（顏色與質感參照${t}）`,
    refBg: (t, bg) => `背景參照${t}${bg ? `：${bg}` : ''}`,
  },
  en: {
    name: 'English',
    sep: ', ',
    stop: '. ',
    cam: (c) => c,
    says: (who, text, lang, tone) => `${who} says${lang ? ` in ${lang}` : ''}${tone ? `, ${tone}` : ''}: "${text}"`,
    sound: (s) => `Audio: ${s}`,
    lastFrame: (end, cam) =>
      `Edit the first-frame image of this shot and keep everything not mentioned here unchanged. End state: ${end}${cam ? `. Adjust the framing for the camera move (${cam})` : ''}`,
    reuse: (id) => `Use the last frame of ${id} as the first frame.`,
    sheet: (pose) => `character reference sheet, the same character shown as ${pose}, plain light grey background, soft even lighting`,
    pose: 'front, side and back full-body views, natural standing pose, calm expression',
    poseScale: 'front, side and back full-body views, with a plain grey adult human silhouette standing beside it for scale',
    fx: 'visual effect reference, shown on its own, centred in frame, plain black background',
    variantEdit: (baseId, change) => `Edit the ${baseId} character reference sheet: keep the face, hairstyle and build unchanged; change the look to: ${change}`,
    faces: (expr) => `expression sheet of the same character, bust view, same angle, expressions in order: ${expr}, plain light grey background, soft even lighting`,
    expr: 'calm, smiling, sad, angry',
    states: (expr) => `state sheet of the same character, same angle, in order: ${expr}, plain light grey background, soft even lighting`,
    master: 'scenery only, unoccupied, wide shot, eye level',
    prop: 'a single object centred in frame, plain light grey background, soft even lighting',
    plate: 'empty background plate, scenery only, unoccupied, framed slightly wider than the shot',
    refDefault: 'image {n}',
    refWho: (t, tag) => `${tag} from ${t}`,
    refTag: (t) => ` (${t})`,
    refPart: (t) => ` (colours and textures as in ${t})`,
    refBg: (t, bg) => `background as in ${t}${bg ? `: ${bg}` : ''}`,
  },
};
// ---------- 用詞表（定義與用法見 references/fields.md 的「用詞」） ----------
// 景別（size）只管取景範圍。「中景」「近景」這些詞各地用法不同，生成工具也各自解讀，
// 所以畫面裡有完整入鏡的人物時，腳本會把取景範圍一起寫進提示詞（zhBody／enBody）。
const SIZES = {
  大遠景: { en: 'extreme wide shot' },
  遠景: { en: 'wide shot' },
  全景: { en: 'full shot', zhBody: '人物全身入鏡', enBody: 'full body in frame' },
  中全景: { en: 'medium full shot', zhBody: '膝蓋以上入鏡', enBody: 'framed from the knees up' },
  中景: { en: 'medium shot', zhBody: '腰部以上入鏡', enBody: 'framed from the waist up' },
  近景: { en: 'medium close-up', zhBody: '胸部以上入鏡', enBody: 'framed from the chest up' },
  特寫: { en: 'close-up', zhBody: '肩部以上入鏡', enBody: 'framed from the shoulders up' },
  大特寫: { en: 'extreme close-up' },
};
const SIZE_ALIAS = { 中近景: '近景', 中特寫: '近景', 中遠景: '中全景' };
// 舊寫法把鏡頭類型寫在 size 裡；照樣能跑，腳本會拆回兩個欄位並提示
const LEGACY_SIZE = {
  過肩: { type: '過肩' }, 主觀: { type: '主觀' }, 背影: { type: '背後' },
  空鏡: { type: '空鏡' }, 物件特寫: { size: '特寫', type: '插入' },
};
// 鏡頭類型（type）：誰入鏡、從哪個關係拍。單人是預設，不會寫進提示詞
const TYPES = {
  單人: { zh: '', en: '' },
  雙人: { zh: '雙人鏡頭', en: 'two-shot' },
  群像: { zh: '多人群像', en: 'group shot' },
  過肩: { zh: '過肩鏡頭', en: 'over-the-shoulder shot' },
  主觀: { zh: '第一人稱主觀視角', en: 'first-person POV shot' },
  背後: { zh: '從人物背後拍攝', en: 'shot from behind' },
  空鏡: { zh: '純場景空鏡', en: 'scenery only, unoccupied' },
  插入: { zh: '細節鏡頭', en: 'detail shot' },
};
// 角度（angle）：鏡頭的高低與傾斜
const ANGLES = {
  平視: { zh: '平視角度', en: 'eye-level shot' },
  微俯: { zh: '略為俯視', en: 'slightly high angle' },
  俯拍: { zh: '俯拍角度', en: 'high-angle shot' },
  頂拍: { zh: '從正上方垂直俯視', en: 'top-down overhead shot' },
  微仰: { zh: '略為仰視', en: 'slightly low angle' },
  仰拍: { zh: '仰拍角度', en: 'low-angle shot' },
  傾斜: { zh: '畫面水平線傾斜', en: 'Dutch angle' },
};
// 運鏡（camera）：前面可加「緩慢」「輕微」。帶方向的動作一定要寫方向，否則生成工具只能猜
const MOVES = {
  固定: { zh: '固定', en: 'static camera' },
  推近: { zh: '推近', en: 'push-in' },
  拉遠: { zh: '拉遠', en: 'pull-out' },
  左搖: { zh: '向左搖', en: 'pan left' },
  右搖: { zh: '向右搖', en: 'pan right' },
  上搖: { zh: '向上搖', en: 'tilt up' },
  下搖: { zh: '向下搖', en: 'tilt down' },
  左移: { zh: '向左平移', en: 'truck left' },
  右移: { zh: '向右平移', en: 'truck right' },
  上升: { zh: '垂直上升', en: 'pedestal up' },
  下降: { zh: '垂直下降', en: 'pedestal down' },
  跟拍: { zh: '跟拍主體', en: 'follow shot' },
  左環繞: { zh: '向左環繞主體', en: 'arc shot to the left' },
  右環繞: { zh: '向右環繞主體', en: 'arc shot to the right' },
  變焦推近: { zh: '變焦推近', en: 'zoom in' },
  變焦拉遠: { zh: '變焦拉遠', en: 'zoom out' },
  手持: { zh: '手持晃動', en: 'handheld sway' },
  移焦到後景: { zh: '焦點從前景移到後景', en: 'rack focus from the foreground to the background' },
  移焦到前景: { zh: '焦點從後景移到前景', en: 'rack focus from the background to the foreground' },
  左甩: { zh: '向左甩鏡', en: 'whip pan left' },
  右甩: { zh: '向右甩鏡', en: 'whip pan right' },
  滑動變焦: { zh: '滑動變焦，主體大小不變、背景前後拉伸', en: 'dolly zoom' },
  搖臂上升: { zh: '搖臂上升', en: 'crane up' },
  搖臂下降: { zh: '搖臂下降', en: 'crane down' },
  航拍前進: { zh: '航拍鏡頭向前飛行', en: 'aerial drone shot flying forward' },
  航拍上升: { zh: '航拍鏡頭垂直上升', en: 'aerial drone shot rising straight up' },
};
const MOVE_VAGUE = {
  橫移: { zh: '橫移', en: 'lateral move', fix: '「左移」或「右移」' },
  平移: { zh: '平移', en: 'lateral move', fix: '「左移」或「右移」' },
  搖: { zh: '搖鏡', en: 'pan', fix: '「左搖」「右搖」「上搖」或「下搖」' },
  升降: { zh: '升降', en: 'pedestal move', fix: '「上升」或「下降」' },
  環繞: { zh: '環繞主體', en: 'arc shot', fix: '「左環繞」或「右環繞」' },
  移焦: { zh: '移焦', en: 'rack focus', fix: '「移焦到後景」「移焦到前景」，或寫成片段說清楚從什麼移到什麼' },
  甩鏡: { zh: '甩鏡', en: 'whip pan', fix: '「左甩」或「右甩」' },
  搖臂: { zh: '搖臂', en: 'crane shot', fix: '「搖臂上升」或「搖臂下降」' },
  航拍: { zh: '航拍', en: 'aerial drone shot', fix: '「航拍前進」或「航拍上升」' },
};
const MOVE_PREFIX = { 緩慢: 'slow', 輕微: 'gentle' };
// 生成工具做不穩的運鏡：這一鏡沒寫 risk 時提示
const WHIP = '甩鏡很快，生成工具常糊成一片或停不下來；多半改成前後兩鏡各自固定、這一鏡的 transition 填「甩鏡」，剪接時加動態模糊接起來。保留就在 risk 寫備案';
const ARC = '環繞要整個背景跟著轉，人物和背景都容易變形；人物保持幾乎不動，在 risk 寫備案（例如改成緩慢推近），並多抽幾次';
const RISKY_MOVES = {
  左甩: WHIP, 右甩: WHIP, 左環繞: ARC, 右環繞: ARC,
  滑動變焦: '滑動變焦要同時移動攝影機與變焦，多數工具做不穩；在 risk 寫備案（例如改成緩慢推近），並多抽幾次',
};
// 機位高度（height）：攝影機離地多高。和角度（俯仰）是兩回事：低機位也可以平視，例如貼著桌面看過去
const HEIGHTS = {
  地面: { zh: '機位貼近地面', en: 'ground-level camera' },
  低機位: { zh: '低機位，約腰部高度', en: 'low camera height, at waist level' },
  眼睛高度: { zh: '機位與眼睛同高', en: 'camera at eye height' },
  高機位: { zh: '高機位，高過頭頂', en: 'high camera position, above head height' },
};
// 速度（speed）：前三種寫進影片提示詞；變速與定格是剪接時做的，只寫進後製備註
const SPEEDS = {
  升格: { zh: '慢動作', en: 'slow motion' },
  降格: { zh: '快動作', en: 'fast motion' },
  縮時: { zh: '縮時攝影', en: 'time-lapse' },
  變速: { post: '變速：照正常速度生成，剪接時在動作的關鍵處放慢再恢復' },
  定格: { post: '定格：最後一幀停住，停的時間算在成片秒數裡' },
};
// 生成方式（render）：靜幀只出首幀圖、不跑影片；靜幀運鏡是剪接時在那張圖上推拉或搖移
const RENDERS = ['影片', '靜幀運鏡', '靜幀'];
const STILL_MOVES = new Set(['固定', '推近', '拉遠', '左搖', '右搖', '上搖', '下搖', '左移', '右移', '變焦推近', '變焦拉遠', '手持']);
const SIZE_RANK = Object.fromEntries(Object.keys(SIZES).map((k, i) => [k, i])); // 越大越近
const WIDE = new Set(['大遠景', '遠景', '全景']);
const CLOSE = new Set(['近景', '特寫', '大特寫']);
const UPPER_BODY = new Set(['中景', ...CLOSE]); // 腰部以上：看不到下半身的服裝
// 台詞類型：VO、OS 是舊檔的寫法，照收
const LINE_TYPES = ['對白', '畫外音', '旁白', '內心獨白', 'VO', 'OS'];
const CJK = /[㐀-鿿぀-ヿ]/;
const CJK_G = /[㐀-鿿぀-ヿ]/g;

// 道具與特效：片段裡寫 {P01}、{F01}，會換成設定檔裡的描述；{F01:上弦} 換成那個狀態的描述
const propDefs = new Map();
const fxDefs = new Map();
const PROP_RE = /\{([PF][0-9A-Za-z_-]*)(?:[:：]([^{}]+?))?\}/g;
for (const p of bible.props || []) {
  if (!p.id) { err('props', '有道具缺少 id'); continue; }
  if (propDefs.has(p.id)) err(p.id, '道具編號重複');
  propDefs.set(p.id, p);
}
const MAKES = ['生成', '後製', '生成加後製'];
const isPost = (d) => (d.make || '生成') === '後製';
for (const f of Array.isArray(bible.effects) ? bible.effects : []) {
  if (!f.id) { err('effects', '有特效缺少 id'); continue; }
  if (!/^F/.test(f.id)) warn(f.id, '特效編號請用 F 開頭（F01、F02…），片段裡才能用 {F01} 引用');
  if (fxDefs.has(f.id)) err(f.id, '特效編號重複');
  fxDefs.set(f.id, f);
}
const defOf = (id) => (id[0] === 'F' ? fxDefs.get(id) : propDefs.get(id));
const hasState = (d, st) => !!d && !!d.states && typeof d.states === 'object' && d.states[st] != null;

function rawPick(v, l) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v[l] ?? v.zh ?? v.en ?? '').trim();
  return String(v);
}
/**
 * 取出某個語言的文字，並把 {P01}、{F01}、{F01:狀態} 換成描述。欄位可以是字串，或 {"zh": "…", "en": "…"}。
 * tok 是參考圖模式的指稱表（道具編號 → 「圖3」）：有的話在描述後面註明參照哪一張圖。
 */
function pick(v, l, tok = null) {
  return rawPick(v, l).replace(PROP_RE, (m, id, st) => {
    const d = defOf(id);
    if (!d) return m;
    const desc = !st ? rawPick(d.desc, l) : hasState(d, st.trim()) ? rawPick(d.states[st.trim()], l) : null;
    if (desc == null) return m;
    return tok && tok.has(id) ? desc + T[l].refTag(tok.get(id)) : desc;
  });
}
/** 特效或道具在某個狀態下的描述；沒指定狀態就是 desc。 */
const looksOf = (d, st, l) => (st && hasState(d, st) ? pick(d.states[st], l) : pick(d.desc, l));
const strip = (s) => String(s || '').trim().replace(/[，,。.；;、\s]+$/u, '');
const joinC = (parts, l) => parts.map(strip).filter(Boolean).join(T[l].sep);
const joinS = (parts, l) => {
  let s = parts.map(strip).filter(Boolean);
  if (l === 'en') s = s.map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  return s.length ? s.join(T[l].stop) + T[l].stop.trim() : '';
};
/** 表格顯示用：多語言時兩種都列出。 */
const show = (v) => [...new Set(langs.map((l) => pick(v, l)).filter(Boolean))].join('<br>');
const zhOf = (v) => pick(v, 'zh');

/** 把一鏡的景別、鏡頭類型、角度整理成標準用詞；舊寫法（類型寫在 size 裡）在這裡拆開。 */
function spec(shot) {
  let size = zhOf(shot.size);
  let type = zhOf(shot.type);
  let legacy = false;
  if (LEGACY_SIZE[size]) {
    type = type || LEGACY_SIZE[size].type;
    size = LEGACY_SIZE[size].size || '';
    legacy = true;
  }
  size = SIZE_ALIAS[size] || size;
  return { size, type: type || '單人', angle: zhOf(shot.angle), height: zhOf(shot.height), legacy };
}
const speedOf = (s) => (s.speed ? SPEEDS[zhOf(s.speed)] || null : null);
const speedTerm = (s, l) => speedOf(s)?.[l] || '';
const renderOf = (s) => (RENDERS.includes(s.render) ? s.render : '影片');
const isStill = (s) => renderOf(s) !== '影片';
/** 有沒有完整入鏡的人物（不是背影、前景虛焦或只露一部分）。 */
const hasFullCast = (shot) => (shot.cast || []).some((e) => !e.partial);
/** 有完整入鏡、而且是人的身體（人或半人）的角色。 */
const hasBodyCast = (shot) => (shot.cast || []).some((e) => !e.partial && ['人', '半人'].includes(kindOf(chars.get(e.char)?.c || {})));
/** 景別＋取景範圍＋鏡頭類型＋角度＋構圖，組成提示詞裡的「怎麼拍」那一段。 */
function framing(shot, l, withFrame = true) {
  const sp = spec(shot);
  const parts = [];
  const def = SIZES[sp.size];
  if (def) {
    parts.push(l === 'en' ? def.en : sp.size);
    // 「腰部以上入鏡」這類範圍是照人的身體說的：畫面裡只有器物、動物或異獸時不寫
    if (hasBodyCast(shot) && sp.type !== '插入' && def[`${l}Body`]) parts.push(def[`${l}Body`]);
  } else if (sp.size) parts.push(pick(shot.size, l)); // 用詞表以外的寫法原樣放
  if (TYPES[sp.type]) parts.push(TYPES[sp.type][l]);
  else parts.push(pick(shot.type, l));
  if (sp.angle) parts.push(ANGLES[sp.angle] ? ANGLES[sp.angle][l] : pick(shot.angle, l));
  if (sp.height) parts.push(HEIGHTS[sp.height] ? HEIGHTS[sp.height][l] : pick(shot.height, l));
  if (withFrame) parts.push(pick(shot.frame, l));
  return joinC(parts, l);
}
/** 表格顯示用：「過肩・近景（低機位・微俯）」。 */
function sizeLabel(shot, withAngle = false) {
  const sp = spec(shot);
  const s = [sp.type !== '單人' ? sp.type : '', sp.size].filter(Boolean).join('・') || zhOf(shot.size);
  const extra = [sp.height && sp.height !== '眼睛高度' ? sp.height : '', sp.angle && sp.angle !== '平視' ? sp.angle : ''].filter(Boolean).join('・');
  return withAngle && extra ? `${s}（${extra}）` : s;
}
/** 拆開運鏡：前綴（緩慢、輕微）＋動作。寫成 {"zh","en"} 或用詞表以外的字串時當成自訂片段。 */
function parseCam(shot) {
  const raw = zhOf(shot.camera);
  if (shot.camera && typeof shot.camera === 'object') return { raw, custom: true, pre: [] };
  let base = raw;
  const pre = [];
  for (;;) {
    const k = Object.keys(MOVE_PREFIX).find((p) => base.startsWith(p) && base.length > p.length);
    if (!k) break;
    pre.push(k);
    base = base.slice(k.length);
  }
  const def = MOVES[base] || MOVE_VAGUE[base];
  return { raw, pre, base, def, vague: !MOVES[base] && !!MOVE_VAGUE[base], custom: !def };
}
const isStatic = (shot) => !zhOf(shot.camera) || parseCam(shot).base === '固定';

const REF_RE = /同上|同前|如前|same as above|as before|as above/i;
const TEXT_RE = /寫著|寫有|字樣|上面的字|that (says|reads)|text reading|with the words/i;
const SCREEN_RE = /畫面(的)?[左右]|鏡頭(的)?[左右]|螢幕[左右]|screen[- ](left|right)|frame[- ](left|right)|(left|right) of (the )?(frame|screen)/i;
const FAST_RE = /快速|迅速|急速|猛烈|劇烈|猛地|猛然|瞬間|飛快|狂奔|飛撲|暴衝|大幅|爆發|炸開|爆炸|噴發|\b(rapid(ly)?|violent(ly)?|sudden(ly)?|quick(ly)?|fast|dramatic(ally)?|bursts?|lunges?|dash(es)?|sprints?|slams?|whips?|explod(e|es|ing)|explosions?|erupts?)\b/i;
// 看起來是文字或數字的特效：工具寫不好，應該後製
const FX_TEXT_RE = /數字|文字|字樣|[大小]字|篆|進度條|\b(digits?|numbers?|text|letters?|words?)\b/i;
const SLOW_RE = /緩慢|慢慢|緩緩|慢速|\bslow(ly)?\b/i;
// 冷暖與主色：寫在風格鎖定句裡會加到每一張圖，夜戲、回憶、換了光線的鏡頭就會和光線打架
const HUE_RE = /[暖冷](色|調|光|[黃橘紅棕藍白灰青])|偏[青藍橘黃紅綠紫金暖冷]|[紅橙橘黃綠青藍紫金棕褐]色?[調系]|為主的.{0,4}色調|\b(warm|cool|cold)(er)?\b|\b(teal|amber|orange|golden|blue|red|green|purple|pink|yellow)(-\w+)?\b[^,]{0,25}\b(tones?|palette|tints?|cast|shadows?|grading|accents?)\b/i;
// 人與人身上的東西：寫進場景或機位的描述，會跑進沒有人物的場景定稿圖與機位背景圖
const PERSON_RE = /臉|人物|人影|他的|她的|頭髮|肩膀|眼睛|身上|身後|身前|女子|男子|女人|男人|老人|少女|少年|孩子|\b(face|faces|his|her|hair|shoulders?|eyes|figure|person|people|man|woman|girl|boy)\b/i;
// 手不在畫面裡的寫法：這種鏡頭不用驗收手指
const NO_HANDS_RE = /不在畫面|看不到|看不見|畫面外|out of (the )?frame|not visible|below the frame|out of shot/i;

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
    if (unknown) err(where, `用了設定檔裡沒有的道具或特效編號，或沒有登記的狀態：${[...new Set(unknown)].join('、')}`);
    for (const m of rawPick(v, l).matchAll(PROP_RE)) {
      const d = m[1][0] === 'F' ? fxDefs.get(m[1]) : null;
      if (d && isPost(d)) warn(where, `${m[1]}（${d.name || '特效'}）是後製做的特效，不要寫進提示詞；在畫面上替它留位置，並寫在 continuity`);
    }
    if (REF_RE.test(s)) warn(where, '用了「同上／如前」之類的指代；每一鏡都要能單獨看懂，請直接寫出內容');
    if (TEXT_RE.test(s)) warn(where, '看起來要求畫面出現可讀文字；多數生成工具寫不好字，請改成後製加字');
  }
}

/** 片段裡有沒有寫到人：人稱、身體部位，或任何角色的短稱。回傳碰到的字，沒有就回傳空字串。 */
function mentionsPerson(v) {
  for (const l of langs) {
    const s = pick(v, l);
    if (!s) continue;
    const m = PERSON_RE.exec(s);
    if (m) return m[0];
    for (const { c, vs } of charList) {
      for (const t of [pick(c.tag, l), ...vs.map((x) => pick(x.tag, l))]) if (t && s.toLowerCase().includes(t.toLowerCase())) return t;
    }
  }
  return '';
}

/** 道具描述會被代入句子中間（「右手握著{P01}」），要是短的名詞短語，不能有逗號。 */
function checkPropPhrase(where, v, isState) {
  for (const l of langs) {
    const s = pick(v, l);
    if (!s) continue;
    if (/[，,；;]/.test(s)) (isState ? hint : warn)(where, `道具描述（${l}）有逗號；它會被代入句子中間（「右手握著{P01}」），逗號會把句子切斷。改寫成一個名詞短語，例如「一個封口翻起的白色信封」`);
    const n = l === 'zh' ? [...s.replace(/[\s、，,。；;：:「」]/g, '')].length : (s.match(/\S+/g) || []).length;
    const max = l === 'zh' ? 15 : 10;
    if (n > max) hint(where, `道具描述（${l}）有 ${n} ${l === 'zh' ? '字' : '個詞'}，超過 ${max}；代入句子後容易斷句或讀不通（「a lantern with paper panels and a top handle glowing」）。留下兩三個最能辨認的特徵`);
    // 英文的 with 片語在句尾：代入後後面再接位置或動作，就會黏到 with 後面那個名詞上
    if (l === 'en' && /\bwith\b/i.test(s)) hint(where, `道具描述（en）用了 with 片語；代入句子後，後面接的位置或動作會黏到錯的名詞上（「a sword with a round guard by the hilt」讀起來是護手在劍柄旁）。把特徵改成放在名詞前面的形容詞（「a battered square biscuit tin」「a plain-guarded steel sword」）`);
  }
}

// ---------- 建立索引並檢查設定檔 ----------
if (!P.style_lock) err('project.style_lock', '缺少風格鎖定句');
checkFrag('project.style_lock', P.style_lock);
if (langs.some((l) => HUE_RE.test(pick(P.style_lock, l)))) {
  warn('project.style_lock', '風格鎖定句寫了冷暖或主色（例如「暖色調」「偏青藍」「blue-grey shadows」）。它會加到每一張圖，夜戲、回憶和換了光線的鏡頭都會和自己的光線打架。冷暖與主色移到場景的 palette，風格鎖定句只留畫風、線條、上色方式、飽和度與對比、質感');
}
checkFrag('project.ref_syntax', P.ref_syntax);
checkFrag('project.negative_global', P.negative_global);
checkFrag('project.speech_lang', P.speech_lang);
checkFrag('project.audio_suffix', P.audio_suffix);
checkFrag('project.video_suffix', P.video_suffix);
for (const p of propDefs.values()) {
  checkFrag(`${p.id}.desc`, p.desc, true);
  checkPropPhrase(`${p.id}.desc`, p.desc, false);
  for (const [k, sv] of Object.entries(p.states && typeof p.states === 'object' ? p.states : {})) {
    checkFrag(`${p.id}.states.${k}`, sv, true);
    checkPropPhrase(`${p.id}.states.${k}`, sv, true);
  }
}
for (const f of fxDefs.values()) {
  checkFrag(`${f.id}.desc`, f.desc, true);
  checkFrag(`${f.id}.motion`, f.motion);
  checkFrag(`${f.id}.light`, f.light);
  for (const [k, sv] of Object.entries(f.states && typeof f.states === 'object' ? f.states : {})) checkFrag(`${f.id}.states.${k}`, sv, true);
  const stNames = Object.keys(f.states && typeof f.states === 'object' ? f.states : {});
  for (const key of ['light', 'motion']) {
    const bySt = f[`${key}_states`];
    if (bySt == null) continue;
    if (typeof bySt !== 'object' || Array.isArray(bySt)) { err(f.id, `${key}_states 要寫成 {"狀態名稱": "描述"}`); continue; }
    for (const [k, sv] of Object.entries(bySt)) {
      if (!stNames.includes(k)) err(f.id, `${key}_states 的「${k}」不在 states 裡（有：${stNames.join('、') || '沒有分狀態'}）`);
      if (sv !== '') checkFrag(`${f.id}.${key}_states.${k}`, sv);
    }
  }
  // 有分狀態的發光特效：每個階段的亮度不一樣（淡痕不會照亮周圍），一段 light 套在所有狀態上，暗的那幾鏡也會被寫成在發光
  if (f.light && stNames.length > 1 && f.light_states == null && !isPost(f)) {
    hint(f.id, `有 ${stNames.length} 個狀態（${stNames.join('、')}），light 卻只有一段，每個狀態都會被寫成照亮周圍；不發光或比較暗的狀態在 light_states 另外寫（不發光寫空字串）`);
  }
  if (f.make && !MAKES.includes(f.make)) hint(f.id, `make 請填 ${MAKES.join('、')} 其中一個；目前當成「生成」`);
  if (langs.some((l) => FAST_RE.test(pick(f.motion, l)))) {
    warn(`${f.id}.motion`, '特效的動態用了「爆發／炸開／瞬間」這類字眼，生成工具容易做壞；寫成慢慢擴散、漂浮、明暗起伏，快速的爆發留給後製，或用閃白和反應鏡頭代替');
  }
  const texts = [f.desc, ...Object.values(f.states || {})];
  if (!isPost(f) && langs.some((l) => texts.some((t) => FX_TEXT_RE.test(pick(t, l))))) {
    warn(f.id, '這個特效看起來包含數字或文字，生成工具寫不好；make 改成「後製」，或把文字的部分拆成另一個後製特效');
  }
}

// 角色類型：非人角色不一定穿衣服，也不一定有人的表情
const KINDS = ['人', '半人', '動物', '器物', '異獸'];
const NONHUMAN = new Set(['動物', '器物', '異獸']);
const kindOf = (c) => (KINDS.includes(c.kind) ? c.kind : '人');
// 形態（造型變體）可以有自己的 look 與 tag：人形與原形長得完全不一樣
const lookOf = (c, v, l) => pick(v?.look, l) || pick(c.look, l);
const tagOf = (c, v, l) => pick(v?.tag, l) || pick(c.tag, l);

const chars = new Map(); // 角色編號或造型變體編號 -> { c, v }
const charList = [];
for (const c of bible.characters || []) {
  if (!c.id) { err('characters', '有角色缺少 id'); continue; }
  if (chars.has(c.id)) err(c.id, '角色編號重複');
  if (c.kind != null && !KINDS.includes(c.kind)) hint(c.id, `kind「${c.kind}」不在分類裡（${KINDS.join('、')}），當成「人」處理`);
  const kind = kindOf(c);
  const vs = Array.isArray(c.variants) && c.variants.length
    ? c.variants
    : [{ id: c.id, label: '', outfit: c.outfit || '', state: '' }];
  charList.push({ c, vs });
  chars.set(c.id, { c, v: vs[0] });
  for (const v of vs) {
    if (!v.id) { err(c.id, '有造型變體缺少 id'); continue; }
    if (v.id !== c.id && chars.has(v.id)) err(v.id, '造型變體編號重複');
    chars.set(v.id, { c, v });
    // 人與半人一定要寫服裝；動物、器物、異獸，或有自己 look 的形態，可以沒有
    checkFrag(`${v.id}.outfit`, v.outfit, !v.look && !NONHUMAN.has(kind));
    checkFrag(`${v.id}.outfit_top`, v.outfit_top);
    checkFrag(`${v.id}.state`, v.state);
    checkFrag(`${v.id}.sheet`, v.sheet);
    checkFrag(`${v.id}.look`, v.look);
    checkFrag(`${v.id}.tag`, v.tag);
    if (v.look && !v.tag) warn(v.id, '這個形態有自己的 look，卻沒有自己的 tag；影片提示詞會用第一個形態的短稱指它，指到的樣子不對');
  }
  checkFrag(`${c.id}.look`, c.look, true);
  checkFrag(`${c.id}.marks`, c.marks);
  checkFrag(`${c.id}.expressions`, c.expressions);
  if (!c.tag) warn(`${c.id}.tag`, '缺少短稱（tag）；影片提示詞要用它來指這個角色');
  else checkFrag(`${c.id}.tag`, c.tag);
  if (NONHUMAN.has(kind) && !c.minor && !c.expressions) {
    hint(c.id, `${kind}角色沒有寫 expressions，預設的「平靜、微笑、難過、生氣」不適用，所以不產出表情組圖；寫成這個角色會用到的狀態（耳朵往後貼、尾巴膨起、燈光變亮），或設 minor`);
  }
}
// 不同角色用了同一個短稱：影片提示詞與參考圖模式都靠短稱分辨人，兩個人會被當成同一個
for (const l of langs) {
  const byTag = new Map();
  for (const { c, vs } of charList) {
    for (const t of new Set([tagOf(c, null, l), ...vs.map((v) => tagOf(c, v, l))].filter(Boolean))) {
      if (!byTag.has(t)) byTag.set(t, new Set());
      byTag.get(t).add(c.id);
    }
  }
  for (const [t, ids] of byTag) {
    if (ids.size > 1) warn([...ids].join('、'), `短稱（${l}）都是「${t}」；提示詞靠短稱分辨人，兩個角色會被當成同一個。給每個人一個看得出差別的短稱（「左臉有疤的黑衣人」「矮壯的黑衣人」）`);
  }
}

const scenes = new Map();
for (const s of bible.scenes || []) {
  if (!s.id) { err('scenes', '有場景缺少 id'); continue; }
  if (scenes.has(s.id)) err(s.id, '場景編號重複');
  scenes.set(s.id, s);
  checkFrag(`${s.id}.space`, s.space, true);
  checkFrag(`${s.id}.light`, s.light, true);
  checkFrag(`${s.id}.time`, s.time);
  checkFrag(`${s.id}.palette`, s.palette);
  for (const k of ['space', 'light']) {
    const hit = mentionsPerson(s[k]);
    if (hit) warn(`${s.id}.${k}`, `場景的 ${k} 寫到了人（「${hit}」）；它會進到沒有人物的場景定稿圖，也會進每一鏡。人身上的光寫在各鏡的 light，人在哪裡寫在 pos`);
  }
  if (langs.some((l) => SCREEN_RE.test(pick(s.space, l)))) {
    warn(`${s.id}.space`, '場景描述用了「畫面左／右」；換個角度拍就會錯，請改寫成空間關係（例如「窗在沙發對面」），畫面位置留給每一鏡的 pos');
  }
}

// 機位（分鏡檔的 setups）：同一場戲裡反覆使用的拍攝位置。背景寫一次，同機位的鏡頭共用
const setups = new Map();
for (const u of (ep && Array.isArray(ep.setups) ? ep.setups : [])) {
  if (!u.id) { err('setups', '有機位缺少 id'); continue; }
  if (setups.has(u.id)) err(u.id, '機位編號重複');
  setups.set(u.id, u);
  if (!scenes.has(u.scene)) err(u.id, `機位的場景編號 ${u.scene ?? '（空）'} 不在設定檔裡`);
  if (!u.desc) warn(u.id, '機位缺少 desc（鏡頭在哪裡、朝哪裡拍、拍到誰的正面）；沒有它就看不出軸線有沒有守住');
  checkFrag(`${u.id}.bg`, u.bg, true);
  checkFrag(`${u.id}.light`, u.light);
  for (const k of ['bg', 'light']) {
    const hit = mentionsPerson(u[k]);
    if (hit) warn(`${u.id}.${k}`, `機位的 ${k} 寫到了人（「${hit}」）；它會進到沒有人物的機位背景圖。機位只寫從這個位置看到的空間與光，人身上的光寫在各鏡的 light`);
  }
}

// ---------- 提示詞組合 ----------
const isPartialText = (e) => e.partial && e.partial !== true;
/**
 * 一個入鏡角色：外貌與造型 ＋ 走位。
 * 參考圖模式（tok 有這個造型的設定圖）：外貌改成「圖1中的＋短稱」，長相交給參考圖，文字不再重複，免得兩邊互相拉扯。
 */
function subject(entry, shot, l, withBlocking = true, tok = null) {
  const hit = chars.get(entry.char);
  if (!hit) return '';
  const { c, v } = hit;
  // 中景以內（腰部以上）看不到下半身：有填 outfit_top 就用它，免得提示詞裡的褲子鞋子把鏡頭拉遠
  const outfit = UPPER_BODY.has(spec(shot).size) && pick(v.outfit_top, l) ? pick(v.outfit_top, l) : pick(v.outfit, l);
  const t = tok && tok.get(v.id);
  let base;
  // 只入鏡一部分：直接寫看得到的那一部分。參考圖只借顏色與質感，免得工具照整張設定圖畫出整個人
  if (isPartialText(entry)) base = [strip(pick(entry.partial, l, tok)) + (t ? T[l].refPart(t) : '')];
  else if (t) base = [T[l].refWho(t, tagOf(c, v, l) || lookOf(c, v, l))];
  else if (entry.partial === true) base = [tagOf(c, v, l), outfit]; // 背影、前景虛焦：不寫臉部細節與狀態
  else base = [lookOf(c, v, l), outfit, pick(v.state, l), pick(c.marks, l)];
  const block = withBlocking ? [pick(entry.pos, l, tok), pick(entry.gaze, l, tok), pick(entry.hands, l, tok), pick(entry.face, l, tok)] : [];
  return joinC([...base, ...block], l);
}
const setupOf = (shot) => (shot.setup ? setups.get(shot.setup) : null) || {};
/** 光線：這一鏡的 light → 機位的 light → 場景的光線與時間。 */
const lightOf = (shot, sc, l) => pick(shot.light, l) || pick(setupOf(shot).light, l) || joinC([pick(sc.light, l), pick(sc.time, l)], l);
/** 色彩：這一鏡的 palette → 場景的 palette。冷暖與主色放這裡，不放風格鎖定句。 */
const paletteOf = (shot, sc, l) => pick(shot.palette, l) || pick(sc.palette, l);
/** 背景：這一鏡的 bg → 機位的 bg → 整段場景描述（只適合全景以上）。參考圖模式下註明參照哪一張背景圖。 */
function bgOf(shot, sc, l, tok = null) {
  const b = pick(shot.bg, l, tok) || pick(setupOf(shot).bg, l, tok) || pick(sc.space, l, tok);
  return tok && tok.has('bg') ? T[l].refBg(tok.get('bg'), strip(b)) : b;
}
// 這一鏡的特效（shot.fx）：後製的特效不進提示詞，只列在備註裡
const fxIn = (shot) => (Array.isArray(shot.fx) ? shot.fx : []).map((e) => ({ e, d: fxDefs.get(e?.id) })).filter((x) => x.d);
const fxGen = (shot) => fxIn(shot).filter((x) => !isPost(x.d));
/** 特效的樣子：外觀（或那個狀態的外觀）＋ 在畫面哪裡。 */
const fxLooks = (shot, l, tok = null) => fxGen(shot).map(({ e, d }) => joinC([
  strip(looksOf(d, e.state, l)) + (tok && tok.has(d.id) ? T[l].refTag(tok.get(d.id)) : ''),
  pick(e.pos, l, tok),
], l));
/**
 * 特效在某個狀態下的某個欄位（light 或 motion）：這一鏡的 fx[] 覆寫 → 設定檔的 <欄位>_states[狀態] → 設定檔的欄位。
 * 這一鏡寫 false、或 <欄位>_states 裡那個狀態寫空字串，表示這個狀態不發光／不動（印記還是淡痕時不會照亮周圍）。
 */
function fxField(e, d, key, l) {
  if (e[key] === false) return '';
  if (e[key]) return pick(e[key], l);
  const byState = d[`${key}_states`];
  if (e.state && byState && typeof byState === 'object' && Object.prototype.hasOwnProperty.call(byState, e.state)) return pick(byState[e.state], l);
  return pick(d[key], l);
}
/** 會發光的特效照亮周圍：接在這一鏡的光線後面。 */
const fxLights = (shot, l) => fxGen(shot).map(({ e, d }) => fxField(e, d, 'light', l));
/** 特效怎麼動：接在這一鏡的 motion 後面。 */
const fxMotions = (shot, l) => fxGen(shot).map(({ e, d }) => fxField(e, d, 'motion', l));

/**
 * 這一鏡要掛哪些參考圖、依什麼順序：角色的造型設定圖 → 背景（機位背景圖，沒有機位就用場景定稿圖）→ 道具圖 → 特效參考圖 → refs 裡額外寫的。
 * key 是提示詞裡要代換的東西（造型編號、'bg'、道具或特效編號），label 是資產名稱。
 */
function refPlan(s) {
  const out = [];
  const seen = new Set();
  const add = (key, label) => { if (!seen.has(label)) { seen.add(label); out.push({ key, label }); } };
  for (const e of s.cast || []) { const h = chars.get(e.char); if (h) add(h.v.id, `${h.v.id} 設定圖`); }
  if (s.setup && setups.has(s.setup)) add('bg', `${s.setup} 機位背景圖`);
  else if (scenes.has(s.scene)) add('bg', `${s.scene} 場景定稿圖`);
  const frags = [s.props, s.bg, s.frame, ...(s.cast || []).flatMap((e) => [e.pos, e.gaze, e.hands, e.face, isPartialText(e) ? e.partial : null])];
  for (const f of frags) {
    for (const m of rawPick(f, langs[0]).matchAll(PROP_RE)) if (m[1][0] === 'P' && propDefs.has(m[1])) add(m[1], `${m[1]} 道具圖`);
  }
  for (const { e, d } of fxGen(s)) add(d.id, `${d.id} 特效參考圖${e.state ? `・${e.state}` : ''}`);
  for (const r of userRefs(s)) add(null, r);
  return out;
}
/** refs 裡使用者自己寫的圖。有機位時，場景定稿圖由機位背景圖取代，不重複掛。 */
function userRefs(s) {
  const plate = s.setup && setups.has(s.setup);
  return (Array.isArray(s.refs) ? s.refs : []).map(String).filter((r) => !(plate && r === `${s.scene} 場景定稿圖`));
}
/** 第 n 張參考圖在提示詞裡怎麼稱呼：照 ref_syntax（例如 "@图片{n}"），沒填就是「圖1」「image 1」。 */
function refToken(n, l) {
  const pat = pick(P.ref_syntax, l) || T[l].refDefault;
  return pat.includes('{n}') ? pat.replace(/\{n\}/g, String(n)) : `${pat}${n}`;
}
/** 參考圖模式的指稱表：key → 「圖2」。文字模式回傳 null，提示詞照舊把外貌寫完整。 */
function refTokens(s, l) {
  if (!REF_MODE) return null;
  const tok = new Map();
  refPlan(s).forEach((r, i) => { if (r.key && !tok.has(r.key)) tok.set(r.key, refToken(i + 1, l)); });
  return tok;
}
/**
 * 給人看的參考圖清單。兩種模式都由腳本列出角色設定圖、背景圖、道具圖、特效參考圖，refs 只寫額外的；
 * 參考圖模式要照這個順序上傳，文字模式是一份不要漏掛的清單。
 */
function refLabels(s) {
  if (!REF_MODE && s.link === '接續') return (Array.isArray(s.refs) ? s.refs : []).map(String); // 首幀沿用上一鏡，不另外生成
  return refPlan(s).map((r) => r.label);
}

function imagePrompt(shot, l) {
  const sc = scenes.get(shot.scene) || {};
  const tok = refTokens(shot, l);
  const subs = (shot.cast || []).map((e) => subject(e, shot, l, true, tok));
  return joinS([
    ...subs,
    pick(shot.props, l, tok),
    ...fxLooks(shot, l, tok),
    bgOf(shot, sc, l, tok),
    joinC([lightOf(shot, sc, l), ...fxLights(shot, l), paletteOf(shot, sc, l)], l),
    framing(shot, l),
    pick(P.style_lock, l),
  ], l);
}
function camTerm(shot, l) {
  const c = parseCam(shot);
  if (c.custom) return pick(shot.camera, l);
  if (l === 'en') return [...c.pre.map((p) => MOVE_PREFIX[p]), c.def.en].join(' ');
  return c.pre.join('') + c.def.zh;
}
function lastFramePrompt(shot, l) {
  const end = strip(pick(shot.end, l));
  if (!end || isStill(shot)) return '';
  return T[l].lastFrame(end, isStatic(shot) ? '' : camTerm(shot, l)) + T[l].stop.trim();
}
function audioParts(shot, l) {
  if (!NATIVE_AUDIO) return [];
  const out = [];
  const ln = shot.line;
  if (ln && ln.text && ln.type === '對白') {
    const hit = chars.get(ln.who);
    // 說話的人在這一鏡是哪個形態，就用那個形態的短稱
    const inShot = hit && (shot.cast || []).map((e) => chars.get(e.char)).find((h) => h && h.c.id === hit.c.id);
    const who = hit ? tagOf(hit.c, (inShot || hit).v, l) || hit.c.name : ln.who || '';
    out.push(T[l].says(who, strip(pick(ln.text, langs[0])), pick(P.speech_lang, l), strip(pick(ln.tone, l))));
  }
  if (shot.sound) out.push(T[l].sound(pick(shot.sound, l)));
  if (P.audio_suffix) out.push(pick(P.audio_suffix, l));
  return out;
}
/** 靜幀鏡頭不跑影片：剪接時怎麼處理那張首幀圖。 */
function stillNote(shot) {
  const d = Number(shot.duration) || 0;
  if (renderOf(shot) === '靜幀運鏡' && !isStatic(shot)) return `靜幀運鏡：只出首幀圖，剪接時在圖上做${camTerm(shot, 'zh')}，${d} 秒`;
  return `靜幀：只出首幀圖，畫面停 ${d} 秒`;
}
function videoPrompt(shot, l) {
  if (isStill(shot)) return '';
  const cam = joinC([T[l].cam(camTerm(shot, l)), speedTerm(shot, l)], l);
  if (MODE === 'i2v') {
    // 圖生影片：首幀圖已經決定了外貌與場景，這裡只寫「怎麼動」
    return joinS([pick(shot.motion, l), ...fxMotions(shot, l), cam, pick(P.video_suffix, l), ...audioParts(shot, l)], l);
  }
  // 文字生影片：影片工具自己掛參考圖，參考圖模式的指稱寫在這裡
  const sc = scenes.get(shot.scene) || {};
  const tok = refTokens(shot, l);
  const subs = (shot.cast || []).map((e) => subject(e, shot, l, true, tok));
  return joinS([
    ...subs,
    pick(shot.props, l, tok),
    ...fxLooks(shot, l, tok),
    pick(shot.motion, l),
    ...fxMotions(shot, l),
    bgOf(shot, sc, l, tok),
    joinC([lightOf(shot, sc, l), ...fxLights(shot, l), paletteOf(shot, sc, l)], l),
    joinC([framing(shot, l, false), cam], l),
    pick(P.style_lock, l),
    pick(P.video_suffix, l),
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
  const kind = kindOf(c);
  vs.forEach((v, i) => {
    for (const l of langs) {
      if (i > 0 && !pick(v.sheet, l) && !pick(v.look, l)) {
        // 第二個以後的造型：從第一個造型的設定圖改，臉才不會變
        const change = joinC([pick(v.outfit, l), pick(v.state, l)], l);
        assets.push({ id: v.id, kind: `設定圖（由 ${vs[0].id} 改）`, lang: l, prompt: T[l].variantEdit(vs[0].id, change) + T[l].stop.trim() });
      } else {
        // 第一個造型，或有自己 look 的形態（原形和人形長得不一樣，不能從人形改）
        const who = joinC([lookOf(c, v, l), pick(v.outfit, l), pick(v.state, l), pick(c.marks, l)], l);
        const pose = pick(v.sheet, l) || (kind === '異獸' ? T[l].poseScale : T[l].pose);
        assets.push({ id: v.id, kind: '設定圖', lang: l, prompt: joinS([who, T[l].sheet(pose), pick(P.style_lock, l)], l) });
      }
    }
  });
  if (!c.minor && !(NONHUMAN.has(kind) && !c.expressions)) {
    for (const l of langs) {
      const v = vs[0];
      const who = joinC([lookOf(c, v, l), pick(v.outfit_top, l) || pick(v.outfit, l), pick(c.marks, l)], l);
      // 非人角色沒有「半身」，表情也多半是耳朵、尾巴、光這類狀態
      const sheet = NONHUMAN.has(kind) ? T[l].states(pick(c.expressions, l)) : T[l].faces(pick(c.expressions, l) || T[l].expr);
      assets.push({ id: c.id, kind: '表情組圖', lang: l, prompt: joinS([who, sheet, pick(P.style_lock, l)], l) });
    }
  }
}
for (const s of scenes.values()) {
  for (const l of langs) {
    assets.push({
      id: s.id, kind: '場景定稿圖', lang: l,
      prompt: joinS([pick(s.space, l), joinC([pick(s.light, l), pick(s.time, l), pick(s.palette, l)], l), T[l].master, pick(P.style_lock, l)], l),
    });
  }
}
// 機位背景圖：每個機位一張沒有人物的背景。場景定稿圖只有一個角度，反打機位看到的牆不在那張圖裡，
// 第一次用到這個機位的鏡頭就沒有背景可以參照。這些是這一集的資產，寫在分鏡表與 <集數>-assets.csv
const plateAssets = [];
for (const u of setups.values()) {
  const sc = scenes.get(u.scene) || {};
  const used = (ep && Array.isArray(ep.shots) ? ep.shots : []).filter((s) => s.setup === u.id);
  const angles = [...new Set(used.map((s) => spec(s).angle || '平視'))];
  const ang = angles.length === 1 && ANGLES[angles[0]] ? ANGLES[angles[0]] : null; // 這個機位的鏡頭都同一個角度時才寫
  const heights = [...new Set(used.map((s) => spec(s).height))];
  const hgt = heights.length === 1 && HEIGHTS[heights[0]] ? HEIGHTS[heights[0]] : null; // 高度也一樣
  for (const l of langs) {
    const light = pick(u.light, l) || joinC([pick(sc.light, l), pick(sc.time, l)], l);
    plateAssets.push({
      id: u.id, kind: '機位背景圖', lang: l,
      prompt: joinS([pick(u.bg, l), joinC([light, pick(sc.palette, l)], l), joinC([T[l].plate, ang ? ang[l] : '', hgt ? hgt[l] : ''], l), pick(P.style_lock, l)], l),
    });
  }
  if (ep && !used.length) hint(u.id, '沒有任何鏡頭用到這個機位；用不到就刪掉，免得多生成一張背景圖');
}
for (const p of propDefs.values()) {
  for (const l of langs) {
    assets.push({ id: p.id, kind: '道具圖', lang: l, prompt: joinS([pick(p.desc, l), T[l].prop, pick(P.style_lock, l)], l) });
  }
}
// 特效參考圖：每個狀態一張，單獨放在純黑背景上；後製的特效出的是給剪接的人看的設計圖
for (const f of fxDefs.values()) {
  const kindName = isPost(f) ? '特效設計圖（後製用）' : '特效參考圖';
  const states = Object.keys(f.states && typeof f.states === 'object' ? f.states : {});
  for (const st of states.length ? states : ['']) {
    for (const l of langs) {
      assets.push({ id: f.id, kind: st ? `${kindName}・${st}` : kindName, lang: l, prompt: joinS([looksOf(f, st, l), T[l].fx, pick(P.style_lock, l)], l) });
    }
  }
}

// ---------- 檢查分鏡 ----------
const shots = ep && Array.isArray(ep.shots) ? ep.shots : [];
const castKey = (s) => (s.cast || []).map((e) => e.char).sort().join('+');
// 主體是誰、誰只是前景：過肩正反打的兩鏡角色相同，但正面入鏡的人不同
const subjectKey = (s) => (s.cast || []).map((e) => `${e.char}${e.partial ? '~' : ''}`).sort().join('+');
const hasCJK = (v, l) => CJK.test(pick(v, l));
/** 用詞表以外的寫法：出英文提示詞時不能夾中文。 */
function checkTerm(id, field, v, known, list) {
  if (!zhOf(v) || known) return;
  if (langs.includes('en') && hasCJK(v, 'en')) {
    warn(id, `${field}「${zhOf(v)}」不在用詞表裡，英文提示詞會夾著中文；改用用詞表（${list}），或寫成 {"zh": "…", "en": "…"}`);
  } else if (typeof v === 'string') {
    hint(id, `${field}「${zhOf(v)}」不在用詞表裡（${list}），腳本會原樣放進提示詞，也無法替它做相關檢查`);
  }
}
// 場次設計（plan）與節拍：每一鏡用 beat（"1.3"＝第 1 場的第 3 個節拍）指回場次設計，腳本才能檢查高點
const plans = ep && Array.isArray(ep.plan) ? ep.plan : [];
const planId = (p, i) => String(p.id ?? i + 1);
const planById = new Map(plans.map((p, i) => [planId(p, i), p]));
const beatsOf = (p) => (Array.isArray(p?.beats) ? p.beats : []);
/** 高點是第幾個節拍（從 0 起算）；peak 可以寫節拍序號，或和 beats 裡的文字一樣。對不上回傳 -1。 */
function peakIndex(p) {
  const beats = beatsOf(p);
  if (p.peak == null || p.peak === '') return -1;
  const n = Number(p.peak);
  if (Number.isInteger(n) && n >= 1 && n <= beats.length) return n - 1;
  const t = String(p.peak).trim();
  const k = beats.findIndex((b) => String(b).trim() === t);
  return k >= 0 ? k : beats.findIndex((b) => String(b).includes(t) || t.includes(String(b)));
}
const BEAT_RE = /^\s*([^.．\s]+)\s*[.．]\s*(\d+)\s*$/;
/** 解析一鏡的 beat：null＝沒填；{bad}＝寫錯；{pid, idx}＝第幾場的第幾個節拍（idx 從 0 起算）。 */
function beatOf(s) {
  if (s.beat == null || s.beat === '') return null;
  const m = BEAT_RE.exec(String(s.beat));
  if (!m) return { bad: `beat 要寫成「場次.節拍」，例如 "1.3"（第 1 場的第 3 個節拍）；目前是「${s.beat}」` };
  const p = planById.get(m[1]);
  if (!p) return { bad: `beat「${s.beat}」的場次 ${m[1]} 不在 plan 裡` };
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx >= beatsOf(p).length) return { bad: `beat「${s.beat}」：第 ${m[1]} 場只有 ${beatsOf(p).length} 個節拍` };
  return { p, pid: m[1], idx };
}
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
  let legacySize = 0;
  if (shots.length && !plans.length) {
    hint('plan', '分鏡檔沒有 plan（場次設計）；拆鏡前先寫每場戲的目的、視點、節拍與高點，鏡頭才有依據，見 references/shot-craft.md');
  }
  plans.forEach((p, i) => {
    const where = `plan 第 ${planId(p, i)} 場`;
    if (planById.get(planId(p, i)) !== p) err(where, '場次編號重複');
    if (p.scene && !scenes.has(p.scene)) err(where, `場景編號 ${p.scene} 不在設定檔裡`);
    const miss = [['purpose', '目的'], ['beats', '節拍'], ['peak', '高點']].filter(([k]) => (k === 'beats' ? !beatsOf(p).length : !p[k])).map(([k, n]) => `${k}（${n}）`);
    if (miss.length) hint(where, `沒有寫 ${miss.join('、')}；鏡頭的景別與長短都要從這幾個答案來`);
    if (p.blocking && SCREEN_RE.test(String(p.blocking))) {
      hint(where, 'blocking 寫的是人在空間裡的位置與路線（靠窗的桌前、走到門邊），畫面左右會隨機位改變；畫面上的位置寫在各鏡 cast 的 pos');
    }
  });
  shots.forEach((s, i) => {
    const id = s.id || `第 ${i + 1} 鏡`;
    const sp = spec(s);
    const cam = parseCam(s);
    const su = s.setup ? setups.get(s.setup) : null;
    if (!s.id) err(id, '缺少鏡號 id');
    else if (seenIds.has(s.id)) err(id, '鏡號重複');
    seenIds.add(s.id);

    for (const k of ['size', 'camera', 'action']) if (!s[k]) err(id, `缺少 ${k}`);
    if (!(Number(s.duration) > 0)) err(id, 'duration 要是大於 0 的秒數');
    if (!s.source) warn(id, '缺少 source（原文對應）；沒有它，使用者很難核對有沒有漏劇情');
    const b = beatOf(s);
    if (b?.bad) err(id, b.bad);
    else if (b && b.p.scene && b.p.scene !== s.scene) warn(id, `beat 指向第 ${b.pid} 場（場景 ${b.p.scene}），但這一鏡的場景是 ${s.scene}`);
    if (typeof s.beat === 'number') hint(id, 'beat 請寫成字串（"1.3"）；寫成數字時 1.10 會被讀成 1.1');
    if (REF_MODE && s.link !== '接續' && REF_MAX) {
      const n = refPlan(s).length;
      if (n > REF_MAX) warn(id, `參考圖模式下這一鏡要掛 ${n} 張參考圖，超過工具上限 ${REF_MAX} 張；把背影角色改成 partial 片段、少引用一件道具，或拆成兩鏡`);
    }
    if (s.cut != null && s.cut !== true && s.cut !== false && typeof s.cut !== 'string') warn(id, 'cut 要寫成一句理由（例如「懸念：她看見訊息」）');
    if (s.cut && i === shots.length - 1) hint(id, '最後一鏡本來就是結尾，不用標 cut');
    if (!scenes.has(s.scene)) err(id, `場景編號 ${s.scene ?? '（空）'} 不在設定檔裡`);
    else if (!seenScenes.has(s.scene)) {
      seenScenes.add(s.scene);
      // 建立鏡頭不一定要是第一鏡（漫劇常先給鉤子），頭三鏡內有就好
      const opening = shots.slice(i, i + 3).filter((x) => x.scene === s.scene);
      if (!opening.some((x) => WIDE.has(spec(x).size))) {
        hint(id, `場景 ${s.scene} 出現後的頭三鏡沒有遠景或全景，觀眾不知道人在哪裡；補一個建立鏡頭交代空間`);
      }
    }

    // 景別、鏡頭類型、角度、運鏡的用詞
    if (sp.legacy) legacySize++;
    checkTerm(id, '景別', s.size, sp.legacy || !!SIZES[sp.size], Object.keys(SIZES).join('、'));
    checkTerm(id, '鏡頭類型', s.type, !!TYPES[sp.type], Object.keys(TYPES).join('、'));
    checkTerm(id, '角度', s.angle, !!ANGLES[sp.angle], Object.keys(ANGLES).join('、'));
    if (cam.vague) warn(id, `運鏡「${cam.raw}」沒有方向，生成工具只能猜；改成${cam.def.fix}`);
    else if (typeof s.camera === 'string') checkTerm(id, '運鏡', s.camera, !cam.custom, `${Object.keys(MOVES).join('、')}；前面可加「緩慢」「輕微」`);
    else checkFrag(`${id}.camera`, s.camera);
    checkTerm(id, '機位高度', s.height, !!HEIGHTS[sp.height], Object.keys(HEIGHTS).join('、'));
    if (sp.height === '地面' && ['俯拍', '頂拍'].includes(sp.angle)) {
      warn(id, `機位貼近地面卻是${sp.angle}，兩者矛盾；貼地的鏡頭用平視或仰拍，要往下看就改成高機位`);
    }
    if (s.speed != null && s.speed !== '' && !speedOf(s)) warn(id, `speed「${zhOf(s.speed)}」不在用詞表裡（${Object.keys(SPEEDS).join('、')}），不會寫進提示詞`);

    // 生成方式：靜幀只出首幀圖，不跑影片
    const still = isStill(s);
    if (s.render != null && !RENDERS.includes(s.render)) warn(id, `render 請填 ${RENDERS.join('、')}；目前的「${s.render}」當成「影片」處理`);
    if (still) {
      if (s.render === '靜幀運鏡') {
        if (!cam.vague && (cam.custom || !STILL_MOVES.has(cam.base))) warn(id, `靜幀運鏡是在一張圖上推拉或搖移，做不出「${cam.raw}」；改成推近、拉遠、搖或移，或把 render 改回「影片」`);
        else if (cam.base === '固定') hint(id, '靜幀運鏡卻是固定；不需要推拉就把 render 改成「靜幀」，否則寫推近、拉遠或搖移');
      } else if (!isStatic(s)) hint(id, `靜幀的畫面不動，運鏡「${cam.raw}」不會用到；要在圖上推拉就把 render 改成「靜幀運鏡」`);
      if (speedOf(s)?.zh) warn(id, `靜幀不跑影片，做不出 speed「${zhOf(s.speed)}」；要這個效果就把 render 改回「影片」`);
      else if (zhOf(s.speed) === '定格') hint(id, '靜幀本來就不動，不用再標定格');
      if (s.line?.text && s.line.type === '對白' && ['後配口型', '原生音訊'].includes(P.audio_plan)) {
        hint(id, '靜幀不跑影片，說話的人嘴不會動；說話的鏡頭用影片，或把這句改成畫外音、配在聽的人身上');
      }
    } else {
      if (!s.risk && RISKY_MOVES[cam.base] && !cam.custom) hint(id, RISKY_MOVES[cam.base]);
      if (speedOf(s) === SPEEDS.升格 && NATIVE_AUDIO && s.line?.text && s.line.type === '對白') {
        hint(id, '慢動作的鏡頭配不上正常速度的台詞；台詞移到前後鏡，或改成畫外音在剪接時鋪');
      }
    }

    // 機位
    if (s.setup) {
      if (!su) err(id, `機位編號 ${s.setup} 不在這一集的 setups 裡`);
      else if (su.scene !== s.scene) err(id, `機位 ${s.setup} 屬於場景 ${su.scene}，但這一鏡的場景是 ${s.scene}`);
    }
    if (CLOSE.has(sp.size) && !zhOf(s.bg) && !zhOf(su?.bg)) {
      warn(id, `${sp.size}沒有寫 bg，也沒有機位的 bg；腳本會放整段場景描述，生成工具可能把整個房間塞進畫面。寫這一鏡實際看得到的背景`);
    }

    // 角色與走位
    const cast = Array.isArray(s.cast) ? s.cast : [];
    const baseIds = cast.map((e) => chars.get(e.char)?.c.id).filter(Boolean);
    const twice = [...new Set(baseIds.filter((x, k) => baseIds.indexOf(x) !== k))];
    if (twice.length) {
      warn(id, `${twice.join('、')} 在這一鏡出現兩次；一個角色編號只代表一個人，提示詞會用同一個短稱寫兩次。長得一樣的兩個手下要登記成兩個角色、短稱分得出來；當成一群人時登記成一個角色，tag 與 look 寫成複數（「兩個蒙面黑衣人」），cast 只放一次`);
    }
    cast.forEach((e) => {
      if (!chars.has(e.char)) { err(id, `角色編號 ${e.char ?? '（空）'} 不在設定檔裡`); return; }
      // 只入鏡身體一部分（partial 寫成片段）時，那段文字已經說明看得到什麼，視線與手部不必再寫。
      // 器物沒有眼睛和手，只要寫位置；動物與異獸的前爪寫在 hands，但不強制
      const kind = kindOf(chars.get(e.char).c);
      const need = isPartialText(e) ? [] : kind === '器物' ? ['pos'] : kind === '動物' || kind === '異獸' ? ['pos', 'gaze'] : ['pos', 'gaze', 'hands'];
      const miss = need.filter((k) => !e[k]);
      if (miss.length) warn(id, `${e.char} 沒寫 ${miss.join('、')}；沒寫的地方生成工具會自己猜`);
      for (const k of ['pos', 'gaze', 'hands', 'face']) checkFrag(`${id} ${e.char}.${k}`, e[k]);
      if (isPartialText(e)) checkFrag(`${id} ${e.char}.partial`, e.partial);
    });
    for (const k of ['props', 'frame', 'bg', 'light', 'palette', 'negative', 'end']) checkFrag(`${id}.${k}`, s[k]);

    // 特效
    if (s.fx != null && !Array.isArray(s.fx)) err(id, 'fx 要寫成陣列，例如 [{"id": "F01", "state": "上弦", "pos": "攤開的左手掌心"}]');
    (Array.isArray(s.fx) ? s.fx : []).forEach((e) => {
      const d = fxDefs.get(e?.id);
      if (!d) { err(id, `特效編號 ${e?.id ?? '（空）'} 不在設定檔的 effects 裡`); return; }
      const states = Object.keys(d.states && typeof d.states === 'object' ? d.states : {});
      if (e.state && !hasState(d, e.state)) err(id, `特效 ${e.id} 沒有「${e.state}」這個狀態（設定檔裡有：${states.join('、') || '沒有分狀態'}）`);
      if (!e.state && states.length) hint(id, `特效 ${e.id}（${d.name || ''}）有分狀態（${states.join('、')}），這一鏡沒寫 state，會用 desc；確認這一鏡是哪一個狀態`);
      if (!isPost(d) && !e.pos) warn(id, `特效 ${e.id} 沒寫 pos；特效在畫面哪裡、附著在什麼上面，生成工具會自己猜`);
      checkFrag(`${id} ${e.id}.pos`, e.pos);
      if (e.motion !== false) checkFrag(`${id} ${e.id}.motion`, e.motion);
      if (e.light !== false) checkFrag(`${id} ${e.id}.light`, e.light);
      if (e.motion && langs.some((l) => FAST_RE.test(pick(e.motion, l)))) warn(id, `特效 ${e.id} 的 motion 用了「爆發／瞬間」這類字眼；寫成慢慢擴散、明暗起伏，快的留給後製`);
    });
    checkFrag(`${id}.motion`, s.motion, !still);
    if (NATIVE_AUDIO) checkFrag(`${id}.sound`, s.sound);
    if (USE_LAST && cast.length && !s.end && !still) warn(id, '缺少 end（尾幀與首幀的差別）；有首尾幀控制時動作最穩');

    // 動作描述（靜幀不跑影片，motion 不會用到）
    const motions = still ? [] : langs.map((l) => pick(s.motion, l));
    if (motions.some((m) => FAST_RE.test(m))) warn(id, 'motion 用了「快速／劇烈／瞬間」這類字眼，容易變形；改用剪接表現速度，單鏡內寫正常速度、小幅度');
    if (motions.some((m) => SLOW_RE.test(m))) slow++;
    const fullCast = cast.filter((e) => !isPartialText(e));
    if (fullCast.length && !still) {
      for (const l of langs) {
        const m = pick(s.motion, l).toLowerCase();
        const tags = fullCast.map((e) => { const h = chars.get(e.char); return h ? tagOf(h.c, h.v, l).toLowerCase() : ''; }).filter(Boolean);
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
        if (prev.setup && s.setup && prev.setup !== s.setup) warn(id, '「接續」表示沿用上一鏡的最後一幀，但機位和上一鏡不同；應該是「切」');
      }
      if (s.transition) warn(id, `「接續」是同一個鏡頭延續下去，中間沒有剪接點，不會有轉場（目前填了「${s.transition}」）；要轉場就改成「切」`);
    } else if (i > 0) {
      // 跳接：主體、景別、類型、角度、機位都和上一鏡一樣，卻切了一刀
      const prev = shots[i - 1];
      const ps = spec(prev);
      const same = prev.scene === s.scene && hasFullCast(s) && subjectKey(prev) === subjectKey(s)
        && sp.size && ps.size === sp.size && ps.type === sp.type && (ps.angle || '平視') === (sp.angle || '平視')
        && (ps.height || '') === (sp.height || '') && (prev.setup || '') === (s.setup || '');
      if (same && !/跳接/.test(s.transition || '')) {
        warn(id, `和上一鏡的主體、景別（${sizeLabel(s)}）、角度都一樣，直接切會像跳接；景別差一級以上、換角度或機位，或中間插一個反應／插入鏡頭。真的是同一個鏡頭延續就用「接續」，刻意要跳接就在 transition 寫「跳接」`);
      }
    }

    // 時長
    const d = Number(s.duration) || 0;
    if (s.line && s.line.text) {
      const need = speakSeconds(s.line.text) + 0.3;
      if (need > d) warn(id, `對白／旁白約需 ${need.toFixed(1)} 秒（字數 ÷ ${RATE} + 0.3），但這一鏡只有 ${d} 秒；請拆成兩鏡、縮短句子，或把句子分到相鄰兩鏡的 line`);
      if (!LINE_TYPES.includes(s.line.type)) hint(id, 'line.type 請用「對白」（說話的人在畫面裡）、「畫外音」（人在現場但這一鏡沒拍到他說話）、「旁白」或「內心獨白」');
      if (s.line.type === '對白' && chars.has(s.line.who) && chars.get(s.line.who).c.mouthless) {
        const sp = chars.get(s.line.who).c;
        hint(id, `${sp.id}${sp.name ? ` ${sp.name}` : ''} 沒有嘴（mouthless），不會對口型；type 改用「畫外音」，並在 motion 寫一個看得見的說話信號（燈光隨話語明暗、壺蓋輕輕跳動）`);
      }
      if (s.line.type === '對白' && chars.has(s.line.who)) {
        const speaker = chars.get(s.line.who).c.id;
        const onScreen = cast.some((e) => chars.get(e.char)?.c.id === speaker && !e.partial);
        if (!onScreen) hint(id, `這句是「對白」，但說話的 ${speaker} 沒有正面入鏡；說話的人不在畫面裡（或只有背影）時 type 用「畫外音」，原生音訊也不會替這一鏡生成他的聲音`);
      }
      checkFrag(`${id}.line.tone`, s.line.tone);
    }
    if (HAS_CLIP && !still && genLength(d) === null) {
      warn(id, `成片 ${d} 秒加上裁頭尾 ${TRIM} 秒，超過工具單次可生成的 ${MAX_CLIP} 秒；請拆鏡`);
    }

    // 提示詞長度
    for (const l of langs) {
      if (s.link !== '接續') checkLimit(id, 'image', imagePrompt(s, l), l);
      if (!still) checkLimit(id, 'video', videoPrompt(s, l), l);
    }
  });

  // 節拍與高點：鏡頭有沒有照著場次設計安排
  if (plans.length && shots.length) {
    const tagged = shots.map((s) => ({ s, b: beatOf(s) })).filter((x) => x.b && !x.b.bad);
    if (!tagged.length) {
      hint('beat', '鏡頭都沒有填 beat（這一鏡屬於哪一場的哪個節拍，例如 "1.3"）；填了腳本才能檢查高點有沒有用最近的景別、停最久，以及有沒有節拍漏拍');
    } else {
      const untagged = shots.filter((s) => s.beat == null || s.beat === '');
      if (untagged.length) warn('beat', `${untagged.map((s) => s.id).join('、')} 沒有填 beat；其他鏡頭都有，這幾鏡不會算進高點與節拍的檢查`);
      const isPerson = (s) => hasFullCast(s) && !['插入', '空鏡'].includes(spec(s).type);
      const rank = (s) => SIZE_RANK[spec(s).size] ?? -1;
      const dur = (s) => Number(s.duration) || 0;
      const nameOfRank = (r) => Object.keys(SIZE_RANK).find((k) => SIZE_RANK[k] === r) || '';
      plans.forEach((p, pi) => {
        const pid = planId(p, pi);
        const where = `plan 第 ${pid} 場`;
        const beats = beatsOf(p);
        const mine = tagged.filter((x) => x.b.pid === pid);
        if (!mine.length) { warn(where, '沒有任何鏡頭的 beat 指向這一場'); return; }
        // 兩個以上的角色同場，就有站位、走位與軸線要先決定
        const people = new Set(mine.flatMap((x) => (x.s.cast || []).map((e) => chars.get(e.char)?.c).filter((c) => c && kindOf(c) !== '器物').map((c) => c.id)));
        if (people.size >= 2 && !p.blocking) {
          hint(where, `這場戲有 ${people.size} 個角色，沒有寫 blocking（走位）；先寫清楚每個人在空間裡的起點、往哪裡移動、軸線在誰和誰之間，機位和視線方向才排得對`);
        }
        const counts = beats.map((_, k) => mine.filter((x) => x.b.idx === k).length);
        counts.forEach((n, k) => { if (!n) warn(where, `節拍 ${k + 1}「${beats[k]}」沒有任何鏡頭；是漏拍了，或這個節拍其實不需要，從 plan 刪掉`); });
        if (beats.length >= 4 && counts.every((n) => n === 1)) {
          hint(where, `${beats.length} 個節拍都只有一鏡，容易變成原文一句對一鏡；重要的節拍拆成動作與反應兩鏡，或在高點前加一個停頓`);
        }
        // 整集的第一鏡是從後面提前的鉤子（漫劇常這樣開場）時，它的節拍本來就比下一鏡後面，不算倒退
        const hookFirst = mine.length > 1 && mine[0].s === shots[0] && mine[0].b.idx > mine[1].b.idx;
        for (let k = hookFirst ? 2 : 1; k < mine.length; k++) {
          if (mine[k].b.idx < mine[k - 1].b.idx) {
            hint(mine[k].s.id, `beat 從 ${pid}.${mine[k - 1].b.idx + 1} 倒回 ${pid}.${mine[k].b.idx + 1}；鏡頭順序和節拍順序不一致。平行剪輯或閃回沒關係，否則檢查 plan 的節拍順序`);
            break;
          }
        }
        const pk = peakIndex(p);
        if (p.peak && pk < 0) { hint(where, `peak「${p.peak}」對不上任何一個節拍；寫節拍的序號（例如 4），或和 beats 裡的文字一字不差`); return; }
        if (pk < 0) return;
        const peakShots = mine.filter((x) => x.b.idx === pk).map((x) => x.s);
        const rest = mine.filter((x) => x.b.idx !== pk).map((x) => x.s);
        if (!peakShots.length || !rest.length) return;
        // 景別：其他節拍只比有人物的鏡頭（交代資訊的插入特寫比人物近景「近」，但那不是觀眾和人物之間的距離）；
        // 高點這一邊連插入鏡頭也算，盯著的那樣東西推到最近，本來就是高點常用的拍法
        const pP = peakShots.filter((s) => isPerson(s) || spec(s).type === '插入');
        const rP = rest.filter(isPerson);
        const pClose = pP.length ? Math.max(...pP.map(rank)) : -1;
        const rClose = rP.length ? Math.max(...rP.map(rank)) : -1;
        const closeFail = pP.length > 0 && rP.length > 0 && pClose < rClose;
        const pLong = Math.max(...peakShots.map(dur));
        const rLong = Math.max(...rest.map(dur));
        const longFail = pLong < rLong;
        const msgs = [];
        if (closeFail) msgs.push(`最近只到${nameOfRank(pClose)}，其他節拍的人物鏡頭卻用了${nameOfRank(rClose)}`);
        if (longFail) msgs.push(`最長的一鏡 ${pLong} 秒，比其他節拍的 ${rLong} 秒短`);
        if (msgs.length) {
          (closeFail && longFail ? warn : hint)(where, `高點「${beats[pk]}」${msgs.join('；')}。最近的景別、最長的停留通常留給高點；刻意用遠景表現孤立、或用很短的鏡頭製造衝擊時，交付時說明理由`);
        }
      });
    }
  }

  if (legacySize) {
    hint('整體', `${legacySize} 鏡把鏡頭類型寫在 size 裡（過肩、主觀、背影、空鏡、物件特寫）；腳本照舊處理，但這些鏡頭沒有景別。建議改成 size 填景別、type 填鏡頭類型`);
  }

  // 景別一直不變：正反打用成對的景別很正常，所以只在連續四鏡以上才提示
  const sizeOf = (s) => spec(s).size;
  let run = 1;
  for (let i = 1; i <= shots.length; i++) {
    if (i < shots.length && sizeOf(shots[i]) && sizeOf(shots[i]) === sizeOf(shots[i - 1]) && shots[i].scene === shots[i - 1].scene) run++;
    else {
      if (run >= 4) hint(shots[i - run].id, `從這一鏡起連續 ${run} 鏡都是${sizeOf(shots[i - 1])}；情緒有轉折的地方推近一級，或插一個插入鏡頭、空鏡換氣`);
      run = 1;
    }
  }
  const totalSec = shots.reduce((n, s) => n + (Number(s.duration) || 0), 0);
  if (totalSec > 60 && !SHORT_EP && !shots.slice(0, -1).some((s) => s.cut)) {
    hint('整體', `整集約 ${Math.round(totalSec)} 秒，沒有標任何建議切點；在場景結束或懸念處加上 cut，使用者想切短時才有地方下刀`);
  }
  if (EP_LEN && shots.length) {
    if (totalSec > EP_LEN[1]) {
      warn('整體', `整集約 ${Math.round(totalSec)} 秒，超過單集長度上限 ${EP_LEN[1]} 秒；先刪台詞、合併過場鏡頭，還是太長就把一個節拍移到下一集，並同時改分集表`);
    } else if (totalSec < EP_LEN[0]) {
      warn('整體', `整集約 ${Math.round(totalSec)} 秒，不到單集長度下限 ${EP_LEN[0]} 秒；不要用放慢的鏡頭撐，補反應鏡頭、插入鏡頭，或把下一集開頭的內容提前`);
    }
  }
  if (seriesForEp && !epPlan) hint('分集表', `bible.json 旁邊的 series.json 裡沒有 ${ep.episode || '這一集'}；分集表要先排到這一集，拆鏡才有鉤子與卡點可以對照`);
  const durs = new Set(shots.map((s) => Number(s.duration)));
  if (shots.length >= 6 && durs.size === 1) hint('整體', `所有鏡頭都是 ${[...durs][0]} 秒，節奏會單調；依內容給長短變化`);
  if (shots.length >= 5 && slow / shots.length > 0.6) {
    hint('整體', `${slow}/${shots.length} 鏡的 motion 都強調「緩慢」，成片容易像慢動作；多數鏡頭寫「自然速度、幅度小」即可`);
  }
}
// ---------- 分集表檢查 ----------
const CLIFF_TYPES = ['危機', '揭露', '反轉', '抉擇', '登場'];
const epNum = (s) => { const m = /(\d+)\s*$/.exec(String(s || '')); return m ? Number(m[1]) : null; };
const okRange = (r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(Number(n)) && Number(n) > 0) && Number(r[0]) <= Number(r[1]);
const eps = series ? series.episodes : [];
const acts = series && Array.isArray(series.acts) ? series.acts : [];
if (series) {
  if (!eps.length) err('episodes', '分集表裡沒有任何一集');
  if (!EP_LEN) hint('project.episode_length', '設定檔沒有 episode_length（單集長度）；填了腳本才能檢查每一集的預估秒數');
  acts.forEach((a, i) => {
    if (!okRange(a.range)) warn(`第 ${a.id ?? i + 1} 幕`, 'range 要寫成 [第一集, 最後一集]，例如 [1, 16]');
    if (!a.turn) hint(`第 ${a.id ?? i + 1} 幕`, '沒有寫 turn（這一幕結尾的轉折）；它是下一幕的起因，分集時要切在它上面');
  });
  const ranges = acts.filter((a) => okRange(a.range)).map((a) => a.range.map(Number)).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] !== ranges[i - 1][1] + 1) hint('acts', `幕與幕的集數範圍有重疊或缺口（${ranges[i - 1].join('–')} 接 ${ranges[i].join('–')}）`);
  }
  const total = Number(series.total_episodes);
  if (total > 0 && ranges.length && ranges[ranges.length - 1][1] !== total) {
    hint('acts', `最後一幕結束在第 ${ranges[ranges.length - 1][1]} 集，但 total_episodes 是 ${total}`);
  }
  const seen = new Set();
  let prevNum = null;
  eps.forEach((e, i) => {
    const id = e.episode || `第 ${i + 1} 筆`;
    const dup = !!e.episode && seen.has(e.episode);
    if (!e.episode) err(id, '缺少 episode（集數，例如 EP01）');
    else if (dup) err(id, '集數重複');
    seen.add(e.episode);
    const num = epNum(e.episode);
    if (!dup && num != null && prevNum != null && num !== prevNum + 1) warn(id, `沒有接在 ${eps[i - 1].episode} 後面；中間漏了集數，或順序排錯`);
    if (num != null) prevNum = num;
    if (!e.source) warn(id, '缺少 source（對應大綱的哪一段）；沒有它，使用者很難核對有沒有漏劇情');
    if (!e.logline) warn(id, '缺少 logline（一句話劇情）');
    for (const [k, name] of [['hook', 'hook（鉤子：前三秒的畫面）'], ['payoff', 'payoff（爽點或核心事件）'], ['cliff', 'cliff（卡點：結尾留給觀眾的問題）']]) {
      if (!e[k]) warn(id, `缺少 ${name}；每一集都要回答這一題，見 references/outline-to-episodes.md`);
    }
    if (e.cliff && !/[？?]/.test(e.cliff)) hint(id, 'cliff 只寫了最後發生什麼，沒有寫出觀眾心裡的問題；在最後一個畫面後面接一句問題（「外婆為什麼要押她的記憶？」），寫劇本和拆鏡時才知道要停在誰的反應上');
    if (e.cliff_type && !CLIFF_TYPES.includes(e.cliff_type)) hint(id, `cliff_type「${e.cliff_type}」不在分類裡（${CLIFF_TYPES.join('、')}）`);
    const cast = Array.isArray(e.cast) ? e.cast : [];
    if (!cast.length) warn(id, '缺少 cast（出場角色的編號）');
    for (const c of cast) if (!chars.has(c)) warn(id, `角色編號 ${c} 不在設定檔裡；拆這一集之前要補進 bible.json，或先寫在 new_assets`);
    const scs = Array.isArray(e.scenes) ? e.scenes : [];
    if (!scs.length) warn(id, '缺少 scenes（用到的場景編號）');
    for (const s of scs) if (!scenes.has(s)) warn(id, `場景編號 ${s} 不在設定檔裡；拆這一集之前要補進 bible.json，或先寫在 new_assets`);
    if (scs.length > 3) hint(id, `用到 ${scs.length} 個場景；短集的地點最好不超過三個，每多一個就多一張場景定稿圖和一次建立鏡頭`);
    const sec = Number(e.est_seconds);
    if (!(sec > 0)) warn(id, '缺少 est_seconds（預估秒數）');
    else if (EP_LEN && (sec < EP_LEN[0] || sec > EP_LEN[1])) {
      warn(id, `預估 ${sec} 秒，不在單集長度 ${EP_LEN[0]} 到 ${EP_LEN[1]} 秒之內；太長就把過場併掉或移一個節拍到下一集，太短就和相鄰的集合併，不要灌水`);
    }
    if (ranges.length && num != null && !ranges.some((r) => num >= r[0] && num <= r[1])) hint(id, '不在任何一幕的集數範圍（acts[].range）裡');
  });
  // 卡點連續三集以上同一種，觀眾會疲乏
  let runStart = 0;
  for (let i = 1; i <= eps.length; i++) {
    const t = eps[runStart]?.cliff_type;
    if (i < eps.length && t && eps[i].cliff_type === t) continue;
    if (t && i - runStart >= 3) {
      hint(eps[runStart].episode || `第 ${runStart + 1} 筆`, `從這一集起連續 ${i - runStart} 集的卡點都是「${t}」；換一種（${CLIFF_TYPES.filter((x) => x !== t).join('、')}），觀眾才不會疲乏`);
    }
    runStart = i;
  }
  if (Array.isArray(series.pending) && series.pending.length) hint('分集表', `還有 ${series.pending.length} 項分集上的事要請使用者決定`);
}

// ---------- 分集劇本檢查 ----------
// 台詞：「角色名（語氣）：台詞」或「旁白：…」；△ 開頭是畫面，【字】開頭是後製文字
const SPEECH_RE = /^([^\s△【#>*|\-：:（(]{1,12})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/u;
const NOT_SPEAKER = new Set(['人物', '目的', '時間', '地點', '鉤子', '爽點', '卡點', '備註', '場景']);
const scriptStats = { scenes: 0, visuals: 0, texts: 0, lines: 0, seconds: 0, bySpeaker: new Map() };
if (scriptText != null) {
  const names = new Set([...charList.map(({ c }) => c.name).filter(Boolean), '旁白']);
  scriptText.split(/\r?\n/).forEach((raw, n) => {
    const l = raw.trim();
    if (/^##\s/.test(l)) { scriptStats.scenes++; return; }
    if (l.startsWith('△')) { scriptStats.visuals++; return; }
    if (l.startsWith('【')) { scriptStats.texts++; return; }
    const m = SPEECH_RE.exec(l);
    if (!m || NOT_SPEAKER.has(m[1])) return;
    const who = m[1];
    const text = m[3].replace(/[「」『』“”"]/g, '');
    const sec = speakSeconds(text) + 0.3;
    scriptStats.lines++;
    scriptStats.seconds += sec;
    scriptStats.bySpeaker.set(who, (scriptStats.bySpeaker.get(who) || 0) + sec);
    const where = `第 ${n + 1} 行`;
    if (!names.has(who)) hint(where, `說話者「${who}」不是設定檔裡的角色名稱，也不是「旁白」；名字打錯了，或這個角色還沒寫進 bible.json（只出聲音、不入鏡的角色可以不登記）`);
    if (sec > 5) hint(where, `「${[...text].slice(0, 12).join('')}…」約需 ${sec.toFixed(1)} 秒，一鏡講不完；拆成兩句，中間插一個反應鏡頭`);
  });
  const fmt = 'references/outline-to-episodes.md 第四節';
  if (!scriptStats.lines && !scriptStats.visuals) err('劇本', `沒有讀到任何畫面（△ 開頭）或台詞（角色名：台詞）；格式見 ${fmt}`);
  else if (!scriptStats.scenes) warn('劇本', `沒有讀到場標（## 第 1 場　地點　時段　內外）；格式見 ${fmt}`);
  const missingTop = ['鉤子', '爽點', '卡點'].filter((k) => !new RegExp(`^\\s*[-*]\\s*${k}[：:]`, 'm').test(scriptText));
  if (missingTop.length) hint('劇本', `開頭沒有寫${missingTop.join('、')}；從分集表抄上來，寫的時候才不會偏`);
  const s = scriptStats.seconds;
  if (EP_LEN) {
    if (s > EP_LEN[1]) {
      warn('劇本', `台詞與旁白約需 ${Math.round(s)} 秒，已經超過單集長度上限 ${EP_LEN[1]} 秒；先刪句子`);
    } else if (s > EP_LEN[1] * 0.75) {
      warn('劇本', `台詞與旁白約需 ${Math.round(s)} 秒，超過單集長度上限 ${EP_LEN[1]} 秒的四分之三；鉤子畫面、反應鏡頭和停頓沒有空間，拆鏡後幾乎一定超長，先刪句子`);
    }
  } else {
    hint('project.episode_length', '設定檔沒有 episode_length（單集長度）；填了才能比較台詞長度和單集長度');
  }
}

if (scriptText == null && Array.isArray(bible.pending) && bible.pending.length) {
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

const lenText = EP_LEN ? `${EP_LEN[0]} 到 ${EP_LEN[1]} 秒` : '';
const minSec = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`);

// ---------- settings.md / assets.csv（只檢查分集劇本時不寫） ----------
if (scriptText == null) {
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
    ['參考圖模式', REF_MODE
      ? `參考圖（提示詞用「${langs.map((l) => refToken(1, l)).join('」「')}」這類編號指向參考圖，每一鏡依分鏡表列的順序上傳${REF_MAX ? `，一次最多 ${REF_MAX} 張` : ''}）`
      : '文字（外貌與造型完整寫進每一鏡的提示詞，參考圖是加強）'],
    ['單次可生成秒數', RANGE ? `${RANGE[0]} 到 ${RANGE[1]}` : CLIPS.length ? CLIPS.join(' / ') : '未填'],
    ...(EP_LEN ? [['單集長度', lenText]] : []),
    ...(P.narration ? [['旁白', P.narration]] : []),
  ]), '');
  if (Array.isArray(bible.pending) && bible.pending.length) {
    L.push('## 待確認設定', '', '以下是原文沒寫、先補上的暫定值。要改請直接說，改一處所有鏡頭會一起更新。', '');
    for (const p of bible.pending) L.push(`- ${p}`);
    L.push('');
  }
  L.push('## 角色', '');
  L.push(table(['編號', '名稱', '短稱', '固定外貌', '辨識特徵', '造型變體'], charList.map(({ c, vs }) => {
    const extra = [kindOf(c) !== '人' ? kindOf(c) : '', c.mouthless ? '沒有嘴' : ''].filter(Boolean).join('，');
    return [
      c.id, `${c.name || ''}${extra ? `（${extra}）` : ''}`, show(c.tag), show(c.look), show(c.marks),
      vs.map((v) => {
        const desc = [show(v.look) ? `外貌：${show(v.look)}` : '', show(v.tag) ? `短稱：${show(v.tag)}` : '', show(v.outfit), show(v.state)].filter(Boolean).join('；');
        return `${v.id}${v.label ? `（${v.label}）` : ''}${desc ? `：${desc}` : ''}`;
      }).join('<br>'),
    ];
  })), '');
  L.push('## 場景', '');
  const hasPalette = [...scenes.values()].some((s) => show(s.palette));
  L.push(table(['編號', '名稱', '空間', '光線', '時間／天氣', ...(hasPalette ? ['色彩'] : [])], [...scenes.values()].map((s) => [
    s.id, s.name || '', show(s.space), show(s.light), show(s.time), ...(hasPalette ? [show(s.palette)] : []),
  ])), '');
  if (propDefs.size) {
    L.push('## 道具', '');
    const stList = (d) => Object.entries(d.states && typeof d.states === 'object' ? d.states : {}).map(([k, sv]) => `${k}：${show(sv)}`).join('<br>');
    const hasStates = [...propDefs.values()].some((p) => stList(p));
    L.push(table(['編號', '名稱', '固定描述', ...(hasStates ? ['狀態'] : [])], [...propDefs.values()].map((p) => [
      p.id, p.name || '', show(p.desc), ...(hasStates ? [stList(p)] : []),
    ])), '');
  }
  if (fxDefs.size) {
    const stList = (d) => Object.entries(d.states && typeof d.states === 'object' ? d.states : {}).map(([k, sv]) => `${k}：${show(sv)}`).join('<br>');
    L.push('## 特效', '', '「在哪裡做」是後製的特效不會進提示詞：生成時在畫面上替它留位置，剪接時再加。', '');
    // 分狀態的發光與動態：沒列的狀態用整段的 light／motion；空字串表示這個狀態不發光、不動
    const byState = (f, key) => [
      show(f[key]),
      ...Object.entries(f[`${key}_states`] && typeof f[`${key}_states`] === 'object' ? f[`${key}_states`] : {}).map(([k, sv]) => `${k}：${show(sv) || (key === 'light' ? '不發光' : '不動')}`),
    ].filter(Boolean).join('<br>');
    L.push(table(['編號', '名稱', '外觀', '狀態', '怎麼動', '照亮周圍', '在哪裡做'], [...fxDefs.values()].map((f) => [
      f.id, f.name || '', show(f.desc), stList(f), byState(f, 'motion'), byState(f, 'light'), MAKES.includes(f.make) ? f.make : '生成',
    ])), '');
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
  if (!ep && !series) L.push('## 檢查結果', '', issueTable(), '');
  written.push(write('settings.md', L.join('\n')));
  written.push(write('assets.csv', csv([
    ['編號', '類型', '語言', '提示詞', '模型', 'seed', '定稿檔名', '備註'],
    ...assets.map((a) => [a.id, a.kind, T[a.lang].name, a.prompt, '', '', '', '']),
  ])));
}

// ---------- 分集表輸出 ----------
if (series) {
  const nameOf = (id) => (chars.has(id) ? chars.get(id).c.name || id : id);
  const sceneOf = (id) => (scenes.has(id) ? scenes.get(id).name || id : id);
  const list = (v) => (Array.isArray(v) ? v : []);
  const sum = eps.reduce((n, e) => n + (Number(e.est_seconds) || 0), 0);
  const L = [];
  L.push(`# ${P.title || '未命名專案'}　分集表`, '');
  if (series.source) L.push(`原文：${series.source}`, '');
  const span = eps.length ? `${eps[0].episode || ''}${eps.length > 1 ? ` 到 ${eps[eps.length - 1].episode || ''}` : ''}` : '';
  L.push([
    Number(series.total_episodes) > 0 ? `全季 ${series.total_episodes} 集。` : '',
    eps.length ? `這一批是 ${span}，共 ${eps.length} 集，預估約 ${minSec(sum)}。` : '',
    lenText ? `單集長度 ${lenText}。` : '',
    P.narration ? `旁白：${P.narration}。` : '',
  ].join(''), '');
  if (list(series.pending).length) {
    L.push('## 待確認', '', '分集上要你決定的事：', '');
    for (const p of series.pending) L.push(`- ${p}`);
    L.push('');
  }
  if (acts.length) {
    L.push('## 全季結構', '');
    L.push(table(['幕', '名稱', '集數', '結尾的轉折', '這一批排了'], acts.map((a, i) => {
      const r = okRange(a.range) ? a.range.map(Number) : null;
      const n = r ? eps.filter((e) => { const k = epNum(e.episode); return k != null && k >= r[0] && k <= r[1]; }).length : 0;
      return [a.id ?? i + 1, a.name || '', r ? `${r[0]}–${r[1]}（${r[1] - r[0] + 1} 集）` : '', a.turn || '', n ? `${n} 集` : '—'];
    })), '');
  }
  L.push('## 分集表', '', '鉤子是前三秒的畫面，卡點是結尾留給觀眾的問題。', '');
  L.push(table(['集數', '標題', '一句話劇情', '鉤子', '爽點／核心事件', '卡點', '秒'], eps.map((e) => [
    e.episode || '', e.title || '', e.logline || '', e.hook || '', e.payoff || '',
    `${e.cliff || ''}${e.cliff_type ? `（${e.cliff_type}）` : ''}${e.paywall ? '<br>**付費／留存卡點**' : ''}`,
    e.est_seconds ?? '',
  ])), '');
  L.push('## 各集細節', '');
  for (const e of eps) {
    L.push(`### ${e.episode || ''}${e.title ? `　${e.title}` : ''}`, '');
    if (e.source) L.push(`- 大綱對應：${e.source}`);
    if (e.thread) L.push(`- 主線推進：${e.thread}`);
    if (e.state) L.push(`- 結束時的狀態：${e.state}`);
    if (list(e.cast).length) L.push(`- 出場角色：${list(e.cast).map(nameOf).join('、')}`);
    if (list(e.scenes).length) L.push(`- 場景：${list(e.scenes).map(sceneOf).join('、')}`);
    for (const a of list(e.new_assets)) L.push(`- 新增資產：${a}`);
    for (const a of list(e.added)) L.push(`- 新增或調動：${a}`);
    L.push('');
  }
  const newAssets = eps.flatMap((e) => list(e.new_assets).map((a) => [e.episode || '', a]));
  if (newAssets.length) {
    L.push('## 這一批要新增的資產', '', '設定檔裡還沒有。拆到那一集之前補進 bible.json，並先生成資產圖。', '');
    L.push(table(['集數', '資產'], newAssets), '');
  }
  L.push('## 檢查結果', '', issueTable(), '');
  written.push(write('series.md', L.join('\n')));
  console.log(`分集表：${eps.length} 集，預估約 ${minSec(sum)}`);
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
    return `${ln.type || ''}${name && name !== ln.type ? ` ${name}` : ''}：「${rawPick(ln.text, langs[0])}」`; // 旁白的 who 也是「旁白」，不重複寫
  };
  // 後製的特效不進提示詞，要提醒剪接的人加；生成加後製的要提醒加強
  const fxLabel = ({ e, d }) => `${d.name || d.id}${e.state ? `（${e.state}）` : ''}${zhOf(e.pos) ? `，${zhOf(e.pos)}` : ''}`;
  // 剪接時要做的事：靜幀的推拉、變速與定格、後製的字與漫劇效果、後製的特效
  const postNote = (s) => [
    isStill(s) ? stillNote(s) : '',
    !isStill(s) && speedOf(s)?.post ? speedOf(s).post : '',
    zhOf(s.post),
    ...fxIn(s).filter((x) => isPost(x.d)).map((x) => `後製加特效：${fxLabel(x)}`),
    ...fxIn(s).filter((x) => x.d.make === '生成加後製').map((x) => `後製加強：${x.d.name || x.d.id}`),
  ].filter(Boolean).join('；');
  const note = (s) => [s.risk ? `風險：${s.risk}` : '', s.continuity ? `連戲：${s.continuity}` : '', postNote(s) ? `後製：${postNote(s)}` : ''].filter(Boolean).join('；');
  // 導演表的運鏡欄：「固定・升格」「緩慢推近（靜幀運鏡）」
  const camLabel = (s) => `${zhOf(s.camera)}${speedOf(s) ? `・${zhOf(s.speed)}` : ''}${isStill(s) ? `（${renderOf(s)}）` : ''}`;
  // 驗收重點：這一鏡生成出來先看哪幾件事。通用的項目（臉像不像設定圖、頭尾變形）見 references/generation-qa.md
  const earlierSetup = (s, i) => (s.setup ? shots.slice(0, i).filter((x) => x.setup === s.setup && x.link !== '接續').pop() : null);
  const focusOf = (s, i) => {
    const f = [];
    const cast = Array.isArray(s.cast) ? s.cast : [];
    const full = cast.filter((e) => !e.partial && chars.has(e.char));
    if (full.length >= 2) f.push(`人數正確，${full.length === 2 ? '兩人' : '每個人'}的髮色與服裝沒有互串`);
    const handy = cast.some((e) => {
      const h = chars.get(e.char);
      if (!h || !['人', '半人'].includes(kindOf(h.c))) return false;
      if (isPartialText(e)) return /手|hand/i.test(zhOf(e.partial) + pick(e.partial, 'en'));
      return !e.partial && !!e.hands && !langs.some((l) => NO_HANDS_RE.test(pick(e.hands, l)));
    });
    if (handy && !['大遠景', '遠景'].includes(spec(s).size)) f.push('手指數量，手上拿的東西沒有變形');
    if (cast.some((e) => langs.some((l) => SCREEN_RE.test(pick(e.pos, l))))) f.push('人物在畫面的左右位置和分鏡一致（軸線）');
    const prev = shots[i - 1];
    if (s.link === '接續' && prev) f.push(`起始畫面和 ${prev.id} 的結尾一致`);
    else {
      const ea = earlierSetup(s, i);
      if (ea) f.push(`背景與光線和 ${ea.id} 一致`);
      else if (s.setup && setups.has(s.setup)) f.push(`背景和 ${s.setup} 機位背景圖一致`);
    }
    if (isStill(s)) {
      if (renderOf(s) === '靜幀運鏡' && !isStatic(s)) f.push(`首幀圖四周留得夠寬，做完「${zhOf(s.camera)}」之後${full.length ? '臉和重點' : '主體'}沒有被裁掉`);
    } else {
      if (!isStatic(s)) f.push(`運鏡是「${zhOf(s.camera)}」，方向沒有反，人物沒有跟著大動`);
      if (speedOf(s)?.zh) f.push(`整段都是${speedOf(s).zh}，沒有忽快忽慢`);
      const speakerOnScreen = s.line?.text && s.line.type === '對白' && cast.some((e) => !e.partial && chars.get(e.char)?.c.id === chars.get(s.line.who)?.c.id);
      if (NATIVE_AUDIO && speakerOnScreen) f.push('台詞一字不差、嘴型對得上，聲線和這個角色前面的鏡頭一致，沒有自己加字幕或配樂');
      else if (speakerOnScreen) f.push('嘴唇閉合（口型之後另外做），頭部動作小');
      else if (s.line?.text && full.some((e) => ['人', '半人'].includes(kindOf(chars.get(e.char).c)))) f.push('嘴唇閉合，沒有自己在說話');
    }
    for (const { e, d } of fxGen(s)) f.push(`特效「${d.name || d.id}」的位置、顏色${e.state ? `與狀態（${e.state}）` : ''}正確`);
    if (s.risk) f.push('風險項見備註，不行就照備案換拍法');
    return f;
  };
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
  const stills = shots.filter(isStill).length;
  const split = stills ? `（影片 ${shots.length - stills} 鏡、靜幀 ${stills} 鏡）` : '';
  L.push(`共 ${shots.length} 鏡${split}，成片約 ${Math.round(total)} 秒${lenText ? `（單集長度 ${lenText}）` : ''}${P.aspect ? `，畫幅 ${P.aspect}（在生成工具裡選）` : ''}。設定表與資產提示詞見 settings.md。`, '');
  if (epPlan) {
    L.push('## 這一集要做到的事', '', '來自分集表（series.json）。前三秒要看到鉤子，最後一鏡停在卡點上。', '');
    L.push(table(['項目', '內容'], [
      ['一句話劇情', epPlan.logline || ''],
      ['鉤子', epPlan.hook || ''],
      ['爽點／核心事件', epPlan.payoff || ''],
      ['卡點', `${epPlan.cliff || ''}${epPlan.cliff_type ? `（${epPlan.cliff_type}）` : ''}`],
      ['結束時的狀態', epPlan.state || ''],
    ].filter((r) => r[1])), '');
  }
  if (Array.isArray(ep.changes) && ep.changes.length) {
    L.push('## 對原文的改動', '');
    for (const c of ep.changes) L.push(`- ${c}`);
    L.push('');
  }
  const shortId = (s) => String(s.id || '').replace(`${epId}-`, '');
  if (plans.length) {
    const anyBeat = shots.some((s) => beatOf(s) && !beatOf(s).bad);
    const anyBlocking = plans.some((p) => p.blocking);
    L.push('## 場次設計', '', `拆鏡的依據：每場戲要達成什麼、從誰的角度看、分成哪些節拍、高點在哪裡。${anyBeat ? '節拍後面是拍這個節拍的鏡頭，★ 是高點。' : ''}`, '');
    L.push(table(
      ['場次', '場景', '這場戲的目的', '視點', '節拍', '高點', ...(anyBlocking ? ['走位'] : []), '影像基調'],
      plans.map((p, i) => {
        const pid = planId(p, i);
        const pk = peakIndex(p);
        const beatCell = beatsOf(p).map((b, j) => {
          const ids = shots.filter((s) => { const x = beatOf(s); return x && !x.bad && x.pid === pid && x.idx === j; }).map(shortId);
          return `${j + 1}. ${b}${j === pk ? ' ★' : ''}${anyBeat ? `（${ids.join('、') || '沒有鏡頭'}）` : ''}`;
        }).join('<br>');
        return [p.id || i + 1, p.scene || '', p.purpose || '', chars.get(p.pov)?.c.name || p.pov || '', beatCell, p.peak || '', ...(anyBlocking ? [p.blocking || ''] : []), p.mood || ''];
      }),
    ), '');
  }
  if (setups.size) {
    const usedBy = (id) => shots.filter((s) => s.setup === id).map(shortId).join('、');
    L.push('## 機位', '', '同一場戲裡反覆使用的拍攝位置。同機位的鏡頭共用背景描述，首幀也可以從同機位的前一張首幀圖改出來。', '');
    L.push(table(
      ['機位', '場景', '鏡頭在哪裡、拍到什麼', '背景', '用到的鏡頭'],
      [...setups.values()].map((u) => [u.id, u.scene || '', u.desc || '', show(u.bg), usedBy(u.id) || '—']),
    ), '');
    L.push('## 機位背景圖', '', '每個機位先生成一張沒有人物的背景並定稿，當這個機位所有鏡頭的背景參考圖。場景定稿圖只有一個角度，反打的機位看到的牆不在那張圖裡；有了這張，第一次用到這個機位的鏡頭也有背景可以參照。', '');
    let lastH = '';
    for (const a of plateAssets) {
      const h = `### ${a.id}　${a.kind}`;
      if (h !== lastH) { L.push(h, ''); lastH = h; }
      if (langs.length > 1) L.push(T[a.lang].name, '');
      L.push(code(a.prompt), '');
    }
  }
  const linkText = (s) => `${s.link || ''}${s.transition ? `（${s.transition}）` : ''}`;
  // 節拍欄：「1.4 ★」表示第 1 場的第 4 個節拍，而且是高點
  const beatLabel = (s) => {
    const b = beatOf(s);
    if (!b || b.bad) return s.beat == null ? '' : String(s.beat);
    return `${b.pid}.${b.idx + 1}${b.idx === peakIndex(b.p) ? ' ★' : ''}`;
  };
  L.push('## 精簡表', '', '貼到對話裡用這一張。「累計」是播到這一鏡結束的時間；有 ✂ 的鏡頭後面適合切開。', '');
  L.push(table(
    ['鏡號', '秒', '累計', '景別', '動作', '對白／旁白', '切點'],
    shots.map((s, i) => [s.id, s.duration, tc(ends[i]), sizeLabel(s), zhOf(s.action), lineText(s), cutOf(s, i)]),
  ), '');
  if (cuts.length) {
    L.push('## 建議切點', '', '想切成較短的片段時，從這些位置挑。時間是播到該鏡結束的累計時間。', '');
    L.push(table(['切在', '累計', '理由'], cuts.map(({ s, i }) => [`${s.id} 之後`, tc(ends[i]), s.cut === true ? '' : s.cut])), '');
  }
  L.push('## 導演表', '');
  L.push(table(
    ['鏡號', '原文對應', '節拍', '場景', '機位', '角色', '秒', '累計', '景別', '運鏡', '銜接', '動作', '對白／旁白', '聲音', '備註', '切點'],
    shots.map((s, i) => [s.id, s.source || '', beatLabel(s), s.scene, s.setup || '—', who(s), s.duration, tc(ends[i]), sizeLabel(s, true), camLabel(s), linkText(s), zhOf(s.action), lineText(s), zhOf(s.sound), note(s), cutOf(s, i)]),
  ), '');
  L.push('## 各鏡生成資料', '');
  shots.forEach((s, i) => {
    L.push(`### ${s.id}`, '');
    for (const e of s.cast || []) {
      L.push(`- ${e.char}${e.partial ? '（局部入鏡）' : ''}　位置：${zhOf(e.pos) || '—'}｜視線：${zhOf(e.gaze) || '—'}｜手部／道具：${zhOf(e.hands) || '—'}${e.face ? `｜表情：${zhOf(e.face)}` : ''}`);
    }
    if (s.props) L.push(`- 場上道具：${zhOf(s.props)}`);
    for (const x of fxIn(s)) {
      const where = MAKES.includes(x.d.make) ? x.d.make : '生成';
      L.push(`- 特效 ${x.d.id}（${fxLabel(x)}）｜在哪裡做：${where}${isPost(x.d) ? '，不進提示詞，畫面上要替它留位置' : ''}`);
    }
    const su = s.setup ? setups.get(s.setup) : null;
    if (su) {
      // 同機位、而且是各自生成首幀的前一鏡：拿它的首幀圖來改，背景和光線最不會跑掉
      const earlier = earlierSetup(s, i);
      const tip = earlier && s.link !== '接續' ? `；${earlier.id} 用過這個機位，這一鏡的首幀可以拿它的首幀圖做圖像編輯，背景才會一致` : '';
      L.push(`- 機位：${su.id}${su.desc ? `（${su.desc}）` : ''}${tip}`);
    }
    if (s.bg) L.push(`- 看得到的背景：${zhOf(s.bg)}`);
    else if (su?.bg) L.push(`- 看得到的背景（來自機位）：${zhOf(su.bg)}`);
    if (s.light) L.push(`- 這一鏡的光線：${zhOf(s.light)}`);
    if (s.palette) L.push(`- 這一鏡的色彩：${zhOf(s.palette)}`);
    if (s.transition) L.push(`- 轉場（從上一鏡進來的方式，剪接時做）：${s.transition}`);
    if (isStill(s)) L.push(`- 生成方式：${stillNote(s)}。不跑影片，也不用尾幀`);
    else if (speedOf(s)?.zh) L.push(`- 速度：${zhOf(s.speed)}（影片提示詞寫了「${speedOf(s).zh}」）`);
    else if (speedOf(s)?.post) L.push(`- 速度：${speedOf(s).post}`);
    if (s.post) L.push(`- 後製：${zhOf(s.post)}`);
    if (s.line?.tone) L.push(`- 台詞語氣：${zhOf(s.line.tone)}`);
    const refs = refLabels(s);
    if (REF_MODE && s.link !== '接續' && refs.length) {
      L.push(`- 參考圖（依這個順序上傳，提示詞裡的「${refToken(1, langs[0]).replace(/1/, 'N')}」就是第 N 張）：${refs.map((r, k) => `${k + 1}. ${r}`).join('；')}`);
    } else if (!REF_MODE && refs.length) L.push(`- 參考圖：${refs.join('＋')}`);
    const g = isStill(s) ? undefined : genLength(Number(s.duration) || 0);
    if (g) L.push(`- 成片 ${s.duration} 秒，建議生成 ${g} 秒段再裁頭尾`);
    const focus = focusOf(s, i);
    if (focus.length) L.push(`- 驗收重點：${focus.join('；')}`);
    L.push('');
    for (const l of langs) {
      L.push(`首幀圖像提示詞${langLabel(l)}`, '', code(firstFrame(s, i, l)), '');
      if (USE_LAST && lastFramePrompt(s, l)) L.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`, '', code(lastFramePrompt(s, l)), '');
      if (!isStill(s)) L.push(`影片提示詞${langLabel(l)}`, '', code(videoPrompt(s, l)), '');
      if (pick(s.negative, l)) L.push(`這一鏡額外的負面詞${langLabel(l)}`, '', code(pick(s.negative, l)), '');
    }
  });
  L.push('## 檢查結果', '', issueTable(), '');
  written.push(write(`${epId}-storyboard.md`, L.join('\n')));

  const head = ['鏡號', '原文對應', '節拍', '場景', '機位', '角色', '成片秒數', '累計', '生成方式', '建議生成秒數', '景別', '鏡頭類型', '角度', '機位高度', '運鏡', '速度', '銜接', '轉場', '動作', '對白／旁白', '台詞語氣', '聲音', '建議切點'];
  for (const l of langs) {
    head.push(`首幀圖像提示詞${langLabel(l)}`);
    if (USE_LAST) head.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`);
    head.push(`影片提示詞${langLabel(l)}`, `負面詞${langLabel(l)}`);
  }
  head.push(REF_MODE ? '參考圖（依序上傳）' : '參考圖', '風險', '連戲備註', '後製', '驗收重點', '模型', 'seed', '抽卡次數', '採用版本', '驗收結果', '備註');
  const rows = shots.map((s, i) => {
    const sp = spec(s);
    const gen = isStill(s) ? '' : genLength(Number(s.duration) || 0) ?? '';
    const r = [s.id, s.source || '', beatLabel(s), s.scene, s.setup || '', who(s), s.duration, tc(ends[i]), renderOf(s), gen, sp.size || zhOf(s.size), sp.type, sp.angle || '', sp.height || '', zhOf(s.camera), zhOf(s.speed), s.link, s.transition || '', zhOf(s.action), lineText(s), zhOf(s.line?.tone), zhOf(s.sound), cutOf(s, i)];
    for (const l of langs) {
      r.push(firstFrame(s, i, l));
      if (USE_LAST) r.push(lastFramePrompt(s, l));
      r.push(videoPrompt(s, l), negativePrompt(s, l));
    }
    const refs = REF_MODE && s.link === '接續' ? [] : refLabels(s);
    r.push(REF_MODE ? refs.map((x, k) => `${k + 1}. ${x}`).join('；') : refs.join('＋'), s.risk || '', s.continuity || '', postNote(s), focusOf(s, i).join('；'), '', '', '', '', '', '');
    return r;
  });
  written.push(write(`${epId}-shots.csv`, csv([head, ...rows])));
  if (plateAssets.length) {
    written.push(write(`${epId}-assets.csv`, csv([
      ['編號', '類型', '語言', '提示詞', '模型', 'seed', '定稿檔名', '備註'],
      ...plateAssets.map((a) => [a.id, a.kind, T[a.lang].name, a.prompt, '', '', '', '']),
    ])));
  }

  console.log(`${epId}：${shots.length} 鏡，成片約 ${Math.round(total)} 秒`);
}

// ---------- 結果 ----------
if (scriptText != null) {
  const st = scriptStats;
  console.log(`${path.basename(second)}：${st.scenes} 場，畫面（△）${st.visuals} 行，台詞與旁白 ${st.lines} 句、約 ${Math.round(st.seconds)} 秒${lenText ? `（單集長度 ${lenText}）` : ''}，後製文字 ${st.texts} 處`);
  if (st.bySpeaker.size) console.log(`說話時間：${[...st.bySpeaker].map(([w, s]) => `${w} ${Math.round(s)} 秒`).join('、')}`);
}
if (written.length) {
  console.log('已寫出：');
  for (const p of written) console.log(`  ${p}`);
}
const count = (lv) => issues.filter((x) => x.level === lv).length;
console.log(`檢查：錯誤 ${count('錯誤')}、警告 ${count('警告')}、提示 ${count('提示')}`);
for (const x of issues) console.log(`  [${x.level}] ${x.where}：${x.msg}`);
process.exit(count('錯誤') ? 1 : 0);
