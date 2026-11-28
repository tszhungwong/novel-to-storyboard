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
 * 重跑時：CSV 裡使用者手填的欄位（模型、seed、驗收結果…）、自己加的欄位與沒有欄名的欄按鏡號搬到新檔，
 * 同一個鏡號的好幾列都保留；內容有變才把舊檔備份到 out/備份/；已經不在分鏡裡的鏡頭，紀錄移到 <檔名>-已移除.csv。
 * 分鏡檔的 episode 和檔名的集數對不上時不寫分鏡的產出，免得蓋掉別一集。
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
// 這一集的集數：沒填 episode 時先用檔名開頭的 EPxx（缺 episode 的錯誤在檢查分鏡時報）
const epFileId = ep && second ? ((/^EP\d+/i.exec(path.basename(second)) || [])[0] || '').toUpperCase() || null : null;
const epKey = ep ? String(ep.episode ?? '').trim() || epFileId : null;
const epPlan = ep && seriesForEp && Array.isArray(seriesForEp.episodes)
  ? seriesForEp.episodes.find((e) => e && e.episode === epKey) || null
  : null;
outDir = outDir || path.join(path.dirname(path.resolve(files[0])), 'out');
if (scriptText == null) fs.mkdirSync(outDir, { recursive: true });

// ---------- 問題收集 ----------
const issues = []; // {level: '錯誤'|'警告'|'提示', where, msg}
const report = (level, where, msg) => {
  if (!issues.some((x) => x.level === level && x.where === where && x.msg === msg)) issues.push({ level, where, msg });
};
const err = (where, msg) => report('錯誤', where, msg);
const warn = (where, msg) => report('警告', where, msg);
const hint = (where, msg) => report('提示', where, msg);

// ---------- 結構：清單寫成物件、裡面混了 null 或文字時，先報錯再略過，腳本才不會整個當掉 ----------
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
if (!isObj(bible)) {
  console.error(`設定檔的最外層要是 { … } 物件：${files[0]}`);
  process.exit(2);
}
/** owner[key] 應該是物件的清單。idKey 是每一筆的編號欄位（角色、場景是 id，cast 是 char）。 */
function normList(owner, key, where, idKey = 'id') {
  if (!isObj(owner) || owner[key] == null) return;
  let v = owner[key];
  if (!Array.isArray(v)) {
    if (isObj(v) && idKey in v) {
      err(where, `${key} 要寫成清單 [ { … } ]，目前是一個物件；這次當成只有一筆`);
      v = [v];
    } else if (isObj(v) && Object.values(v).length && Object.values(v).every(isObj)) {
      err(where, `${key} 要寫成清單 [ { … }, { … } ]，目前是以編號當鍵的物件；這次照順序讀成清單`);
      v = Object.entries(v).map(([k, x]) => (x[idKey] == null ? { [idKey]: k, ...x } : x));
    } else {
      err(where, `${key} 要寫成清單 [ { … } ]；目前的寫法讀不懂，這次略過`);
      v = [];
    }
  }
  const bad = v.filter((x) => !isObj(x)).length;
  if (bad) err(where, `${key} 裡有 ${bad} 筆不是 { … } 的資料（空值或文字），這次略過`);
  owner[key] = v.filter(isObj);
}
for (const k of ['characters', 'scenes', 'props', 'effects']) normList(bible, k, '設定檔');
for (const c of bible.characters || []) normList(c, 'variants', c.id || '角色');
if (isObj(secondJson) && !series) {
  for (const k of ['shots', 'plan', 'setups']) normList(secondJson, k, '分鏡檔');
  for (const s of secondJson.shots || []) normList(s, 'cast', s.id || '鏡頭', 'char');
}

// ---------- 專案參數 ----------
const P = isObj(bible.project) ? bible.project : {};
/** 打錯的值最接近哪一個認得的值（差一兩個字的才算）。 */
function closest(v, list) {
  const a = [...String(v)];
  let best = null;
  let bestD = Infinity;
  for (const w of list) {
    const b = [...w];
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (d[a.length][b.length] < bestD) { bestD = d[a.length][b.length]; best = w; }
  }
  return bestD <= 2 ? best : null;
}
// 這幾個參數打錯時會被默默當成預設值（原生音訊整個關掉、文生影片變成圖生影片），所以要說出來。
// 常見的簡體與別名直接認，並提示改成正式的寫法。
const AUDIO_PLANS = ['旁白', '後配口型', '原生音訊', '配樂'];
const AUDIO_ALIASES = { 原生音频: '原生音訊', 原生音頻: '原生音訊', 后配口型: '後配口型', 後期配音: '後配口型', 后期配音: '後配口型', 配乐: '配樂' };
if (P.audio_plan != null && !AUDIO_PLANS.includes(String(P.audio_plan).trim())) {
  const raw = String(P.audio_plan).trim();
  const fix = AUDIO_ALIASES[raw];
  if (fix) {
    hint('project.audio_plan', `audio_plan「${raw}」當成「${fix}」；請改成「${fix}」`);
    P.audio_plan = fix;
  } else {
    const near = closest(raw, AUDIO_PLANS);
    warn('project.audio_plan', `audio_plan「${raw}」不是 ${AUDIO_PLANS.join('、')} 其中一個${near ? `（是不是「${near}」？）` : ''}；腳本不認得它，原生音訊的台詞與聲音、後配口型的檢查都不會套用`);
  }
} else if (P.audio_plan != null) {
  P.audio_plan = String(P.audio_plan).trim();
}
const VIDEO_MODES = { i2v: 'i2v', t2v: 't2v', 圖生影片: 'i2v', 文生影片: 't2v', 'image-to-video': 'i2v', 'text-to-video': 't2v' };
let MODE = 'i2v';
if (P.video_mode != null) {
  const raw = String(P.video_mode).trim();
  const m = VIDEO_MODES[raw.toLowerCase()] || VIDEO_MODES[raw];
  if (m) MODE = m;
  else warn('project.video_mode', `video_mode「${raw}」請填 i2v（圖生影片）或 t2v（文生影片）；這次當成 i2v`);
  if (m && m !== raw) hint('project.video_mode', `video_mode「${raw}」當成「${m}」；請改成「${m}」`);
}
// 提示詞語言：["zh"]、["en"] 或 ["zh", "en"]。寫成字串或用了 zh-TW、English 這類寫法也照讀
const LANG_ALIASES = [[/^(zh|zh[-_].+|cn|chinese|中文|繁體中文|簡體中文)$/i, 'zh'], [/^(en|en[-_].+|english|英文)$/i, 'en']];
let langs = [];
if (P.prompt_langs != null) {
  const rawList = Array.isArray(P.prompt_langs) ? P.prompt_langs : String(P.prompt_langs).split(/[\s,，、]+/).filter(Boolean);
  if (!Array.isArray(P.prompt_langs)) hint('project.prompt_langs', `prompt_langs 要寫成清單，例如 ["zh"] 或 ["zh", "en"]；這次照「${P.prompt_langs}」讀`);
  const unknown = [];
  for (const x of rawList) {
    const hit = LANG_ALIASES.find(([re]) => re.test(String(x).trim()));
    if (!hit) unknown.push(x);
    else if (!langs.includes(hit[1])) langs.push(hit[1]);
    if (hit && String(x).trim() !== hit[1]) hint('project.prompt_langs', `prompt_langs 的「${x}」當成「${hit[1]}」；請改成「${hit[1]}」`);
  }
  if (unknown.length) warn('project.prompt_langs', `prompt_langs 只認得 zh 與 en，「${unknown.join('、')}」這次略過`);
}
if (!langs.length) langs = ['zh', 'en'];
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
// 參考圖怎麼寫進提示詞（ref_mode）：
// - 混合（預設）：外貌照文字完整寫，再在每個人、背景、道具後面標上「（參照圖1）」。掛了圖，工具知道哪張是誰；沒掛圖，文字也完整
// - 參考圖：外貌改成「圖1中的…」，長相交給參考圖；一定要照順序上傳，否則提示詞不完整
// - 文字：只寫文字、不標編號，給不能在提示詞裡用編號指稱參考圖的工具（Midjourney）
const REF_MODES = ['混合', '參考圖', '文字'];
const RM = REF_MODES.includes(P.ref_mode) ? P.ref_mode : '混合';
const REF_MODE = RM === '參考圖';
const REF_NUM = RM !== '文字'; // 提示詞裡有編號：參考圖要照分鏡表列的順序上傳
const REF_MAX = Number(P.ref_max) > 0 ? Number(P.ref_max) : 0; // 工具一次最多能掛幾張參考圖
// 寫在提示詞最後的工具參數：Midjourney 的畫幅、版本、負面詞都寫在提示詞裡（--ar 9:16 --no text）
const IMAGE_SUFFIX = String(P.image_suffix ?? "").trim().replace(/\{ar\}/g, P.aspect || '16:9'); // 每一鏡的首幀、尾幀與機位背景圖；{ar} 換成影片畫幅
const ASSET_SUFFIX = String(P.asset_suffix ?? "").trim(); // 角色設定圖、場景定稿圖、道具圖等資產
const withSuffix = (p, sfx) => (sfx && p ? `${p.trim()} ${sfx}` : p);
// 工具限制：使用者定了圖像或影片工具之後才填，只檢查那個工具確定做不好的事。沒填＝不套用任何工具限制，
// 提示詞照故事需要寫完整（快速的動作、畫面裡的字、複雜的運鏡、負面詞都不擋）
const TL = P.tool_limits && typeof P.tool_limits === 'object' && !Array.isArray(P.tool_limits) ? P.tool_limits : {};
const TOOL_SET = !!(String(P.image_tool || '').trim() || String(P.video_tool || '').trim());
const NO_TEXT = TL.text === false; // 工具寫不好畫面裡的字
const NO_FAST = TL.fast_motion === false; // 工具做不好快速、劇烈的動作
const NO_COMPLEX_CAM = TL.complex_camera === false; // 工具做不穩甩鏡、環繞、滑動變焦
const NO_NEGATIVE = TL.negative === false; // 工具沒有負面詞欄位
const TL_KEYS = { text: '畫面文字', fast_motion: '快速動作', complex_camera: '複雜運鏡', negative: '負面詞欄位' };
// 形式與媒材：形式決定節奏與聲音的預設，媒材決定資產圖是插畫設定圖還是真人定妝照
const FORMATS = ['漫劇', '短劇', '動畫', '真人劇', '影片'];
const FORMAT = P.format === '正式動畫' ? '動畫' : String(P.format || '').trim(); // 舊檔的「正式動畫」照收
const MEDIUMS = ['真人寫實', '2D 動畫', '3D 動畫', '漫畫'];
const PHOTO = String(P.medium || '').trim() === '真人寫實';
// 單集長度 [最短, 最長]（秒）：使用者或大綱指定了才有。不填就是一章一集、不設上限
const EP_LEN = Array.isArray(P.episode_length) && P.episode_length.length === 2 && P.episode_length.every((n) => Number(n) > 0)
  ? P.episode_length.map(Number).sort((a, b) => a - b)
  : null;
if (P.episode_length != null && !EP_LEN) {
  hint('project.episode_length', '要寫成 [最短, 最長] 的秒數，例如 [60, 90]；目前的寫法腳本讀不懂，不會檢查單集長度');
}
const SHORT_EP = !!EP_LEN && EP_LEN[1] <= 120; // 兩分鐘以內的短集不用標建議切點
if (P.ref_mode != null && !REF_MODES.includes(P.ref_mode)) {
  hint('project.ref_mode', `ref_mode 請填「混合」「參考圖」或「文字」；目前的「${P.ref_mode}」當成「混合」處理`);
}
if (P.ref_max != null && !REF_MAX) hint('project.ref_max', 'ref_max 要是大於 0 的整數（工具一次最多能掛幾張參考圖）；目前不檢查張數');
if (seriesReadError) hint('series.json', `bible.json 旁邊的 series.json 不是合法的 JSON，分鏡表不會列出這一集的鉤子與卡點：${seriesReadError}`);
if (FORMAT && !FORMATS.includes(FORMAT)) hint('project.format', `format 請填 ${FORMATS.join('、')} 其中一個；目前的「${P.format}」只顯示在設定表，不影響其他檢查`);
if (P.medium && !MEDIUMS.includes(String(P.medium).trim())) {
  hint('project.medium', `medium 請填 ${MEDIUMS.join('、')} 其中一個；目前的「${P.medium}」當成非寫實處理（資產圖用插畫式的設定圖，不是真人定妝照）`);
}
if (P.tool_limits != null && P.tool_limits !== TL) hint('project.tool_limits', 'tool_limits 要寫成物件，例如 {"text": false}；目前的寫法腳本讀不懂，不套用任何工具限制');
for (const k of Object.keys(TL)) {
  if (!TL_KEYS[k]) hint('project.tool_limits', `tool_limits 不認得「${k}」；認得的是 ${Object.keys(TL_KEYS).join('、')}`);
  else if (TL[k] !== false && TL[k] !== true) hint('project.tool_limits', `tool_limits.${k} 要填 true（做得到）或 false（做不好）`);
}
if (Object.keys(TL).length && !TOOL_SET) hint('project.tool_limits', '還沒填 image_tool 或 video_tool，卻填了 tool_limits；工具限制是照選定的工具填的，工具還沒定就拿掉');
if (TOOL_SET && P.tool_limits == null) {
  hint('project.tool_limits', '工具定了，還沒填 tool_limits：腳本不會檢查這個工具做不好的事（畫面文字、快速動作、複雜運鏡、負面詞）。照 references/tool-capabilities.md 填；查不到的項目先不填，生成一兩鏡測過再決定');
}
if (String(P.video_tool || '').trim() && !(Array.isArray(P.clip_lengths) || Array.isArray(P.clip_range))) {
  hint('project.clip_range', '影片工具定了，還沒填單次可生成的秒數（clip_range 或 clip_lengths）；不填就不會檢查鏡頭會不會太長，也算不出建議生成秒數');
}

// ---------- 文字工具 ----------
const T = {
  zh: {
    name: '中文',
    sep: '，',
    stop: '。',
    cam: (c) => (/^鏡頭/.test(c) ? c : `鏡頭${c}`),
    // 各家工具都以雙引號辨識台詞；語氣用敘述帶出（可靈、Seedance、Google 的官方範例都是這樣寫）
    // 聲線（voice）每一鏡都一樣，原生音訊才不會一鏡一個聲音；語氣（tone）是這一句的
    says: (who, text, lang, tone, voice) => {
      const how = [voice, tone ? `${tone}的語氣` : ''].filter(Boolean).join('、');
      return `${who}${how ? `以${how}` : ''}${lang ? `用${lang}` : ''}說：“${text}”`;
    },
    sound: (s) => `聲音：${s}`,
    lastFrame: (end, cam) =>
      `以這一鏡的首幀圖為底圖做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}${cam ? `。構圖依運鏡調整（${cam}）` : ''}`,
    // 運鏡改變取景時，圖像編輯會保持原本的畫布：推近要先裁切，拉遠與搖移要先擴圖
    lastFrameCrop: (end, cam) =>
      `以這一鏡的首幀圖為底圖：先照「${cam}」之後的取景裁切放大，保留原圖的細節，不要重新構圖；再做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}`,
    lastFrameWiden: (end, cam) =>
      `以這一鏡的首幀圖為底圖：先向四周擴圖，延伸出「${cam}」之後才看得到的畫面，原本的畫面內容與位置保持不變；再做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}`,
    lastFrameShift: (end, cam, dir) =>
      `以這一鏡的首幀圖為底圖：先向${{ 左: '左側', 右: '右側', 上: '上方', 下: '下方' }[dir]}擴圖，延伸出「${cam}」之後看到的畫面，再把取景移過去、裁成和首幀一樣的大小；接著做圖像編輯，沒有提到的部分保持不變。結束時的畫面：${end}`,
    noEnd: (cam) => `不出尾幀：「${cam}」會改變透視，圖像編輯做不出結束的畫面。只用首幀生成，結束的樣子已經寫進影片提示詞`,
    endsWith: (end) => `結束時：${end}`,
    // 沒有原生音訊時，不讓工具自己開口：後配口型的口型之後另外做，旁白與畫外音的鏡頭畫面裡的人不說話
    lipsDub: (who) => `${who}的嘴唇保持閉合、嘴不動（口型之後另外做）`,
    lipsShut: (n) => (n > 1 ? '畫面裡的人嘴唇自然閉合，沒有人說話' : '人物嘴唇自然閉合，沒有說話'),
    reuse: (id) => `沿用 ${id} 的最後一幀當首幀，不另外生成。`,
    sheet: (pose) => `角色設定圖，同一角色的${pose}，純淺灰背景，均勻柔光`,
    pose: '正面、四分之三側面、側面、背面全身四視圖，自然站姿，表情平靜',
    poseScale: '正面、四分之三側面、側面、背面全身四視圖，旁邊站著一個灰色的成年人剪影作為比例參考',
    face: '同一角色的頭部特寫，正面與四分之三側面並排，表情平靜，純淺灰背景，均勻柔光',
    group: (n, pose) => `群體角色設定圖，${n} 個人一組，${pose || `${n} 人並排站立的正面全身圖，另附其中一人的側面與背面全身圖，自然站姿，表情平靜`}，純淺灰背景，均勻柔光`,
    propEdit: (baseId, change) => `以 ${baseId} 的道具圖為底圖做圖像編輯，大小、材質與角度保持不變，改成：${change}`,
    fx: '特效參考圖，單獨呈現，置於畫面中央，純黑背景',
    variantEdit: (baseId, change) => `以 ${baseId} 的角色設定圖為底圖做圖像編輯，臉、髮型與體型保持不變，造型改成：${change}`,
    faces: (expr) => `同一角色的半身表情組圖，相同角度，表情依序是：${expr}，純淺灰背景，均勻柔光`,
    expr: '平靜、微笑、難過、生氣',
    states: (expr) => `同一角色的狀態組圖，相同角度，依序是：${expr}，純淺灰背景，均勻柔光`,
    master: '純場景空鏡，全景，平視',
    prop: '單一物件，置於畫面中央，純淺灰背景，均勻柔光',
    plate: '純背景空景，取景比這個機位的鏡頭略寬，前後景都清楚',
    // 參考圖模式：用工具的指稱語法（預設「圖1」）指出每樣東西參照哪一張圖
    refDefault: '圖{n}',
    refWho: (t, tag) => `${t}中的${tag}`,
    refTag: (t) => `（${t}）`,
    refPart: (t) => `（顏色與質感參照${t}）`,
    refFace: (t) => `（臉部參照${t}）`,
    refBg: (t, bg) => `背景參照${t}${bg ? `：${bg}` : ''}`,
    // 混合模式：文字照寫，後面標上參照哪一張
    refSee: (t) => `（參照${t}）`,
    refBgTag: (t) => `（背景參照${t}）`,
    refExpr: (t) => `（表情參照${t}）`,
    refFrame: (t) => `構圖與光線參照${t}`,
    refExtra: (t, label) => `另外參照${t}（${label}）`,
  },
  en: {
    name: 'English',
    sep: ', ',
    stop: '. ',
    cam: (c) => c,
    // voice 寫成名詞短語（a low, gravelly male voice），tone 寫說法（quietly、flatly）
    says: (who, text, lang, tone, voice) => `${who} says${lang ? ` in ${lang}` : ''}${voice ? `, in ${voice.replace(/^in\s+/i, '')}` : ''}${tone ? `, ${tone}` : ''}: "${text}"`,
    sound: (s) => `Audio: ${s}`,
    lastFrame: (end, cam) =>
      `Edit the first-frame image of this shot and keep everything not mentioned here unchanged. End state: ${end}${cam ? `. Adjust the framing for the camera move (${cam})` : ''}`,
    lastFrameCrop: (end, cam) =>
      `Crop and enlarge the first-frame image of this shot to the framing after the camera move (${cam}), keeping the original detail rather than recomposing; then edit it, keeping everything not mentioned here unchanged. End state: ${end}`,
    lastFrameWiden: (end, cam) =>
      `Outpaint the first-frame image of this shot on all sides to reveal what the camera sees after the move (${cam}), keeping the original content and its position unchanged; then edit it, keeping everything not mentioned here unchanged. End state: ${end}`,
    lastFrameShift: (end, cam, dir) =>
      `Outpaint the first-frame image of this shot to the ${{ 左: 'left', 右: 'right', 上: 'top', 下: 'bottom' }[dir]} to reveal what the camera sees after the move (${cam}), shift the framing there and crop back to the same size; then edit it, keeping everything not mentioned here unchanged. End state: ${end}`,
    noEnd: (cam) => `No end frame: the camera move (${cam}) changes the perspective, which image editing cannot produce. Generate from the first frame only; the end state is already in the video prompt`,
    endsWith: (end) => `at the end, ${end}`,
    lipsDub: (who) => `the lips of ${who} stay closed and still (lip sync is added later)`,
    lipsShut: (n) => (n > 1 ? 'everyone in frame keeps their lips closed, no one speaks' : 'lips stay closed, not speaking'),
    reuse: (id) => `Use the last frame of ${id} as the first frame.`,
    sheet: (pose) => `character reference sheet, the same character shown as ${pose}, plain light grey background, soft even lighting`,
    pose: 'front, three-quarter, side and back full-body views, natural standing pose, calm expression',
    poseScale: 'front, three-quarter, side and back full-body views, with a plain grey adult human silhouette standing beside it for scale',
    face: 'head close-up reference of the same character, front and three-quarter views side by side, neutral expression, plain light grey background, soft even lighting',
    group: (n, pose) => `group character sheet of ${n} people, ${pose || `the ${n} of them standing side by side in a front full-body view, plus side and back full-body views of one of them, natural standing pose, calm expression`}, plain light grey background, soft even lighting`,
    propEdit: (baseId, change) => `Edit the ${baseId} prop image: keep the size, materials and angle unchanged; change it to: ${change}`,
    fx: 'visual effect reference, shown on its own, centred in frame, plain black background',
    variantEdit: (baseId, change) => `Edit the ${baseId} character reference sheet: keep the face, hairstyle and build unchanged; change the look to: ${change}`,
    faces: (expr) => `expression sheet of the same character, bust view, same angle, expressions in order: ${expr}, plain light grey background, soft even lighting`,
    expr: 'calm, smiling, sad, angry',
    states: (expr) => `state sheet of the same character, same angle, in order: ${expr}, plain light grey background, soft even lighting`,
    master: 'scenery only, unoccupied, wide shot, eye level',
    prop: 'a single object centred in frame, plain light grey background, soft even lighting',
    plate: 'empty background plate, scenery only, unoccupied, framed slightly wider than the shot, everything in sharp focus',
    refDefault: 'image {n}',
    refWho: (t, tag) => `${tag} from ${t}`,
    refTag: (t) => ` (${t})`,
    refPart: (t) => ` (colours and textures as in ${t})`,
    refFace: (t) => ` (face as in ${t})`,
    refBg: (t, bg) => `background as in ${t}${bg ? `: ${bg}` : ''}`,
    refSee: (t) => ` (as in ${t})`,
    refBgTag: (t) => ` (background as in ${t})`,
    refExpr: (t) => ` (expression as in ${t})`,
    refFrame: (t) => `composition and lighting as in ${t}`,
    refExtra: (t, label) => `also see ${t} (${label})`,
  },
};
// 真人寫實：資產圖是攝影棚的定妝照與實景照片，不是插畫的設定圖；否則寫實的鏡頭會掛著一張插畫當參考
if (PHOTO) {
  Object.assign(T.zh, {
    sheet: (pose, person = true) => `${person ? '角色定妝照，同一位演員的' : '角色參考照，同一角色的'}${pose}，純灰色攝影棚背景，柔和均勻的棚拍光`,
    pose: '正面、四分之三側面、側面、背面全身照，自然站姿，表情平靜',
    poseScale: '正面、四分之三側面、側面、背面全身照，旁邊站著一個灰色的成年人剪影作為比例參考',
    face: '同一位演員的頭像特寫照，正面與四分之三側面並排，表情平靜，純灰色攝影棚背景，柔和均勻的棚拍光',
    group: (n, pose) => `群體定妝照，${n} 位演員一組，${pose || `${n} 人並排站立的正面全身照，另附其中一人的側面與背面全身照，自然站姿`}，純灰色攝影棚背景，柔和均勻的棚拍光`,
    propEdit: (baseId, change) => `以 ${baseId} 的道具照為底圖做圖像編輯，大小、材質與角度保持不變，改成：${change}`,
    variantEdit: (baseId, change) => `以 ${baseId} 的定妝照為底圖做圖像編輯，臉、髮型與體型保持不變，造型改成：${change}`,
    faces: (expr) => `同一位演員的胸像表情測試照，相同角度，表情依序是：${expr}，純灰色攝影棚背景，柔和均勻的棚拍光`,
    states: (expr) => `同一角色的狀態參考照，相同角度，依序是：${expr}，純灰色攝影棚背景，柔和均勻的棚拍光`,
    master: '實景勘景照，純場景空鏡，全景，平視',
    prop: '單一物件的靜物攝影，置於畫面中央，純灰色背景，柔和均勻的光',
    plate: '純背景空景照片，取景比這個機位的鏡頭略寬，前後景都清楚',
  });
  Object.assign(T.en, {
    sheet: (pose, person = true) => `${person ? 'costume and makeup test photos of the same actor' : 'reference photos of the same character'}, ${pose}, plain grey studio backdrop, soft even studio lighting`,
    pose: 'front, three-quarter, side and back full-body photos, natural standing pose, neutral expression',
    poseScale: 'front, three-quarter, side and back full-body photos, with a plain grey adult human silhouette standing beside it for scale',
    face: 'headshots of the same actor, front and three-quarter views side by side, neutral expression, plain grey studio backdrop, soft even studio lighting',
    group: (n, pose) => `group costume test photos of ${n} actors, ${pose || `the ${n} of them standing side by side in a front full-body shot, plus side and back full-body photos of one of them, natural standing pose`}, plain grey studio backdrop, soft even studio lighting`,
    propEdit: (baseId, change) => `Edit the ${baseId} prop photo: keep the size, materials and angle unchanged; change it to: ${change}`,
    variantEdit: (baseId, change) => `Edit the ${baseId} costume test photos: keep the face, hairstyle and build unchanged; change the look to: ${change}`,
    faces: (expr) => `expression test photos of the same actor, head and shoulders, same angle, expressions in order: ${expr}, plain grey studio backdrop, soft even studio lighting`,
    states: (expr) => `state reference photos of the same character, same angle, in order: ${expr}, plain grey studio backdrop, soft even studio lighting`,
    master: 'location scouting photo, scenery only, unoccupied, wide shot, eye level',
    prop: 'still-life photo of a single object centred in frame, plain grey background, soft even lighting',
    plate: 'empty background plate photo, scenery only, unoccupied, framed slightly wider than the shot, everything in sharp focus',
  });
}
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
  // 用離地的高度寫，不用「腰部」「頭頂」：機位背景圖沒有人，寫到身體部位容易把人叫出來
  地面: { zh: '機位貼近地面', en: 'ground-level camera' },
  低機位: { zh: '低機位，離地約一公尺', en: 'low camera height, about one metre off the ground' },
  眼睛高度: { zh: '機位離地約一點六公尺', en: 'camera about 1.6 metres off the ground' },
  高機位: { zh: '高機位，離地約三公尺', en: 'high camera position, about three metres off the ground' },
};
// 焦段（lens）：廣角把空間拉開、長焦把前後景壓在一起。真人寫實最有用，動畫也可以用
const LENSES = {
  超廣角: { zh: '超廣角鏡頭，約 16mm', en: 'ultra-wide 16mm lens' },
  廣角: { zh: '廣角鏡頭，約 24mm', en: 'wide-angle 24mm lens' },
  小廣角: { zh: '35mm 鏡頭', en: '35mm lens' },
  標準: { zh: '標準鏡頭，約 50mm', en: 'standard 50mm lens' },
  中長焦: { zh: '中長焦鏡頭，約 85mm', en: '85mm lens' },
  長焦: { zh: '長焦鏡頭，約 135mm', en: '135mm telephoto lens' },
  微距: { zh: '微距鏡頭', en: 'macro lens' },
  魚眼: { zh: '魚眼鏡頭', en: 'fisheye lens' },
};
// 速度（speed）：前三種寫進影片提示詞；變速與定格是剪接時做的，只寫進後製備註
const SPEEDS = {
  升格: { zh: '慢動作', en: 'slow motion' },
  降格: { zh: '快動作', en: 'fast motion' },
  縮時: { zh: '縮時攝影', en: 'time-lapse' },
  變速: { post: '變速：照正常速度生成，剪接時在動作的關鍵處放慢再恢復' },
  定格: { post: '定格：最後一幀停住，停的時間算在成片秒數裡' },
};
// 人物朝向（cast[].facing）：身體與臉朝哪裡。左右指臉朝向畫面的哪一邊；正反打的兩個人方向相反
const FACINGS = {
  正面: { zh: '正面朝向鏡頭', en: 'facing the camera', dir: '' },
  半側朝左: { zh: '半側面朝畫面左', en: 'three-quarter view, facing frame left', dir: '左' },
  半側朝右: { zh: '半側面朝畫面右', en: 'three-quarter view, facing frame right', dir: '右' },
  側面朝左: { zh: '正側面朝畫面左', en: 'in profile, facing frame left', dir: '左' },
  側面朝右: { zh: '正側面朝畫面右', en: 'in profile, facing frame right', dir: '右' },
  背面: { zh: '背對鏡頭', en: 'seen from behind', dir: '' },
};
// face 只寫了一個情緒詞：工具會給一張標準的「難過臉」，寫成看得見的眉、眼、嘴才有表演
const ABSTRACT_FACE_RE = /^(神情|表情|臉色|面色|神色)?(很|非常|有點|有些|略微|略顯|十分|一臉)?(難過|悲傷|傷心|生氣|憤怒|開心|高興|快樂|害怕|恐懼|驚訝|吃驚|緊張|焦慮|尷尬|心虛|失望|絕望|平靜|溫柔|冷漠|害羞|疲憊|痛苦|興奮|得意|委屈)(的樣子|的表情|的神情)?$|^(very |a bit |slightly )?(sad|angry|happy|scared|afraid|surprised|nervous|anxious|embarrassed|calm|tired|shy|upset|worried)( expression| look| face)?$/i;
// 表情欄位裡夾著情緒詞：「神情恭敬」「一臉得意」「表情嚴肅」，英文是一開頭就寫 respectful、smug 這類形容詞
const MOODS = '難過|悲傷|傷心|生氣|憤怒|開心|高興|快樂|害怕|恐懼|驚訝|吃驚|緊張|焦慮|尷尬|心虛|失望|絕望|平靜|溫柔|冷漠|害羞|疲憊|痛苦|興奮|得意|委屈|恭敬|不屑|輕蔑|冷淡|嚴肅|堅定|專注|慌張|錯愕|無奈|欣慰|驕傲|輕鬆|認真|陰沉|和善|謙卑|淡定';
const FACE_MOOD_RE = new RegExp(`(神情|表情|神色|臉色|面色|一臉|滿臉)(很|非常|有點|有些|略微|略顯|十分)?(${MOODS})|^(very |slightly |a bit )?(respectful|smug|arrogant|serious|determined|confident|worried|nervous|calm|sad|angry|happy|proud|polite|stern|cold)(,|$| expression| look)`, 'i');
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
    // 有那個狀態自己的道具圖就指向它，否則指向原本的道具圖
    const key = st && tok && tok.has(`${id}:${st.trim()}`) ? `${id}:${st.trim()}` : id;
    return tok && tok.has(key) ? desc + T[l].refTag(tok.get(key)) : desc;
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
  return { size, type: type || '單人', angle: zhOf(shot.angle), height: zhOf(shot.height), lens: zhOf(shot.lens), legacy };
}
const speedOf = (s) => (s.speed ? SPEEDS[zhOf(s.speed)] || null : null);
const speedTerm = (s, l) => speedOf(s)?.[l] || '';
const renderOf = (s) => (RENDERS.includes(s.render) ? s.render : '影片');
const isStill = (s) => renderOf(s) !== '影片';
/** 有沒有完整入鏡的人物（不是背影、前景虛焦或只露一部分）。 */
const hasFullCast = (shot) => (shot.cast || []).some((e) => !e.partial);
/** 有完整入鏡、而且是人的身體（人或半人）的角色。 */
const hasBodyCast = (shot) => (shot.cast || []).some((e) => !e.partial && ['人', '半人'].includes(kindOf(chars.get(e.char)?.c || {})));
/** 「平視」配上眼睛高度以外的機位高度：提示詞裡的 eye-level 會被讀成眼睛的高度，和「貼近地面」打架，所以不寫。 */
const levelWithHeight = (angle, height) => angle === '平視' && !!height && height !== '眼睛高度';
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
  if (sp.angle && !levelWithHeight(sp.angle, sp.height)) parts.push(ANGLES[sp.angle] ? ANGLES[sp.angle][l] : pick(shot.angle, l));
  if (sp.height) parts.push(HEIGHTS[sp.height] ? HEIGHTS[sp.height][l] : pick(shot.height, l));
  if (sp.lens) parts.push(LENSES[sp.lens] ? LENSES[sp.lens][l] : pick(shot.lens, l));
  if (withFrame) parts.push(pick(shot.frame, l));
  return joinC(parts, l);
}
/** 表格顯示用：「過肩・近景（低機位・微俯）」。 */
function sizeLabel(shot, withAngle = false) {
  const sp = spec(shot);
  const s = [sp.type !== '單人' ? sp.type : '', sp.size].filter(Boolean).join('・') || zhOf(shot.size);
  const extra = [sp.height && sp.height !== '眼睛高度' ? sp.height : '', sp.angle && sp.angle !== '平視' ? sp.angle : '', sp.lens].filter(Boolean).join('・');
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

const REF_RE = /同上|同前(?:一鏡|一張|一個|面|述)|如前(?:所述|一鏡|面)|跟上一鏡一樣|same as above|as before|as above/i;
const TEXT_RE = /寫著|寫有|字樣|上面的字|that (says|reads)|text reading|with the words/i;
const SCREEN_RE = /畫面(的)?[左右]|鏡頭(的)?[左右]|螢幕[左右]|screen[- ](left|right)|frame[- ](left|right)|(left|right) of (the )?(frame|screen)/i;
const FAST_RE = /快速|迅速|急速|猛烈|劇烈|猛地|猛然|瞬間|飛快|狂奔|飛撲|暴衝|大幅|爆發|炸開|爆炸|噴發|\b(rapid(ly)?|violent(ly)?|sudden(ly)?|quick(ly)?|fast|dramatic(ally)?|bursts?|lunges?|dash(es)?|sprints?|slams?|whips?|explod(e|es|ing)|explosions?|erupts?)\b/i;
// 看起來是文字或數字的特效：工具寫不好，應該後製
const FX_TEXT_RE = /數字|文字|字樣|[大小]字|篆|進度條|\b(digits?|numbers?|text|letters?|words?)\b/i;
const SLOW_RE = /緩慢|慢慢|緩緩|慢速|\bslow(ly)?\b/i;
// 替後製留位置時說出空白是給什麼的：「給後製的數字」寫進提示詞，工具會試著把數字畫出來
// 配樂是畫外聲，只有觀眾聽得到；寫進 sound，原生音訊時會被當成畫內的聲音生成出來
const MUSIC_RE = /配樂|背景音樂|BGM|\b(background music|score|soundtrack)\b/i;
// 連戲備註寫了道具被收走或拿出來：這個變化要拍到，或寫進 motion、end，只寫在備註裡生成時不會發生
const PROP_MOVE_RE = /收走|收起|收進|拿走|拿起|拿出|抽出|放回|放下|塞進|不見了|畫面外|\b(off[- ]screen|pocket(s|ed)?|put away|picks? up|taken away)\b/i;
// 暖光配上以冷色為主的 palette：同一句提示詞裡會打架
const WARM_LIGHT_RE = /暖|燭|燈籠|爐火|火光|夕陽|鎢絲|琥珀|橘黃|\b(warm|amber|candle\w*|lantern\w*|firelight|tungsten|golden)\b/i;
// 暖色系的色相：光是哪一種暖色，palette 或場景的光裡有沒有同一種。
// 暗紅的燈籠光配「點綴色是暗紅」相容；暖橘的風燈光配「褪色紅漆點綴」就不相容，橘色在 palette 裡沒有位置
const WARM_FAMILIES = {
  warm: /暖|\bwarm\w*/i,
  red: /紅|\b(red|crimson|scarlet|vermilion)\b/i,
  orange: /橘|橙|琥珀|\b(orange|amber)\b/i,
  yellow: /黃|金|\b(yellow|gold\w*|honey)\b/i,
};
const warmFamilies = (text) => Object.keys(WARM_FAMILIES).filter((k) => WARM_FAMILIES[k].test(text));
const WARM_COLOR_LIGHT_RE = /(暖|紅|橘|橙|琥珀|黃|金)[色黃紅橘]?的?(燈|燭|火)?光|\b(warm|red|orange|amber|yellow|golden)(-\w+)?\s+(\w+\s+)?(light|glow)\b/i;
/** 光的第一句是主光：「天花板的日光燈照下，保溫架透出一小片暖黃」的主光是冷的，暖黃只是陪襯。 */
const keyLight = (text) => String(text || '').split(/[，,；;。]/)[0];
/** palette 說「以冷色為主」：說明主色的那一句只有冷色、沒有暖色（「暗紅與青黑為主」是混色，不算）。 */
function coolDominant(text) {
  for (const clause of String(text || '').split(/[，,。.;；]/)) {
    if (!/為主|主導|主色|^\s*以|dominat|mostly|predominant/i.test(clause)) continue;
    const cool = /冷|藍|青|\b(cool|cold|blue|teal|grey-blue|blue-grey|slate)\b/i.test(clause);
    const warm = /暖|紅|橘|橙|金|黃|琥珀|赭|\b(warm|red|orange|gold\w*|amber|ochre|vermilion|yellow)\b/i.test(clause);
    if (cool && !warm) return true;
  }
  return false;
}
const POST_WORD_RE = /後製|後期|字幕|花字|\b(post[- ]?production|in post|captions?|subtitles?)\b/i;
// 工具寫不好字時，連「數字」「文字」也不要寫：工具會試著畫出來，而且畫得亂
const TEXT_WORD_RE = /數字|文字|\b(on-screen text|digits?)\b/i;
// 冷暖與主色：寫在風格鎖定句裡會加到每一張圖，夜戲、回憶、換了光線的鏡頭就會和光線打架
const HUE_RE = /[暖冷](色|調|光|[黃橘紅棕藍白灰青])|偏[青藍橘黃紅綠紫金暖冷]|[紅橙橘黃綠青藍紫金棕褐]色?[調系]|為主的.{0,4}色調|\b(warm|cool|cold)(er)?\b|\b(teal|amber|orange|golden|blue|red|green|purple|pink|yellow)(-\w+)?\b[^,]{0,25}\b(tones?|palette|tints?|cast|shadows?|grading|accents?)\b/i;
// 人與人身上的東西：寫進場景或機位的描述，會跑進沒有人物的場景定稿圖與機位背景圖
// 用身體部位說位置（「頭頂一線夜空」「腰部高度」）：沒有人的場景圖裡，工具可能把它讀成人的頭頂、腰
const BODY_POS_RE = /頭頂|腰部|齊腰|及腰高/;
const PERSON_RE = /臉|人物|人影|他的|她的|頭髮|肩膀|眼睛|身上|身後|身前|女子|男子|女人|男人|老人|少女|少年|孩子|\b(face|faces|his|her|hair|shoulders?|eyes|figure|person|people|man|woman|girl|boy)\b/i;
// 字面上有人、其實是地方或東西的詞：男子宿舍、洗臉台、老人院、hair dryer
const PERSON_OK_RE = /(男子|女子)(宿舍|學校|學院|中學|高中|監獄|浴室|廁所|更衣室|會館|會所)|洗臉[台檯盆]?|臉盆|老人(院|中心|之家|會)|少年(宮|院|隊)|\bhair[- ]?(dryers?|salons?|dresser'?s?)\b/gi;
// motion 裡寫到臉上的變化：眉、眼、嘴、笑、表情
const MOTION_FACE_RE = /眉|眼|嘴|唇|笑|表情|神情|視線|目光|咬|瞪|瞇|吞嚥|淚|\b(face|brows?|eyes?|mouth|lips?|smil\w*|frown\w*|jaw|grin\w*|wince\w*|squint\w*|blink\w*|swallow\w*|tears?|gaze\w*|glanc\w*)\b/i;
// 41：說話的人臉沒朝鏡頭、嘴被擋住：後配口型時對不上嘴型
const TURNED_RE = /回頭|轉頭|轉身|低頭|垂下頭|鞠躬|彎腰|背對|埋頭|\b(turn(s|ing|ed)? (away|around|back)|bow(s|ing|ed)?|looks? down|head down|back to)\b/i;
// 42：end 寫的是和首幀一樣的狀態，尾幀和首幀就一樣
const END_SAME_RE = /仍然|仍舊|依舊|依然|保持不變|又放回|放回原處|回到原位|\b(remains?|unchanged|stays the same)\b/i;
// 43：首幀的欄位寫了先後兩個動作，靜態的一張圖畫不出來
const SEQ_RE = /先[^。；;]{1,16}再|然後|接著|隨後|動了一下|\b(then|before|twitch(es|ing)?)\b/i;
// 44：光源的名詞。機位看不到它，光卻寫成從它照過來，工具會把它畫進背景
const LIGHT_SOURCES = ['窗', '門', '吊燈', '檯燈', '壁燈', '路燈', '燈籠', '燭', '爐', '螢幕', '電視', '招牌', '霓虹', '天窗', 'window', 'door', 'lamp', 'chandelier', 'candle', 'fireplace', 'screen', 'neon', 'streetlight', 'lantern'];
const sourcesIn = (text) => LIGHT_SOURCES.filter((w) => (/^[a-z]/.test(w) ? new RegExp(`\\b${w}`, 'i').test(text) : text.includes(w)));
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
    const stray = [...new Set([...s.matchAll(/\{[^{}\n]{0,40}\}/g)].map((m) => m[0]))]
      .filter((x) => !/^\{[PF][0-9A-Za-z_-]*(?:[:：][^{}]+?)?\}$/.test(x) && !/^\{(n|ar)\}$/.test(x));
    if (stray.length) warn(where, `有沒換掉的 ${stray.join('、')}，會原樣進提示詞；道具寫成 {P01}、特效寫成 {F01}（大寫的 P 或 F 加編號），有狀態寫成 {P01:拆開}，冒號後面要有狀態名稱`);
    if (unknown) err(where, `用了設定檔裡沒有的道具或特效編號，或沒有登記的狀態：${[...new Set(unknown)].join('、')}`);
    for (const m of rawPick(v, l).matchAll(PROP_RE)) {
      const d = m[1][0] === 'F' ? fxDefs.get(m[1]) : null;
      if (d && isPost(d)) warn(where, `${m[1]}（${d.name || '特效'}）是後製做的特效，不要寫進提示詞；在畫面上替它留位置，並寫在 post`);
    }
    if (REF_RE.test(s)) warn(where, '用了「同上／如前」之類的指代；每一鏡都要能單獨看懂，請直接寫出內容');
    if (NO_TEXT && TEXT_RE.test(s)) warn(where, '看起來要求畫面出現可讀文字；選定的工具寫不好字（tool_limits.text 是 false），請改成後製加字');
  }
}

/** 片段裡有沒有寫到人：人稱、身體部位，或任何角色的短稱。回傳碰到的字，沒有就回傳空字串。 */
function mentionsPerson(v) {
  for (const l of langs) {
    const s = pick(v, l).replace(PERSON_OK_RE, '');
    if (!s) continue;
    const m = PERSON_RE.exec(s);
    if (m) return m[0];
    for (const { c, vs } of charList) {
      for (const t of [pick(c.tag, l), ...vs.map((x) => pick(x.tag, l))]) if (t && s.toLowerCase().includes(t.toLowerCase())) return t;
    }
  }
  return '';
}

/** 動作裡有沒有寫到某個角色的名字或短稱：cast 是空的鏡頭，提示詞不會寫出那個角色。 */
function mentionsCharacter(vals) {
  for (const l of langs) {
    for (const v of vals) {
      const s = pick(v, l).toLowerCase();
      if (!s) continue;
      for (const { c, vs } of charList) {
        for (const tg of [c.name, pick(c.tag, l), ...vs.map((x) => pick(x.tag, l))]) if (tg && s.includes(String(tg).toLowerCase())) return tg;
      }
    }
  }
  return '';
}
// 分鏡檔各層認得的欄位。寫錯名字或放錯層的欄位腳本不會用，寫在裡面的內容也不會進提示詞
const EP_KEYS = ['episode', 'source_title', 'changes', 'plan', 'setups', 'shots'];
const PLAN_KEYS = ['id', 'scene', 'purpose', 'pov', 'beats', 'peak', 'blocking', 'mood'];
const SETUP_KEYS = ['id', 'scene', 'desc', 'bg', 'light', 'detail'];
const SHOT_KEYS = ['id', 'scene', 'beat', 'source', 'duration', 'setup', 'size', 'type', 'angle', 'height', 'lens', 'camera', 'speed', 'render', 'link', 'transition', 'action', 'line', 'sound', 'music', 'cast', 'props', 'fx', 'bg', 'light', 'palette', 'frame', 'end', 'last_frame', 'motion', 'refs', 'negative', 'risk', 'continuity', 'post', 'cut'];
const CAST_KEYS = ['char', 'facing', 'pos', 'gaze', 'hands', 'face', 'partial'];
/** 不認得的欄位。名稱以 _ 開頭的當成給人看的備註，不檢查。 */
function checkKeys(where, obj, known, level = 'shot') {
  for (const k of Object.keys(obj)) {
    if (known.includes(k) || /^(_|\/\/|\$)/.test(k)) continue;
    const near = closest(k, known);
    const misplaced = level === 'shot' && CAST_KEYS.includes(k) ? `；${k} 是 cast 裡每個人的欄位，要寫在 cast 的那個人底下` : near ? `（是不是「${near}」？）` : '';
    warn(where, `不認得「${k}」這個欄位${misplaced}；腳本不會用它，寫在裡面的內容不會進提示詞。給自己看的備註，欄位名稱前面加底線（_note）`);
  }
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
// 頭身比寫在風格鎖定句，會跟著進道具圖和空景背景圖；具體的比例寫在人類角色的 look
if (langs.some((l) => /頭身|heads?[- ]tall/i.test(pick(P.style_lock, l)))) {
  warn('project.style_lock', '風格鎖定句寫了頭身比（「約七頭身」）；它會加到道具圖和沒有人的背景圖。風格鎖定句只寫「寫實比例」「Q 版比例」這類說法，具體的頭身比寫在每個人類角色的 look');
}
// 皮膚、臉寫在風格鎖定句：它也會加到道具圖與沒有人的空景，工具可能因此多畫一個人
{
  const skin = langs.map((l) => /膚|毛孔|臉|五官|\b(skin|pores?|faces?|complexion)\b/i.exec(pick(P.style_lock, l))?.[0]).find(Boolean);
  if (skin) warn('project.style_lock', `風格鎖定句寫到了「${skin}」；它會加到道具圖和沒有人的背景圖，寫到皮膚或臉可能多出一個人。膚質寫在角色的 detail，風格鎖定句只留媒材、質感、顆粒與飽和度`);
}
checkFrag('project.ref_syntax', P.ref_syntax);
checkFrag('project.negative_global', P.negative_global);
if (NO_NEGATIVE && langs.some((l) => pick(P.negative_global, l))) {
  warn('project.negative_global', '選定的工具沒有負面詞欄位（tool_limits.negative 是 false），通用負面詞用不到；清空它，要避開的東西改寫成正面描述（「空蕩的街道」，不寫「沒有人」）');
}
checkFrag('project.speech_lang', P.speech_lang);
checkFrag('project.audio_suffix', P.audio_suffix);
checkFrag('project.video_suffix', P.video_suffix);
for (const p of propDefs.values()) {
  checkFrag(`${p.id}.desc`, p.desc, true);
  checkPropPhrase(`${p.id}.desc`, p.desc, false);
  checkFrag(`${p.id}.detail`, p.detail); // 只進道具圖，不代入句子，所以沒有逗號與長度限制
  for (const [k, sv] of Object.entries(p.states && typeof p.states === 'object' ? p.states : {})) {
    checkFrag(`${p.id}.states.${k}`, sv, true);
    checkPropPhrase(`${p.id}.states.${k}`, sv, true);
  }
}
for (const f of fxDefs.values()) {
  checkFrag(`${f.id}.desc`, f.desc, true);
  checkFrag(`${f.id}.motion`, f.motion);
  checkFrag(`${f.id}.light`, f.light);
  checkFrag(`${f.id}.detail`, f.detail); // 只進特效參考圖，不進鏡頭
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
  if (NO_FAST && langs.some((l) => FAST_RE.test(pick(f.motion, l)))) {
    warn(`${f.id}.motion`, '特效的動態用了「爆發／炸開／瞬間」這類字眼，選定的工具做不好快速的動作（tool_limits.fast_motion 是 false）；寫成慢慢擴散、漂浮、明暗起伏，快速的爆發留給後製，或用閃白和反應鏡頭代替');
  }
  const texts = [f.desc, ...Object.values(f.states || {})];
  if (NO_TEXT && !isPost(f) && langs.some((l) => texts.some((t) => FX_TEXT_RE.test(pick(t, l))))) {
    warn(f.id, '這個特效看起來包含數字或文字，選定的工具寫不好字（tool_limits.text 是 false）；make 改成「後製」，或把文字的部分拆成另一個後製特效');
  }
}

// 角色類型：非人角色不一定穿衣服，也不一定有人的表情
const KINDS = ['人', '半人', '動物', '器物', '異獸'];
const NONHUMAN = new Set(['動物', '器物', '異獸']);
const kindOf = (c) => (KINDS.includes(c.kind) ? c.kind : '人');
// 形態（造型變體）可以有自己的 look 與 tag：人形與原形長得完全不一樣
const lookOf = (c, v, l) => pick(v?.look, l) || pick(c.look, l);
const tagOf = (c, v, l) => pick(v?.tag, l) || pick(c.tag, l);
// 聲線：形態可以有自己的（狐妖的原形和人形聲音不同），沒有就用角色的
const voiceOf = (c, v, l) => pick(v?.voice, l) || pick(c.voice, l);
// 群體角色：一個編號代表一群長得差不多的人（「兩個蒙面黑衣人」），group 是人數。設定圖要畫成一群，不是「同一角色」
const groupOf = (c) => (Number.isInteger(Number(c.group)) && Number(c.group) >= 2 ? Number(c.group) : 0);
const PLURAL_RE = /^(兩|二|三|四|五|六|七|八|九|十|幾|數)(個|名|位)|^一(群|隊|排|夥)|^(two|three|four|five|six|several|a (group|pair|crowd|gang) of)\b/i;
// 頭像：人與半人的臉部特寫參考。全身設定圖裡臉太小，近景以內的鏡頭靠這一張
const hasFace = (c, v) => ['人', '半人'].includes(kindOf(c)) && !groupOf(c) && !rawPick(v?.look, langs[0]);

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
    checkFrag(`${v.id}.voice`, v.voice);
    checkFrag(`${v.id}.detail`, v.detail);
    if (v.look && !v.tag) warn(v.id, '這個形態有自己的 look，卻沒有自己的 tag；影片提示詞會用第一個形態的短稱指它，指到的樣子不對');
  }
  checkFrag(`${c.id}.look`, c.look, true);
  checkFrag(`${c.id}.marks`, c.marks);
  checkFrag(`${c.id}.expressions`, c.expressions);
  checkFrag(`${c.id}.voice`, c.voice);
  checkFrag(`${c.id}.stature`, c.stature);
  checkFrag(`${c.id}.detail`, c.detail);
  if (!c.tag) warn(`${c.id}.tag`, '缺少短稱（tag）；影片提示詞要用它來指這個角色');
  else checkFrag(`${c.id}.tag`, c.tag);
  if (c.group != null && !groupOf(c)) hint(c.id, `group 是這一群的人數，要填 2 以上的整數；目前的「${c.group}」當成單一角色處理`);
  if (!groupOf(c) && langs.some((l) => PLURAL_RE.test(pick(c.tag, l)))) {
    hint(c.id, `短稱「${zhOf(c.tag)}」是一群人，卻沒有填 group（人數）；設定圖會畫成「同一角色」的一個人。填 "group": 2 這樣的人數`);
  }
  if (NONHUMAN.has(kind) && !c.minor && !c.expressions) {
    hint(c.id, `${kind}角色沒有寫 expressions，預設的「平靜、微笑、難過、生氣」不適用，所以不產出表情組圖；寫成這個角色會用到的狀態（耳朵往後貼、尾巴膨起、燈光變亮），或設 minor`);
  }
}
// 身高寫成相對的（比某某高一個頭）：設定圖和沒有那個人的鏡頭也會寫到他，工具可能多畫一個人
for (const { c } of charList) {
  for (const l of langs) {
    const st = pick(c.stature, l);
    if (!st) continue;
    const other = charList.map((x) => x.c).filter((o) => o.id !== c.id).flatMap((o) => [tagOf(o, null, l), ...(o.variants || []).map((v) => pick(v.tag, l))]).find((t) => t && st.includes(t));
    if (other) { warn(`${c.id}.stature`, `身高提到了「${other}」；角色設定圖和沒有那個人的鏡頭也會寫到他，工具可能多畫一個人。只寫絕對身高（「身高約一百八十公分」），同框時腳本會把每個人的身高一起寫進去`); break; }
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
  checkFrag(`${s.id}.detail`, s.detail);
  for (const k of ['space', 'light']) {
    const hit = mentionsPerson(s[k]);
    if (hit) warn(`${s.id}.${k}`, `場景的 ${k} 寫到了人（「${hit}」）；它會進到沒有人物的場景定稿圖，也會進每一鏡。人身上的光寫在各鏡的 light，人在哪裡寫在 pos`);
  }
  {
    const w = langs.map((l) => [s.space, s.light, s.detail].map((v) => BODY_POS_RE.exec(pick(v, l))?.[0]).find(Boolean)).find(Boolean);
    if (w) hint(s.id, `場景描述用「${w}」說位置；場景定稿圖和每一鏡的背景都沒有固定的人，工具可能讀成人的${w}而多畫一個人。改寫成「上方」「天花板」「屋簷下」「離地約一公尺」`);
  }
  const detailHit = mentionsPerson(s.detail);
  if (detailHit) warn(`${s.id}.detail`, `場景的 detail 寫到了人（「${detailHit}」）；它會進到沒有人物的場景定稿圖，工具會多畫一個人。detail 只寫陳設、材質與磨損`);
  if (langs.some((l) => WARM_LIGHT_RE.test(pick(s.light, l)) && coolDominant(pick(s.palette, l)))) {
    hint(`${s.id}.palette`, '場景的光是暖光，palette 卻以冷色為主，這個場景每一鏡的提示詞都會打架；palette 改成只寫暗部偏什麼色、點綴色是什麼，和所有光都相容');
  }
  if (langs.some((l) => SCREEN_RE.test(pick(s.space, l)))) {
    warn(`${s.id}.space`, '場景描述用了「畫面左／右」；換個角度拍就會錯，請改寫成空間關係（例如「窗在沙發對面」），畫面位置留給每一鏡的 pos');
  }
}

// 機位（分鏡檔的 setups）：同一場戲裡反覆使用的拍攝位置。背景寫一次，同機位的鏡頭共用
const setups = new Map();
for (const u of (ep && Array.isArray(ep.setups) ? ep.setups : [])) {
  checkKeys(u.id || '機位', u, SETUP_KEYS, 'setup');
  if (!u.id) { err('setups', '有機位缺少 id'); continue; }
  if (setups.has(u.id)) err(u.id, '機位編號重複');
  setups.set(u.id, u);
  if (!scenes.has(u.scene)) err(u.id, `機位的場景編號 ${u.scene ?? '（空）'} 不在設定檔裡`);
  if (!u.desc) warn(u.id, '機位缺少 desc（鏡頭在哪裡、朝哪裡拍、拍到誰的正面）；沒有它就看不出軸線有沒有守住');
  checkFrag(`${u.id}.bg`, u.bg, true);
  checkFrag(`${u.id}.light`, u.light);
  checkFrag(`${u.id}.detail`, u.detail);
  if (!u.light && scenes.has(u.scene)) {
    const sc = scenes.get(u.scene);
    const unseen = langs.flatMap((l) => sourcesIn(pick(sc.light, l)).filter((w) => !new RegExp(w, 'i').test(`${pick(u.bg, l)} ${pick(u.detail, l)}`)));
    if (unseen.length) hint(u.id, `這個機位的背景看不到「${[...new Set(unseen)].join('、')}」，用的卻是場景的光（「${zhOf(sc.light)}」）；機位背景圖和這個機位的鏡頭都會照這句畫，工具可能在背景補出它。替這個機位寫自己的 light：只寫看得到的光，或寫成光從畫面外照進來`);
  }
  for (const k of ['bg', 'light', 'detail']) {
    const hit = mentionsPerson(u[k]);
    if (hit) warn(`${u.id}.${k}`, `機位的 ${k} 寫到了人（「${hit}」）；它會進到沒有人物的機位背景圖。機位只寫從這個位置看到的空間與光，人身上的光寫在各鏡的 light`);
    const w = langs.map((l) => BODY_POS_RE.exec(pick(u[k], l))?.[0]).find(Boolean);
    if (w && !hit) hint(`${u.id}.${k}`, `機位的 ${k} 用「${w}」說位置；機位背景圖沒有人，工具可能讀成人的${w}而多畫一個人。改寫成「上方」「天花板」「離地約一公尺」`);
  }
}

// ---------- 提示詞組合 ----------
const isPartialText = (e) => e.partial && e.partial !== true;
/** 這一鏡要不要寫身高：兩個以上完整入鏡的角色，而且景別寬到看得到身體（中景以外）。 */
/**
 * 這個人在這一鏡看得到身體：完整入鏡的人；或是中全景以上的寬鏡頭裡，用 partial 寫的背影與局部人物。
 * 群像的遠景常把配角寫成 partial（「矮壯的蒙面人跨進門」），他們其實全身入鏡，身高一樣要寫。
 */
const bodyShown = (entry, shot) => chars.has(entry.char) && (!entry.partial || (SIZE_RANK[spec(shot).size] ?? Infinity) <= SIZE_RANK['中全景']);
const showStature = (shot) => (shot.cast || []).filter((e) => bodyShown(e, shot)).length >= 2
  && (SIZE_RANK[spec(shot).size] ?? Infinity) <= SIZE_RANK['中景'];
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
  // 兩個人以上同框、而且看得到身體時才寫身高，生成工具才不會把所有人畫得一樣高
  const tall = bodyShown(entry, shot) && showStature(shot) ? pick(c.stature, l) : '';
  let base;
  // 只入鏡一部分：直接寫看得到的那一部分。參考圖只借顏色與質感，免得工具照整張設定圖畫出整個人
  const ft = tok && !entry.partial ? tok.get(`face:${c.id}`) : null;
  if (isPartialText(entry)) base = [strip(pick(entry.partial, l, tok)) + (t ? T[l].refPart(t) : ''), tall];
  else if (t && REF_MODE) base = [T[l].refWho(t, tagOf(c, v, l) || lookOf(c, v, l)) + (ft ? T[l].refFace(ft) : ''), tall];
  else if (entry.partial === true) base = [tagOf(c, v, l) + (t ? T[l].refSee(t) : ''), tall, outfit]; // 背影、前景虛焦：不寫臉部細節與狀態
  else {
    // 混合模式：參照標在外貌的第一句後面（「五十歲左右的男性（參照圖2），國字臉⋯」），一看就知道整個人對應哪一張，不會像只在說最後那一句
    const parts = strip(lookOf(c, v, l)).split(l === 'en' ? /,\s*/ : '，');
    if (t || ft) parts[0] += (t ? T[l].refSee(t) : '') + (ft ? T[l].refFace(ft) : '');
    base = [parts.join(T[l].sep), tall, outfit, pick(v.state, l), pick(c.marks, l)];
  }
  const facing = isPartialText(entry) ? '' : (FACINGS[zhOf(entry.facing)]?.[l] || pick(entry.facing, l));
  // 表情：有表情組圖的指稱就接在後面；中景以內看得清楚臉，表情提前到朝向後面，排在最後容易被工具忽略
  const et = tok && !entry.partial ? tok.get(`expr:${c.id}`) : null;
  const face = joinC([strip(pick(entry.face, l, tok)) + (et ? T[l].refExpr(et) : '')], l);
  const faceFirst = UPPER_BODY.has(spec(shot).size);
  const block = withBlocking
    ? (faceFirst
      ? [facing, face, pick(entry.pos, l, tok), pick(entry.gaze, l, tok), pick(entry.hands, l, tok)]
      : [facing, pick(entry.pos, l, tok), pick(entry.gaze, l, tok), pick(entry.hands, l, tok), face])
    : [];
  return joinC([...base, ...block], l);
}
const setupOf = (shot) => (shot.setup ? setups.get(shot.setup) : null) || {};
/** 光線：這一鏡的 light → 機位的 light → 場景的光線；場景的時間與天氣（time）不管光有沒有覆寫都接在後面，熄了燈還是深夜、還在下雨。 */
const lightOf = (shot, sc, l) => joinC([pick(shot.light, l) || pick(setupOf(shot).light, l) || pick(sc.light, l), pick(sc.time, l)], l);
/** 色彩：這一鏡的 palette → 場景的 palette。冷暖與主色放這裡，不放風格鎖定句。 */
const paletteOf = (shot, sc, l) => pick(shot.palette, l) || pick(sc.palette, l);
/** 背景：這一鏡的 bg → 機位的 bg → 整段場景描述（只適合全景以上）。參考圖模式下註明參照哪一張背景圖。 */
function bgOf(shot, sc, l, tok = null) {
  const b = pick(shot.bg, l, tok) || pick(setupOf(shot).bg, l, tok) || pick(sc.space, l, tok);
  if (!tok || !tok.has('bg')) return b;
  return REF_MODE ? T[l].refBg(tok.get('bg'), strip(b)) : strip(b) + T[l].refBgTag(tok.get('bg'));
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
  // 近景以內臉夠大，再掛這個角色的頭像：全身設定圖裡的臉太小，撐不起特寫
  const close = CLOSE.has(spec(s).size) && spec(s).type !== '插入';
  for (const e of s.cast || []) {
    const h = chars.get(e.char);
    if (!h) continue;
    add(h.v.id, `${h.v.id} 設定圖`);
    if (close && !e.partial && hasFace(h.c, h.v)) add(`face:${h.c.id}`, `${h.c.id} 頭像`);
  }
  if (s.setup && setups.has(s.setup)) add('bg', `${s.setup} 機位背景圖`);
  else if (scenes.has(s.scene)) add('bg', `${s.scene} 場景定稿圖`);
  const frags = [s.props, s.bg, s.frame, ...(s.cast || []).flatMap((e) => [e.pos, e.gaze, e.hands, e.face, isPartialText(e) ? e.partial : null])];
  for (const f of frags) {
    for (const m of rawPick(f, langs[0]).matchAll(PROP_RE)) {
      if (m[1][0] !== 'P' || !propDefs.has(m[1])) continue;
      const st = (m[2] || '').trim();
      // 有登記的狀態有自己的道具圖（由原圖改出來的）
      if (st && hasState(propDefs.get(m[1]), st)) add(`${m[1]}:${st}`, `${m[1]} 道具圖・${st}`);
      else add(m[1], `${m[1]} 道具圖`);
    }
  }
  for (const { e, d } of fxGen(s)) add(d.id, `${d.id} 特效參考圖${e.state ? `・${e.state}` : ''}`);
  for (const r of userRefs(s)) add(userRefKey(r, s), r);
  return out;
}
/** refs 裡使用者自己寫的圖要怎麼在提示詞裡指稱。 */
function userRefKey(label, s) {
  const m = /^(C\d+)(?:-[0-9A-Za-z]+)?\s*(表情組圖|頭像)/.exec(label);
  const inShot = m && (s.cast || []).some((e) => chars.get(e.char)?.c.id === m[1]);
  if (m && inShot) return `${m[2] === '頭像' ? 'face' : 'expr'}:${m[1]}`;
  const v = /^(C\d+-[0-9A-Za-z]+)\s*設定圖/.exec(label);
  if (v && chars.has(v[1])) return v[1];
  if (/首幀|尾幀|最後一幀|last frame|first frame/i.test(label)) return 'frame';
  return `extra:${label}`;
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
/** 參考圖的指稱表：key → 「圖2」。文字模式回傳 null，提示詞不標編號。 */
function refTokens(s, l) {
  if (!REF_NUM) return null;
  const tok = new Map();
  refPlan(s).forEach((r, i) => { if (r.key && !tok.has(r.key)) tok.set(r.key, refToken(i + 1, l)); });
  return tok;
}
/**
 * 給人看的參考圖清單。兩種模式都由腳本列出角色設定圖、背景圖、道具圖、特效參考圖，refs 只寫額外的；
 * 參考圖模式要照這個順序上傳，文字模式是一份不要漏掛的清單。
 */
function refLabels(s) {
  if (!REF_NUM && s.link === '接續') return (Array.isArray(s.refs) ? s.refs : []).map(String); // 首幀沿用上一鏡，不另外生成
  return refPlan(s).map((r) => r.label);
}

/** 入鏡的人排序：完整入鏡的主體在前，背影、前景虛焦、局部入鏡的在後；工具先讀到的才是這一鏡的主角。 */
const castInOrder = (shot) => [...(shot.cast || [])].sort((a, b) => (a.partial ? 1 : 0) - (b.partial ? 1 : 0));
/** 過肩鏡頭先寫景別與鏡頭類型：不然第一句是前景虛焦的後腦勺，工具會把它當成主體。 */
const framingFirst = (shot) => spec(shot).type === '過肩';
function imagePrompt(shot, l) {
  const sc = scenes.get(shot.scene) || {};
  const tok = refTokens(shot, l);
  const subs = castInOrder(shot).map((e) => subject(e, shot, l, true, tok));
  const lead = framingFirst(shot);
  return withSuffix(joinS([
    lead ? framing(shot, l) : '',
    ...subs,
    pick(shot.props, l, tok),
    ...fxLooks(shot, l, tok),
    bgOf(shot, sc, l, tok),
    joinC([lightOf(shot, sc, l), ...fxLights(shot, l), paletteOf(shot, sc, l)], l),
    tok && tok.has('frame') ? T[l].refFrame(tok.get('frame')) : '',
    lead ? '' : framing(shot, l),
    joinC(tok ? [...tok].filter(([k]) => k.startsWith('extra:')).map(([k, v]) => T[l].refExtra(v, k.slice(6))) : [], l),
    pick(P.style_lock, l),
  ], l), IMAGE_SUFFIX);
}
function camTerm(shot, l) {
  const c = parseCam(shot);
  if (c.custom) return pick(shot.camera, l);
  if (l === 'en') return [...c.pre.map((p) => MOVE_PREFIX[p]), c.def.en].join(' ');
  return c.pre.join('') + c.def.zh;
}
// 運鏡改變取景時，尾幀不能只靠圖像編輯「調整構圖」：編輯模型保持原本的畫布
const END_CROP = new Set(['推近', '變焦推近']);
const END_WIDEN = new Set(['拉遠', '變焦拉遠']);
const END_SHIFT = { 左搖: '左', 左移: '左', 右搖: '右', 右移: '右', 上搖: '上', 下搖: '下' };
const END_NONE = new Set(['上升', '下降', '跟拍', '左環繞', '右環繞', '滑動變焦', '搖臂上升', '搖臂下降', '航拍前進', '航拍上升', '左甩', '右甩', '升降', '環繞', '搖臂', '航拍', '甩鏡']);
/** 這一鏡的尾幀怎麼做：off＝不用尾幀；none＝運鏡改變透視、做不出來；crop／widen／shift＝先裁切或擴圖；edit＝直接圖像編輯。 */
function endMode(shot) {
  if (!USE_LAST || shot.last_frame === false || isStill(shot) || !rawPick(shot.end, langs[0])) return 'off';
  if (isStatic(shot)) return 'edit';
  const c = parseCam(shot);
  if (c.custom) return 'edit';
  if (END_NONE.has(c.base)) return 'none';
  if (END_CROP.has(c.base)) return 'crop';
  if (END_WIDEN.has(c.base)) return 'widen';
  if (END_SHIFT[c.base]) return 'shift';
  return 'edit';
}
const hasEndFrame = (shot) => ['edit', 'crop', 'widen', 'shift'].includes(endMode(shot));
const noEndNote = (shot, l) => (endMode(shot) === 'none' ? T[l].noEnd(camTerm(shot, l)) : '');
function lastFramePrompt(shot, l) {
  let end = strip(pick(shot.end, l));
  if (!hasEndFrame(shot)) return '';
  // 尾幀把特效換到另一個狀態（{F02:半開}）時，那個狀態的發光也要寫進去，否則下一鏡的首幀會突然亮起來
  const glow = [];
  for (const m of rawPick(shot.end, langs[0]).matchAll(PROP_RE)) {
    const d = m[1][0] === 'F' ? fxDefs.get(m[1]) : null;
    if (!d || isPost(d) || !m[2]) continue;
    const g = fxField({ state: m[2].trim() }, d, 'light', l);
    const now = fxIn(shot).find((x) => x.d.id === d.id);
    if (g && g !== (now ? fxField(now.e, d, 'light', l) : '')) glow.push(g);
  }
  end = joinC([end, ...glow], l);
  const mode = endMode(shot);
  const cam = isStatic(shot) ? '' : camTerm(shot, l);
  const text = mode === 'crop' ? T[l].lastFrameCrop(end, cam)
    : mode === 'widen' ? T[l].lastFrameWiden(end, cam)
      : mode === 'shift' ? T[l].lastFrameShift(end, cam, END_SHIFT[parseCam(shot).base])
        : T[l].lastFrame(end, cam);
  return withSuffix(text + T[l].stop.trim(), IMAGE_SUFFIX);
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
    const voice = hit ? voiceOf(hit.c, (inShot || hit).v, l) : '';
    out.push(T[l].says(who, strip(pick(ln.text, langs[0])), pick(P.speech_lang, l), strip(pick(ln.tone, l)), strip(voice)));
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
/**
 * 嘴：沒有原生音訊、這一鏡又有台詞時，影片工具常讓畫面裡的人自己開口。
 * 後配口型而說話的人正面入鏡：他的嘴唇保持閉合，口型之後用對口型工具做；其他情況（旁白、畫外音、說話的人背對鏡頭）：畫面裡的人都不說話。
 */
function mouthNote(shot, l) {
  if (NATIVE_AUDIO || !(isObj(shot.line) && shot.line.text)) return '';
  const people = (shot.cast || []).filter((e) => !e.partial && ['人', '半人'].includes(kindOf(chars.get(e.char)?.c || {})));
  if (!people.length) return '';
  const speakerId = shot.line.type === '對白' ? chars.get(shot.line.who)?.c.id : null;
  const sp = speakerId ? people.find((e) => chars.get(e.char)?.c.id === speakerId) : null;
  if (sp && P.audio_plan === '後配口型') {
    const h = chars.get(sp.char);
    return T[l].lipsDub(tagOf(h.c, h.v, l));
  }
  return T[l].lipsShut(people.length);
}
function videoPrompt(shot, l) {
  if (isStill(shot)) return '';
  const cam = joinC([T[l].cam(camTerm(shot, l)), speedTerm(shot, l)], l);
  if (MODE === 'i2v') {
    // 圖生影片：首幀圖已經決定了外貌與場景，這裡只寫「怎麼動」
    const ends = endMode(shot) === 'none' && pick(shot.end, l) ? T[l].endsWith(strip(pick(shot.end, l))) : '';
    return joinS([pick(shot.motion, l), ...fxMotions(shot, l), ends, mouthNote(shot, l), cam, pick(P.video_suffix, l), ...audioParts(shot, l)], l);
  }
  // 文字生影片：影片工具自己掛參考圖，參考圖模式的指稱寫在這裡
  const sc = scenes.get(shot.scene) || {};
  const tok = refTokens(shot, l);
  const subs = castInOrder(shot).map((e) => subject(e, shot, l, true, tok));
  return joinS([
    ...subs,
    pick(shot.props, l, tok),
    ...fxLooks(shot, l, tok),
    pick(shot.motion, l),
    ...fxMotions(shot, l),
    endMode(shot) === 'none' && pick(shot.end, l) ? T[l].endsWith(strip(pick(shot.end, l))) : '',
    mouthNote(shot, l),
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
// detail：只進資產圖（設定圖、場景定稿圖、機位背景圖、道具圖）的細節，不進鏡頭提示詞。
// 鏡頭的片段要精簡（每多一個細節就多一個做錯的地方），參考圖卻要看得出做工、材質與磨損，兩者分開寫。
// 角色的 detail 寫的是第一個形態的身體；有自己 look 的形態（原形）長得不一樣，只用形態自己的 detail
const charDetail = (c, v, l) => (pick(v?.look, l) ? '' : pick(c.detail, l));
// 頭像與表情組圖用不到的身體描述：手、指甲、腳、腰、身形、身高
const BODY_ONLY_RE = /手|指甲|手指|指節|腳|腿|腰|臀|膝|身形|身材|體型|身高|個子|胸|手臂|\b(hands?|fingers?|nails?|knuckles?|arms?|legs?|feet|waist|hips?|build|tall|height|chest)\b/i;
const headOnly = (text, l) => (text ? text.split(l === 'en' ? /,\s*/ : '，').filter((x) => !BODY_ONLY_RE.test(x)).join(T[l].sep) : text);
// 每類資產圖的建議畫幅：設定圖與組圖要橫幅才放得下並排的幾個角度，道具與特效方形，機位背景圖跟影片一樣
const AR = { sheet: '16:9', face: '3:2', set: '16:9', master: '16:9', prop: '1:1', fx: '1:1', plate: P.aspect || '16:9' };
for (const { c, vs } of charList) {
  const kind = kindOf(c);
  const n = groupOf(c);
  vs.forEach((v, i) => {
    for (const l of langs) {
      if (i > 0 && !pick(v.sheet, l) && !pick(v.look, l)) {
        // 第二個以後的造型：從第一個造型的設定圖改，臉才不會變
        const change = joinC([pick(v.outfit, l), pick(v.state, l), pick(v.detail, l)], l);
        assets.push({ id: v.id, kind: `設定圖（由 ${vs[0].id} 改）`, lang: l, ar: AR.sheet, prompt: T[l].variantEdit(vs[0].id, change) + T[l].stop.trim() });
      } else {
        // 第一個造型，或有自己 look 的形態（原形和人形長得不一樣，不能從人形改）
        const who = joinC([lookOf(c, v, l), pick(c.stature, l), pick(v.outfit, l), pick(v.state, l), pick(c.marks, l), charDetail(c, v, l), pick(v.detail, l)], l);
        const pose = pick(v.sheet, l) || (kind === '異獸' ? T[l].poseScale : T[l].pose);
        const sheet = n ? T[l].group(n, pick(v.sheet, l)) : T[l].sheet(pose, ['人', '半人'].includes(kind) && !pick(v.look, l));
        assets.push({ id: v.id, kind: '設定圖', lang: l, ar: AR.sheet, prompt: joinS([who, sheet, pick(P.style_lock, l)], l) });
      }
    }
  });
  // 頭像與表情組圖都用第一個造型的上半身服裝；外貌、記號與細節裡講手、身形、身高的句子拿掉，
  // 不然工具會把手畫到臉旁邊，或為了身形把畫面拉遠
  const v0 = vs[0];
  const bust = (l) => joinC([headOnly(lookOf(c, v0, l), l), pick(v0.outfit_top, l) || pick(v0.outfit, l), headOnly(pick(c.marks, l), l), headOnly(charDetail(c, v0, l), l)], l);
  if (!c.minor && !n && !NONHUMAN.has(kind) && !c.expressions) {
    hint(c.id, `${c.name || c.id} 沒有寫 expressions，表情組圖會用預設的「平靜、微笑、難過、生氣」，不一定是這個角色會有的表情。照原文寫三四個這個角色會出現的表情，寫成看得見的眉、眼、嘴（「眉頭微皺、嘴唇抿緊」），見 references/prompt-writing.md 的情緒對照表`);
  }
  if (hasFace(c, v0)) {
    for (const l of langs) assets.push({ id: c.id, kind: '頭像', lang: l, ar: AR.face, prompt: joinS([bust(l), T[l].face, pick(P.style_lock, l)], l) });
  }
  if (!c.minor && !n && !(NONHUMAN.has(kind) && !c.expressions)) {
    for (const l of langs) {
      // 非人角色沒有「半身」，表情也多半是耳朵、尾巴、光這類狀態
      const sheet = NONHUMAN.has(kind) ? T[l].states(pick(c.expressions, l)) : T[l].faces(pick(c.expressions, l) || T[l].expr);
      assets.push({ id: c.id, kind: '表情組圖', lang: l, ar: AR.set, prompt: joinS([bust(l), sheet, pick(P.style_lock, l)], l) });
    }
  }
}
for (const s of scenes.values()) {
  for (const l of langs) {
    assets.push({
      id: s.id, kind: '場景定稿圖', lang: l, ar: AR.master,
      prompt: joinS([joinC([pick(s.space, l), pick(s.detail, l)], l), joinC([pick(s.light, l), pick(s.time, l), pick(s.palette, l)], l), T[l].master, pick(P.style_lock, l)], l),
    });
  }
}
/**
 * 機位背景圖要清楚。bg 是替鏡頭寫的，常帶著景深（「背景虛化」「softly out of focus」）；照抄進背景圖，參考圖本身就是糊的，
 * 用它的鏡頭也跟著糊。背景圖的提示詞拿掉這些字眼，也拿掉開頭的「背景是」（背景圖整張就是背景）。
 */
function plateBg(text, l) {
  if (!text) return text;
  if (l === 'en') {
    return text.split(/,\s*/).map((c) => c.replace(/\b(?:out-of-focus|blurred|blurry|defocused)\s+/gi, '').trim())
      .filter((c) => c && !/^(?:(?:softly|slightly|gently)\s+)?(?:out of focus|blurred|blurry|defocused)$|^(?:shallow depth of field|bokeh)$/i.test(c)).join(', ');
  }
  return text.split('，').map((c) => c.replace(/^背景是/, '').replace(/(?:略為|微微|稍微|輕微)?(?:虛化|虛焦|失焦|模糊)的/g, '').trim())
    .filter((c) => c && !/^(?:背景)?(?:略為|微微|稍微|輕微)?(?:虛化|虛焦|失焦|模糊)$|^淺景深$/.test(c)).join('，');
}
// 機位背景圖：每個機位一張沒有人物的背景。場景定稿圖只有一個角度，反打機位看到的牆不在那張圖裡，
// 第一次用到這個機位的鏡頭就沒有背景可以參照。這些是這一集的資產，寫在分鏡表與 <集數>-assets.csv
const plateAssets = [];
for (const u of setups.values()) {
  const sc = scenes.get(u.scene) || {};
  const used = (ep && Array.isArray(ep.shots) ? ep.shots : []).filter((s) => s.setup === u.id);
  const heights = [...new Set(used.map((s) => spec(s).height))];
  const hgt = heights.length === 1 && HEIGHTS[heights[0]] ? HEIGHTS[heights[0]] : null; // 這個機位的鏡頭都同一個高度時才寫
  const angles = [...new Set(used.map((s) => spec(s).angle || '平視'))];
  const ang = angles.length === 1 && ANGLES[angles[0]] && !(hgt && levelWithHeight(angles[0], heights[0])) ? ANGLES[angles[0]] : null; // 角度也一樣
  // 焦段也一樣：鏡頭是 85mm、背景圖卻沒寫，景深與透視就對不上
  const lensShots = [...new Map(used.filter((s) => spec(s).lens).map((s) => [spec(s).lens, s])).values()];
  const oneLens = lensShots.length === 1 && used.every((s) => spec(s).lens) ? lensShots[0] : null;
  const lensOf = (l) => (!oneLens ? '' : LENSES[spec(oneLens).lens]?.[l] || pick(oneLens.lens, l));
  for (const l of langs) {
    const light = joinC([pick(u.light, l) || pick(sc.light, l), pick(sc.time, l)], l);
    plateAssets.push({
      id: u.id, kind: '機位背景圖', lang: l, ar: AR.plate,
      prompt: joinS([joinC([plateBg(pick(u.bg, l), l), pick(u.detail, l)], l), joinC([light, pick(sc.palette, l)], l), joinC([T[l].plate, ang ? ang[l] : '', hgt ? hgt[l] : '', lensOf(l)], l), pick(P.style_lock, l)], l),
    });
  }
  if (ep && !used.length) hint(u.id, '沒有任何鏡頭用到這個機位；用不到就刪掉，免得多生成一張背景圖');
}
if (ep && Array.isArray(ep.shots)) {
  const thin = new Set();
  for (const s of ep.shots) {
    for (const e of s.cast || []) {
      const hit = chars.get(e.char);
      if (hit && !langs.some((l) => charDetail(hit.c, hit.v, l) || pick(hit.v.detail, l))) thin.add(hit.v.id);
    }
    const sc = scenes.get(s.scene);
    if (sc && !langs.some((l) => pick(sc.detail, l))) thin.add(sc.id);
    for (const m of JSON.stringify(s).matchAll(/\{(P\d+)/g)) {
      const p = propDefs.get(m[1]);
      if (p && !langs.some((l) => pick(p.detail, l))) thin.add(p.id);
    }
    for (const { d } of fxIn(s)) if (!langs.some((l) => pick(d.detail, l))) thin.add(d.id);
  }
  for (const u of setups.values()) if (!langs.some((l) => pick(u.detail, l))) thin.add(u.id);
  if (thin.size) hint('detail', `這一集用到的 ${[...thin].sort().join('、')} 沒有寫 detail；資產圖只有鏡頭用的精簡描述，畫出來會缺細節。detail 寫做工、材質、磨損與陳設，只進資產圖，不進鏡頭`);
}
for (const p of propDefs.values()) {
  for (const l of langs) {
    assets.push({ id: p.id, kind: '道具圖', lang: l, ar: AR.prop, prompt: joinS([joinC([pick(p.desc, l), pick(p.detail, l)], l), T[l].prop, pick(P.style_lock, l)], l) });
  }
  // 道具的狀態（拆開的信封、空了的杯子）：從原本的道具圖改，形狀和材質才不會變
  for (const [st, sv] of Object.entries(p.states && typeof p.states === 'object' ? p.states : {})) {
    for (const l of langs) {
      assets.push({ id: p.id, kind: `道具圖・${st}`, lang: l, ar: AR.prop, prompt: T[l].propEdit(p.id, strip(pick(sv, l))) + T[l].stop.trim() });
    }
  }
}
// 特效參考圖：每個狀態一張，單獨放在純黑背景上；後製的特效出的是給剪接的人看的設計圖
for (const f of fxDefs.values()) {
  const kindName = isPost(f) ? '特效設計圖（後製用）' : '特效參考圖';
  const states = Object.keys(f.states && typeof f.states === 'object' ? f.states : {});
  for (const st of states.length ? states : ['']) {
    for (const l of langs) {
      assets.push({ id: f.id, kind: st ? `${kindName}・${st}` : kindName, lang: l, ar: AR.fx, prompt: joinS([joinC([looksOf(f, st, l), pick(f.detail, l)], l), T[l].fx, pick(P.style_lock, l)], l) });
    }
  }
}

// 工具參數接在每一張圖的提示詞最後
// asset_suffix 與 image_suffix 裡的 {ar} 換成這一張圖的建議畫幅（Midjourney 寫成 "--ar {ar}"）
const withAr = (sfx, ar) => sfx.replace(/\{ar\}/g, ar);
for (const a of assets) a.prompt = withSuffix(a.prompt, withAr(ASSET_SUFFIX, a.ar));
for (const a of plateAssets) a.prompt = withSuffix(a.prompt, withAr(IMAGE_SUFFIX, a.ar));
if (/--(?:ar|aspect)\s+\d+:\d+/.test(ASSET_SUFFIX)) {
  hint('project.asset_suffix', 'asset_suffix 把畫幅寫死了；設定圖、頭像、道具圖的建議畫幅不一樣（見資產提示詞標題後的畫幅），改寫成 "--ar {ar}"，腳本會照每一張圖換');
}
if (/midjourney/i.test(String(P.image_tool || "")) && !IMAGE_SUFFIX) {
  hint("project.image_suffix", "Midjourney 的畫幅與參數寫在提示詞最後；填 image_suffix（例如 \"--ar 9:16\"），資產圖另外填 asset_suffix（例如 \"--ar 3:2\"）");
}
const arOf = (s) => (/--(?:ar|aspect)\s+(\d+:\d+)/.exec(s) || [])[1];
if (arOf(IMAGE_SUFFIX) && P.aspect && arOf(IMAGE_SUFFIX) !== P.aspect) warn("project.image_suffix", `image_suffix 的 --ar ${arOf(IMAGE_SUFFIX)} 和畫幅 ${P.aspect} 不一樣；首幀的比例要和影片一致`);

// ---------- 檢查分鏡 ----------
const shots = ep && Array.isArray(ep.shots) ? ep.shots : [];
// 集數決定輸出的檔名。複製 EP01.json 當 EP02、忘了改 episode，會蓋掉 EP01 的分鏡表，
// EP01 的 CSV 手填紀錄也會被當成「不在分鏡裡」搬走，所以集數和檔名對不上時不寫分鏡的產出。
let EP_ID = null;
let epBlocked = '';
if (ep) {
  checkKeys('分鏡檔', ep, EP_KEYS, 'ep');
  const raw = ep.episode == null ? '' : String(ep.episode).trim();
  const base = path.basename(second);
  const stem = base.replace(/\.json$/i, '');
  // 兩邊都取開頭 EP 後面的數字來比：EP01-2.json 寫 EP01-2、EP101.json 寫 S1E01，都不算對不上
  const leadNum = (s) => { const m = /^EP(\d+)/i.exec(s || ''); return m ? Number(m[1]) : null; };
  if (!raw) {
    EP_ID = epFileId || 'EP';
    err('分鏡檔', `缺少 episode（集數，例如 EP01）；輸出檔名會用到它${epFileId ? `，這次先照檔名用 ${EP_ID}` : ''}`);
  } else if (/[\\/:*?"<>|\u0000-\u001f]/.test(raw) || /^\.+$/.test(raw)) {
    epBlocked = `episode「${raw}」有不能放進檔名的字`;
    err('分鏡檔', `${epBlocked}；改成 EP01 這種寫法。這次沒有寫出分鏡表與 CSV`);
  } else {
    EP_ID = raw;
    const a = leadNum(stem);
    const b = leadNum(raw);
    if (stem.toUpperCase() !== raw.toUpperCase() && a != null && b != null && a !== b) {
      epBlocked = `episode 寫的是 ${raw}，檔名卻是 ${base}`;
      err('分鏡檔', `${epBlocked}；照這樣寫會蓋掉 ${raw} 的分鏡表與 CSV。把 episode 改成 ${epFileId}，或把檔名改成 ${raw}.json。這次沒有寫出分鏡表與 CSV`);
    }
  }
  if (EP_ID && EP_ID !== 'EP' && !epBlocked) {
    const off = shots.filter((s) => s && s.id && !String(s.id).startsWith(`${EP_ID}-`)).map((s) => s.id);
    if (off.length) {
      warn('分鏡檔', `有 ${off.length} 鏡的鏡號不是 ${EP_ID}- 開頭（${off.slice(0, 3).join('、')}${off.length > 3 ? '⋯' : ''}）；換集不重號，這一集要用 ${EP_ID}-001 這種鏡號，CSV 的手填紀錄也是按鏡號對回去的`);
    }
  }
}
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
    checkKeys(where, p, PLAN_KEYS, 'plan');
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
    if (REF_NUM && s.link !== '接續' && REF_MAX) {
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
    if (s.lens && typeof s.lens === 'object') checkFrag(`${id}.lens`, s.lens);
    else checkTerm(id, '焦段', s.lens, !!LENSES[sp.lens] || /^\d+\s*mm$/i.test(sp.lens), `${Object.keys(LENSES).join('、')}，或直接寫「35mm」`);
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
      if (NO_COMPLEX_CAM && !s.risk && RISKY_MOVES[cam.base] && !cam.custom) hint(id, RISKY_MOVES[cam.base]);
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
    checkKeys(id, s, SHOT_KEYS);
    cast.forEach((e) => checkKeys(`${id} ${e.char ?? '（cast）'}`, e, CAST_KEYS, 'cast'));
    // 12：cast 是必填；空鏡寫 []。cast 是空的，動作卻寫到某個角色，提示詞就不會寫出那個人
    if (!('cast' in s)) warn(id, '缺少 cast；沒有人入鏡的空鏡寫 "cast": []，有人入鏡就把角色放進來，提示詞才會寫出外貌與走位');
    else if (!cast.length) {
      const who = mentionsCharacter([s.action, s.motion]);
      if (who) warn(id, `cast 是空的，但 action 或 motion 寫到了「${who}」；入鏡的角色要放進 cast，提示詞才會寫出這個角色的外貌與走位`);
    }
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
      // 朝向：用詞表裡的詞；背對鏡頭卻沒設 partial，提示詞會寫一整段看不到的臉
      if (typeof e.facing === 'object' && e.facing) checkFrag(`${id} ${e.char}.facing`, e.facing);
      else checkTerm(id, `${e.char} 的朝向`, e.facing, !!FACINGS[zhOf(e.facing)], Object.keys(FACINGS).join('、'));
      if (zhOf(e.facing) === '背面' && !e.partial) hint(id, `${e.char} 背對鏡頭，卻沒有設 partial；背影要設 partial: true，提示詞才不會寫一整段看不到的臉和表情`);
      // 看得到臉卻沒寫表情：中景以內警告，全景、中全景提示
      if (!e.partial && ['人', '半人'].includes(kind) && sp.type !== '插入' && !e.face) {
        const rank = SIZE_RANK[sp.size] ?? -1;
        if (rank >= SIZE_RANK['中景']) warn(id, `${e.char} 沒寫 face；${sp.size}看得清楚臉，不寫表情，工具會給一張沒有表情的臉或自己猜。寫看得見的眉、眼、嘴（「眉頭微皺，嘴唇抿緊」）`);
        else if (rank >= SIZE_RANK['全景']) hint(id, `${e.char} 沒寫 face；${sp.size}裡臉比較小，但表情還是看得出來，寫一句看得見的表情`);
      }
      // 表情寫成情緒詞（「神情恭敬」「一臉得意」），就算後面還有別的字，工具也畫不出固定的樣子
      const vague = !e.partial && langs.map((l) => FACE_MOOD_RE.exec(pick(e.face, l))?.[0]).find(Boolean);
      const flat = langs.map((l) => pick(e.face, l).replace(/[，,。.\s]+$/u, '')).find((f) => ABSTRACT_FACE_RE.test(f));
      if (vague && !flat) hint(id, `${e.char} 的 face 寫了「${vague}」這種情緒詞；工具畫不出固定的樣子。換成看得見的眉、眼、嘴與呼吸，見 references/prompt-writing.md 的情緒對照表`);
      if (flat) hint(id, `${e.char} 的 face 只寫了情緒「${flat}」；工具會給一張標準的表情。寫成看得見的眉、眼、嘴與呼吸，見 references/prompt-writing.md 的情緒對照表`);
    });
    for (const k of ['props', 'frame', 'bg', 'light', 'palette', 'negative', 'end']) checkFrag(`${id}.${k}`, s[k]);
    // 看得清楚臉的鏡頭，motion 卻完全沒寫臉：影片裡的表演只剩身體，表情不會變
    if (!still && (SIZE_RANK[sp.size] ?? -1) >= SIZE_RANK['中景'] && cast.some((e) => !e.partial && ['人', '半人'].includes(kindOf(chars.get(e.char)?.c || {})))) {
      // 先拿掉短稱與名字（「戴細框眼鏡的男子」的「眼」不算），再拿掉「臉朝」這類方向
      const bare = (l) => charList.flatMap(({ c, vs }) => [pick(c.tag, l), c.name, ...vs.map((x) => pick(x.tag, l))]).filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .reduce((txt, tg) => txt.split(tg).join(' '), pick(s.motion, l))
        .replace(/臉(朝|轉|向)|turn(s|ing)? (his|her|their) face/g, '');
      const noFace = langs.every((l) => !MOTION_FACE_RE.test(bare(l)));
      if (noFace) hint(id, 'motion 沒寫臉上的變化；這一鏡看得清楚臉，影片裡的表演只剩身體。寫一個看得見的表情變化（「說完嘴角微微上揚」「眼神暗下來」），或一個臉上的微動作（眨眼、吞嚥）');
    }
    // 41：後配口型的台詞，說話的人要臉朝鏡頭、嘴看得見
    if (P.audio_plan === '後配口型' && !still && s.line?.text && s.line.type === '對白') {
      const sp = cast.find((e) => chars.get(e.char)?.c.id === chars.get(s.line.who)?.c.id);
      const turned = sp && (sp.partial || /背面|側面/.test(zhOf(sp.facing)) || langs.some((l) => TURNED_RE.test(joinC([pick(sp.pos, l), pick(sp.gaze, l), pick(sp.face, l)], l))));
      if (turned) warn(id, `後配口型的台詞，說話的 ${sp.char} 卻${sp.partial ? '只有背影或局部入鏡' : '側著、背著，或低頭、回頭、鞠躬'}；嘴型要另外對上，臉要朝鏡頭、嘴不能被擋住。讓說話的人先站定、臉朝鏡頭說完再做動作，或把這句改成畫外音、鏡頭給聽的人`);
    }
    // 42：尾幀和首幀一樣，動作做不出來
    if (endMode(s) !== 'off') {
      const same = langs.map((l) => END_SAME_RE.exec(pick(s.end, l))?.[0]).find(Boolean);
      if (same) hint(id, `end 寫了「${same}」；尾幀要是動作做完之後看得見的差別，和首幀一樣的話動作在兩張一樣的圖之間做不出來。首幀寫動作開始前的樣子；這一鏡真的沒有變化（只有眨眼、呼吸），填 "last_frame": false`);
    }
    // 朝向與視線打架：正面朝向鏡頭卻看向畫面一側，工具只能二選一（把頭轉過去，或畫成斜眼）
    cast.forEach((e) => {
      const f = zhOf(e.facing);
      if (!f || e.partial) return;
      const g = langs.map((l) => pick(e.gaze, l)).join(' ');
      const side = /畫面左|frame left/i.test(g) ? '左' : /畫面右|frame right/i.test(g) ? '右' : '';
      if (!side) return;
      if (f === '正面') hint(id, `${e.char} 正面朝向鏡頭，視線卻看向畫面${side}側；工具只能把頭轉過去，或畫成斜眼。看向畫面${side}邊的人用「半側朝${side}」，正反打的對方才接得上；真的要臉朝鏡頭，視線就寫看向鏡頭附近`);
      else if (/朝[左右]$/.test(f) && f.slice(-1) !== side) hint(id, `${e.char} 的 facing 是「${f}」，視線卻看向畫面${side}側；是回頭看的話在 pos 寫清楚身體與頭各朝哪裡，不然把 facing 改成朝${side}`);
    });
    // 43：首幀的欄位只能寫一個瞬間
    cast.forEach((e) => {
      for (const k of ['pos', 'gaze', 'hands', 'face']) {
        const m = langs.map((l) => SEQ_RE.exec(pick(e[k], l))?.[0]).find(Boolean);
        if (m) hint(id, `${e.char} 的 ${k} 寫了先後兩個動作（「${m}」）；首幀只是一個瞬間，工具會挑一個或混在一起。這裡寫動作開始前的那一刻，後面的變化寫在 motion 與 end`);
      }
    });
    // 48：9:16 放不下並排的兩個人
    if (P.aspect === '9:16' && (SIZE_RANK[sp.size] ?? -1) >= SIZE_RANK['中景'] && sp.type !== '過肩') {
      const both = cast.filter((e) => !e.partial);
      const depth = both.some((e) => langs.some((l) => /前景|後景|縱深|身後|\b(foreground|background|behind)\b/i.test(pick(e.pos, l))));
      if (both.length >= 2 && !depth) hint(id, `9:16 的${sp.size}裡並排兩個人，畫面放不下，人會被擠小或畫成兩個側臉對看；改成過肩、交替單人，或一前一後的縱深（pos 寫前景、後景）`);
    }
    if (NO_NEGATIVE && langs.some((l) => pick(s.negative, l))) warn(`${id}.negative`, '選定的工具沒有負面詞欄位，這一鏡的負面詞用不到；改寫成正面描述放進對應的片段');
    // 負面詞裡寫「文字」是對的；其他片段提到後製（工具寫不好字時連數字、文字也算），會把它們叫進畫面
    const postRe = (str) => POST_WORD_RE.exec(str) || (NO_TEXT ? TEXT_WORD_RE.exec(str) : null);
    const postHits = [...['props', 'frame', 'bg', 'end', 'motion'].map((k) => [k, s[k]]), ...cast.flatMap((e) => ['pos', 'gaze', 'hands', 'face', 'partial'].map((k) => [`${e.char}.${k}`, e.partial === true && k === 'partial' ? null : e[k]]))]
      .filter(([, v]) => langs.some((l) => postRe(pick(v, l))));
    for (const [k, v] of postHits) {
      const w = langs.map((l) => postRe(pick(v, l))?.[0]).find(Boolean);
      warn(`${id}.${k}`, `片段寫到了「${w}」；它會進提示詞，工具會試著把字或數字畫出來。替後製留位置時只寫看得見的畫面（「掌心上方留一片暗色的空白」），不要說空白是給什麼的，後製的內容寫在 post`);
    }

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
      if (NO_FAST && e.motion && langs.some((l) => FAST_RE.test(pick(e.motion, l)))) warn(id, `特效 ${e.id} 的 motion 用了「爆發／瞬間」這類字眼，選定的工具做不好快速的動作；寫成慢慢擴散、明暗起伏，快的留給後製`);
    });
    checkFrag(`${id}.motion`, s.motion, !still);
    if (NATIVE_AUDIO) checkFrag(`${id}.sound`, s.sound);
    // 暖光的鏡頭沿用了不是為暖光寫的場景 palette：
    // 一是 palette 寫明以冷色為主；二是場景本身的光不暖、這一鏡（或機位）才換成暖光，而 palette 裡沒有任何暖色。
    // 後者常見於冷色調的夜戲裡點起燈籠、風燈：palette 是照月光寫的，燈光一亮，同一句提示詞就兩邊打架
    {
      const sc = scenes.get(s.scene) || {};
      const local = s.light || setupOf(s).light;
      if (local && !s.palette && pick(sc.palette, langs[0])) {
        const warmHere = (l) => WARM_LIGHT_RE.test(pick(local, l));
        // 主光是暖的，而且它的暖色（沒寫顏色的燭火、燈籠算「暖」）在場景的光和 palette 裡都找不到
        const unmatched = (l) => {
          const key = keyLight(pick(local, l));
          // 主光本身要是暖光：暖光的光源（燈籠、燭火）或帶暖色的光；「金色的眼睛發著微光」不算
          if (!WARM_LIGHT_RE.test(key) && !WARM_COLOR_LIGHT_RE.test(key)) return false;
          const fam = warmFamilies(key);
          const own = fam.length ? fam : ['warm'];
          const there = warmFamilies(joinC([pick(sc.palette, l), pick(sc.light, l)], l));
          return !own.some((f) => there.includes(f)) && !there.includes('warm');
        };
        if (langs.some((l) => warmHere(l) && coolDominant(pick(sc.palette, l)))) {
          hint(id, `這一鏡的光是暖光，場景的 palette 卻以冷色為主（「${zhOf(sc.palette)}」），同一句提示詞裡會打架；這一鏡覆寫 palette，或把場景的 palette 改成和所有光都相容的寫法（只寫暗部偏什麼色）`);
        } else if (langs.some(unmatched)) {
          hint(id, `這一鏡把光換成暖光（場景本身的光不暖），色彩卻沿用場景的 palette（「${zhOf(sc.palette)}」），裡面沒有任何暖色；palette 是照場景原本的光寫的，這一鏡覆寫 palette（例如「暖橘的燈光只照亮一角，其餘沉在冷灰的暗部裡」）`);
        }
      }
    }
    // 連戲備註寫到道具被收走或拿出來，這一鏡與前一鏡的 motion、end 卻沒寫
    if (s.continuity && PROP_MOVE_RE.test(String(s.continuity))) {
      const prev = shots[i - 1] || {};
      for (const p of propDefs.values()) {
        const name = zhOf(p.name);
        // 道具編號要是獨立的一個詞：P01 不能算到鏡號 EP01-021 裡面
        const idRe = new RegExp(`(^|[^A-Za-z0-9])${p.id}(?![A-Za-z0-9])`);
        const hit = idRe.test(String(s.continuity)) || (name && String(s.continuity).includes(name));
        if (!hit) continue;
        const told = [s.motion, s.end, prev.motion, prev.end].some((v) => { const t = rawPick(v, langs[0]); return t.includes(`{${p.id}`) || (name && t.includes(name)); });
        if (!told) hint(id, `continuity 寫到 ${p.id}${name ? `（${name}）` : ''}被收走或拿出來，但這一鏡和前一鏡的 motion、end 都沒寫；生成時不會發生。拍一鏡交代，或寫進動手那一鏡的 motion 或 end`);
      }
    }
    if (s.sound && langs.some((l) => MUSIC_RE.test(pick(s.sound, l)))) {
      hint(id, 'sound 寫到了配樂；sound 只寫故事裡聽得到的聲音（原生音訊時它會進影片提示詞），配樂的進出寫在 music');
    }
    if (USE_LAST && cast.length && !s.end && !still && s.last_frame !== false) warn(id, '缺少 end（尾幀與首幀的差別）；有首尾幀控制時動作最穩。這一鏡真的沒有變化（只有眨眼、呼吸）就填 "last_frame": false');
    if (s.last_frame != null && typeof s.last_frame !== 'boolean') warn(id, 'last_frame 只能填 false（這一鏡不出尾幀）或 true');

    // 動作描述（靜幀不跑影片，motion 不會用到）
    const motions = still ? [] : langs.map((l) => pick(s.motion, l));
    if (NO_FAST && motions.some((m) => FAST_RE.test(m))) warn(id, 'motion 用了「快速／劇烈／瞬間」這類字眼，選定的工具做不好快速的動作（tool_limits.fast_motion 是 false），容易變形；改用剪接表現速度，單鏡內寫正常速度、小幅度');
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
    if (s.line != null && !(isObj(s.line) && s.line.text)) {
      warn(id, isObj(s.line)
        ? 'line 沒有 text；沒有台詞就拿掉 line，有台詞就寫在 text'
        : 'line 要寫成 {"type": "對白", "who": "C01", "text": "…"}；目前的寫法腳本讀不懂，這句台詞不會進字幕、表格和提示詞');
    }
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
      // 工具參數（--ar 9:16）不是提示詞的文字，不算進長度
      if (s.link !== '接續') checkLimit(id, 'image', IMAGE_SUFFIX ? imagePrompt(s, l).slice(0, -IMAGE_SUFFIX.length).trim() : imagePrompt(s, l), l);
      if (!still) checkLimit(id, 'video', videoPrompt(s, l), l);
    }
  });

  // 朝向的連戲：同一個機位裡，同一個人上一鏡臉朝左、這一鏡朝右，多半是越軸或寫錯
  {
    const lastDir = new Map();
    for (const s of shots) {
      if (!s.setup) continue;
      for (const e of s.cast || []) {
        const dir = FACINGS[zhOf(e.facing)]?.dir;
        const h = chars.get(e.char);
        if (!dir || !h) continue;
        const key = `${s.setup}|${h.c.id}`;
        const prev = lastDir.get(key);
        if (prev && prev.dir !== dir) hint(s.id, `${h.c.id} 在機位 ${s.setup} 的 ${prev.id} 臉朝畫面${prev.dir}，這一鏡朝${dir}；同一個機位裡左右對調多半是越軸。人物真的轉身了就在前一鏡的 end 寫出來`);
        lastDir.set(key, { dir, id: s.id });
      }
    }
  }
  // 身高：兩個人以上同框、看得到身體時，沒寫身高的角色會被畫成一樣高
  {
    const told = new Set();
    for (const s of shots) {
      if (!showStature(s)) continue;
      // 只比人與半人：器物、動物、異獸的大小已經在 look 裡拿人來比
      const people = [...new Map((s.cast || []).filter((e) => bodyShown(e, s) && ['人', '半人'].includes(kindOf(chars.get(e.char).c))).map((e) => [chars.get(e.char).c.id, chars.get(e.char).c])).values()];
      const missing = people.filter((c) => !pick(c.stature, langs[0]));
      const key = people.map((c) => c.id).sort().join('+');
      if (missing.length && people.length >= 2 && !told.has(key)) {
        told.add(key);
        hint(s.id, `${people.map((c) => c.id).join('、')} 同框而且看得到身體，${missing.map((c) => c.id).join('、')} 沒有寫 stature（身高）；生成工具常把同框的人畫得一樣高。寫絕對身高，例如「身高約一百八十公分」，同框時腳本會把每個人的身高一起寫進去`);
      }
    }
  }

  // 聲線：有台詞的角色與旁白都要先定一個聲線，配音、原生音訊、整季的每一集才會是同一個聲音
  {
    const speakers = new Map();
    let narrated = false;
    for (const s of shots) {
      const ln = s.line;
      if (!ln?.text) continue;
      if (chars.has(ln.who)) { const c = chars.get(ln.who).c; if (!speakers.has(c.id)) speakers.set(c.id, c); } else if (ln.type === '旁白' || ln.who === '旁白') narrated = true;
    }
    for (const c of speakers.values()) {
      const vs = Array.isArray(c.variants) ? c.variants : [];
      if (!pick(c.voice, langs[0]) && !vs.some((v) => pick(v.voice, langs[0]))) {
        hint(c.id, `${c.name || c.id} 有台詞，沒有寫 voice（聲線）；配音和生成都要照同一個聲線，每一集才不會換一個聲音。寫性別年齡、音色、語速，例如「二十多歲的女聲，音色偏低，說話慢」`);
      }
    }
    if (narrated && !pick(P.narrator_voice, langs[0])) hint('project.narrator_voice', '有旁白，沒有寫 narrator_voice（旁白的聲線）；整季的旁白要是同一個聲音');
  }

  // 道具連戲：同一個機位、取景沒有變近，前一鏡畫面裡的道具卻沒寫到，中間也沒有一鏡交代它被拿走。
  // 同機位的首幀是從前一張改出來的，沒交代就消失的道具，生成時常常又被畫回來
  {
    const propIds = (vals) => {
      const out = new Set();
      for (const v of vals) for (const m of rawPick(v, langs[0]).matchAll(PROP_RE)) if (m[1][0] === 'P' && propDefs.has(m[1])) out.add(m[1]);
      return out;
    };
    const inFrame = (s) => propIds([s.props, s.bg, s.frame, ...(s.cast || []).flatMap((e) => [e.pos, e.gaze, e.hands, e.face, isPartialText(e) ? e.partial : null])]);
    const mentions = (vals, id) => {
      const t = vals.map((v) => rawPick(v, langs[0])).join(' ');
      const name = zhOf(propDefs.get(id)?.name);
      return t.includes(`{${id}`) || (!!name && t.includes(name));
    };
    const seen = new Map(); // 「機位|道具」→ 最後一次在畫面裡的鏡頭索引
    shots.forEach((s, i) => {
      const here = inFrame(s);
      for (const [key, k] of [...seen]) {
        const [setup, pid] = key.split('|');
        if (setup !== s.setup || here.has(pid)) continue;
        seen.delete(key);
        const before = shots[k];
        const notCloser = (SIZE_RANK[spec(s).size] ?? Infinity) <= (SIZE_RANK[spec(before).size] ?? -Infinity);
        // 交代的地方：那一鏡的 end，或中間任何一鏡的 motion、end、action
        const told = mentions([before.end], pid) || shots.slice(k + 1, i).some((x) => mentions([x.motion, x.end, x.action], pid));
        if (notCloser && !told) {
          const name = zhOf(propDefs.get(pid)?.name);
          hint(s.id, `${pid}${name ? `（${name}）` : ''}在 ${before.id}（同一個機位 ${setup}）的畫面裡，這一鏡取景沒有比較近，卻沒有寫到它；還在原處就寫進 props，被拿走了就在拿走的那一鏡寫進 motion 或 end`);
        }
      }
      if (s.setup) for (const pid of here) seen.set(`${s.setup}|${pid}`, i);
    });
  }

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
  // 建議切點是給之後可能切成短片的形式（漫劇、短劇）；動畫、真人劇、MV 這類完整的一集不用
  if (totalSec > 60 && !SHORT_EP && (!FORMAT || ['漫劇', '短劇'].includes(FORMAT)) && !shots.slice(0, -1).some((s) => s.cut)) {
    hint('整體', `整集約 ${Math.round(totalSec)} 秒，沒有標任何建議切點；在場景結束或懸念處加上 cut，使用者想切短時才有地方下刀`);
  }
  if (EP_LEN && shots.length) {
    if (totalSec > EP_LEN[1]) {
      warn('整體', `整集約 ${Math.round(totalSec)} 秒，超過單集長度上限 ${EP_LEN[1]} 秒；先刪台詞、合併過場鏡頭，還是太長就把一個節拍移到下一集，並同時改分集表`);
    } else if (totalSec < EP_LEN[0]) {
      warn('整體', `整集約 ${Math.round(totalSec)} 秒，不到單集長度下限 ${EP_LEN[0]} 秒；不要用放慢的鏡頭撐，補反應鏡頭、插入鏡頭，或把下一集開頭的內容提前`);
    }
  }
  if (seriesForEp && !epPlan) hint('分集表', `bible.json 旁邊的 series.json 裡沒有 ${epKey || '這一集'}；分集表要先排到這一集，拆鏡才有鉤子與卡點可以對照`);
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
      if (!e[k]) warn(id, `缺少 ${name}；每一集都要回答這一題，見 outline-to-episodes 技能第三節`);
    }
    if (e.cliff && !/[？?][」』"”']?\s*$/.test(String(e.cliff).trim())) hint(id, 'cliff 只寫了最後發生什麼，沒有寫出觀眾心裡的問題；在最後一個畫面後面接一句問題（「外婆為什麼要押她的記憶？」），寫劇本和拆鏡時才知道要停在誰的反應上');
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
  const fmt = 'outline-to-episodes 技能第四節';
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
    else if (s < EP_LEN[0] * 0.6) {
      hint('劇本', `台詞與旁白約 ${Math.round(s)} 秒，單集至少 ${EP_LEN[0]} 秒；台詞大約要佔單集的四分之三（約 ${Math.round(EP_LEN[0] * 0.75)} 秒，見 outline-to-episodes 第三節）。太短的話拆鏡後撐不到下限：補一段戲、反應或台詞，不要用放慢的鏡頭撐`);
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
// ---------- 寫檔：檔案被 Excel 鎖住時說清楚，不要整個中斷 ----------
const writeFailed = []; // {name, msg}
const csvNotes = []; // 重跑時搬回手填紀錄、備份的摘要，印在畫面上
const isLocked = (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e?.code);
const LOCKED_MSG = '寫不進去：這個檔案可能正在 Excel 或其他程式裡開著，或被設成唯讀。關掉它（或取消唯讀）後再跑一次腳本；其他檔案已經照常更新';
// 只給 tests/ 用：列在這裡的檔名，寫入或刪除時故意失敗，用來測試寫到一半失敗時紀錄會不會丟
const FAIL_FILES = new Set(String(process.env.STORYBOARD_TEST_FAIL_FILES || '').split(',').map((x) => x.trim()).filter(Boolean));
const testFail = (p) => {
  if (FAIL_FILES.has(path.basename(p))) throw Object.assign(new Error('測試用：故意讓這個檔案寫不進去'), { code: 'EIO' });
};
/** 寫檔。檔案已經存在時用 r+ 開、清空再寫：和 probeWrite 同一種開法，試開過了就寫得進去（隱藏檔也可以）。 */
function writeText(p, text) {
  testFail(p);
  const buf = Buffer.from(text, 'utf8');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, buf);
    return;
  }
  const fd = fs.openSync(p, 'r+');
  try {
    fs.ftruncateSync(fd, 0);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
  } finally {
    fs.closeSync(fd);
  }
}
function removeFile(p) {
  testFail(p);
  fs.unlinkSync(p);
}
const write = (name, text) => {
  const p = path.join(outDir, name);
  try {
    writeText(p, text);
    return p;
  } catch (e) {
    writeFailed.push({ name, msg: isLocked(e) ? LOCKED_MSG : `寫不進去：${e.message}` });
    return null;
  }
};
const written = [];

// ---------- 重跑時保留使用者在 CSV 手填的欄位 ----------
// 腳本每次重跑都會重寫 CSV。使用者在「模型、seed、抽卡次數、驗收結果」這類欄位填的紀錄，
// 和自己加的欄位，要按鏡號（資產按編號＋類型＋語言）搬到新檔，否則改一鏡、重跑一次，紀錄就全沒了。
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch !== '"') f += ch;
      else if (s[i + 1] === '"') { f += '"'; i++; } else q = false;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (ch !== '\r') f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
/**
 * 讀舊的 CSV，回傳 { table, skipped }；讀不懂回傳 null。
 * Excel 在中文 Windows 上另存時常存成 Big5 或 GBK，UTF-8 讀不懂就換這兩種試。
 * 標題列不一定在第一列（使用者在上面插了一列說明），在前十列裡找；上面那幾列算 skipped。
 */
function readCsvFile(p, mustHave) {
  const buf = fs.readFileSync(p);
  for (const enc of ['utf-8', 'big5', 'gb18030']) {
    let text;
    try { text = new TextDecoder(enc, { fatal: enc === 'utf-8' }).decode(buf); } catch { continue; }
    const rows = parseCsv(text);
    const at = rows.slice(0, 10).findIndex((r) => mustHave.every((c) => r.map((h) => h.trim()).includes(c)));
    if (at >= 0) return { table: rows.slice(at), skipped: at };
  }
  return null;
}
const stamp = () => {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${z(d.getMilliseconds(), 3)}`;
};
const BACKUP_KEEP = 5; // 最近幾份
const BACKUP_DAYS = 7; // 另外保留最近幾個有備份的日子，每天最後一份
/**
 * 覆蓋前把舊檔複製到 out/備份/。
 * 和最新一份備份一模一樣就不再複製，免得「最近五份」全是同一個版本；
 * 除了最近五份，再留最近七個有備份的日子各自的最後一份，同一天重跑很多次也擠不掉前幾天的版本。
 */
function backup(name) {
  const dir = path.join(outDir, '備份');
  const base = name.replace(/\.csv$/i, '');
  // 舊版的檔名沒有毫秒；名字要整個對上，EP01-shots 的備份才不會算到 EP01-shots-已移除 這類檔案
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{8})-(\\d{6})(?:-(\\d{3}))?\\.csv$`);
  try {
    const src = fs.readFileSync(path.join(outDir, name));
    fs.mkdirSync(dir, { recursive: true });
    const list = () => fs.readdirSync(dir)
      .map((x) => [x, re.exec(x)])
      .filter(([, m]) => m)
      .map(([x, m]) => ({ x, day: m[1], key: `${m[1]}${m[2]}${m[3] || '000'}` }))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // 新的在前
    const latest = list()[0];
    if (latest && fs.readFileSync(path.join(dir, latest.x)).equals(src)) return path.relative(outDir, path.join(dir, latest.x));
    const dest = path.join(dir, `${base}-${stamp()}.csv`);
    fs.writeFileSync(dest, src);
    // 清掉太舊的備份；清不掉（被別的程式開著）不影響這一份已經備份好
    try {
      const all = list();
      const keep = new Set(all.slice(0, BACKUP_KEEP).map((b) => b.x));
      const days = new Set();
      for (const b of all) {
        if (days.has(b.day)) continue;
        if (days.size >= BACKUP_DAYS) break;
        days.add(b.day);
        keep.add(b.x); // 這一天最新的一份
      }
      for (const b of all) if (!keep.has(b.x)) fs.unlinkSync(path.join(dir, b.x));
    } catch {
      // 下次再清
    }
    return path.relative(outDir, dest);
  } catch {
    return '';
  }
}
// 腳本產生、而且欄名會跟著設定變的欄位（提示詞語言、ref_mode、use_last_frame）。
// 換了設定之後，舊的欄名不能當成「使用者自己加的欄位」一直留下來，也不能把只有這些欄的列算成有手填紀錄。
// 要整個欄名完全相符才算：使用者自己加的「參考圖路徑」「影片提示詞（改）」不能被當成產生的欄位刪掉。
const LANG_SUFFIXES = ['', ...Object.values(T).map((x) => `（${x.name}）`)];
const SHOT_GENERATED = new Set([
  ...['首幀圖像提示詞', '尾幀提示詞（拿首幀圖做圖像編輯）', '影片提示詞', '負面詞'].flatMap((b) => LANG_SUFFIXES.map((s) => b + s)),
  '參考圖',
  '參考圖（依序上傳）',
]);
/**
 * 把讀進來的表轉成物件。
 * - 沒有欄名、但有內容的欄，補一個名字（「欄位43」），裡面的字才不會在重跑時不見。
 * - 欄名重複的（自己又加了一欄「備註」），後面的加上「(2)」，兩欄的內容都留著。
 */
function csvObjects(table) {
  const width = Math.max(0, ...table.map((r) => r.length));
  const seen = new Map();
  const head = Array.from({ length: width }, (_, i) => {
    let n = String(table[0][i] ?? '').trim();
    if (!n) {
      if (!table.slice(1).some((r) => String(r[i] ?? '').trim() !== '')) return '';
      n = `欄位${i + 1}`;
    }
    const k = (seen.get(n) || 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n}(${k})`;
  });
  return {
    head: head.filter(Boolean),
    objs: table.slice(1).map((r) => Object.fromEntries(head.map((c, i) => [c, r[i] ?? '']).filter(([c]) => c))),
  };
}
/**
 * 把舊檔的手填紀錄搬到新的 rows。只算出要寫的內容，不寫檔：寫檔的順序由 writeCsv 決定。
 * opt.keys：對應同一列用的欄位；opt.manual：腳本留空給使用者填的欄位；
 * opt.generated：腳本產生、欄名會變的欄位（完整欄名）；
 * opt.loose：主鍵對不上時退一步用的欄位（資產換了提示詞語言，「語言」那一欄就變了）；
 * opt.gone：對不上的紀錄怎麼說（「已經不在分鏡裡」）。
 * - 舊檔有、新檔沒有的欄位（使用者自己加的、沒有欄名的）也保留，排在最後。
 * - 同一個鍵有好幾列紀錄（使用者複製一列來記第二次抽卡），每一列都保留，接在一起。
 * - 已經不在新檔裡的列（鏡頭刪了或改了鏡號），有手填紀錄的移到「<檔名>-已移除.csv」；鍵回來了，再從那裡搬回來。
 * - 已移除檔裡和舊檔一模一樣的紀錄（上一次寫到一半失敗留下的）不重複算。
 */
function mergeCsv(name, rows, opt) {
  const p = path.join(outDir, name);
  const removedName = `${name.replace(/\.csv$/i, '')}-已移除.csv`;
  const removedPath = path.join(outDir, removedName);
  const res = {
    rows, removedName, notes: [], oldExists: fs.existsSync(p), removedExists: fs.existsSync(removedPath),
    unreadable: '', hadData: false, before: null, after: null,
  };
  if (!res.oldExists && !res.removedExists) return res;
  const head = [...rows[0]];
  let old = { head: [], objs: [] };
  let skipped = 0;
  if (res.oldExists) {
    const got = readCsvFile(p, opt.keys);
    if (!got) {
      res.unreadable = name;
      return res;
    }
    old = csvObjects(got.table);
    skipped = got.skipped;
  }
  let rem = { head: [], objs: [] };
  if (res.removedExists) {
    const got = readCsvFile(removedPath, opt.keys);
    if (!got) {
      res.unreadable = removedName;
      return res;
    }
    rem = csvObjects(got.table);
  }
  const generated = opt.generated || new Set();
  const extra = [...new Set([...old.head, ...rem.head])].filter((c) => !head.includes(c) && !generated.has(c));
  const keep = [...opt.manual.filter((c) => head.includes(c)), ...extra];
  const keyOf = (o, cols = opt.keys) => cols.map((c) => String(o[c] ?? '').trim()).join('|');
  const filled = (o) => keep.some((c) => String(o[c] ?? '').trim() !== '');
  const sig = (o) => [keyOf(o), ...keep.map((c) => String(o[c] ?? '').trim())].join('\u0000');
  const oldRecs = old.objs.filter(filled);
  const oldSigs = new Set(oldRecs.map(sig));
  // 有手填紀錄的列：舊檔的排前面，已移除檔的接在後面
  const records = [
    ...oldRecs.map((o) => ({ o, from: 'old' })),
    ...rem.objs.filter(filled).filter((o) => !oldSigs.has(sig(o))).map((o) => ({ o, from: 'removed' })),
  ];
  res.hadData = oldRecs.length > 0;
  const body = rows.slice(1);
  const rowKey = (r, cols) => cols.map((c) => String(r[head.indexOf(c)] ?? '').trim()).join('|');
  const matched = body.map(() => []);
  const used = new Set();
  const group = (pick) => {
    const m = new Map();
    records.forEach((rec, j) => {
      if (used.has(j)) return;
      const k = pick(rec);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(j);
    });
    return m;
  };
  const byKey = group((rec) => keyOf(rec.o));
  body.forEach((r, n) => {
    for (const j of byKey.get(rowKey(r, opt.keys)) || []) {
      if (used.has(j)) continue;
      matched[n].push(records[j]);
      used.add(j);
    }
  });
  // 主鍵對不上時，退一步用 opt.loose：新檔只有一列、剩下的紀錄也全是同一個主鍵（可以是好幾列），才搬過去
  if (opt.loose) {
    const newCount = new Map();
    for (const r of body) newCount.set(rowKey(r, opt.loose), (newCount.get(rowKey(r, opt.loose)) || 0) + 1);
    const left = group((rec) => keyOf(rec.o, opt.loose));
    body.forEach((r, n) => {
      if (matched[n].length) return;
      const k = rowKey(r, opt.loose);
      const js = left.get(k);
      if (!js || newCount.get(k) !== 1 || new Set(js.map((j) => keyOf(records[j].o))).size !== 1) return;
      for (const j of js) {
        matched[n].push(records[j]);
        used.add(j);
      }
    });
  }
  const newHead = [...head, ...extra];
  const out = [];
  const multi = [];
  let restored = 0;
  body.forEach((r, n) => {
    if (!matched[n].length) {
      out.push([...r, ...extra.map(() => '')]);
      return;
    }
    if (matched[n].length > 1) multi.push(rowKey(r, opt.keys).split('|')[0]);
    for (const rec of matched[n]) {
      const row = [...r, ...extra.map(() => '')];
      for (const c of keep) {
        const i = newHead.indexOf(c);
        if (i >= 0 && !String(row[i] ?? '').trim()) row[i] = rec.o[c] ?? '';
      }
      out.push(row);
      restored++;
    }
  });
  // 對不上的紀錄移到已移除檔，不丟掉
  const orphans = records.filter((_, j) => !used.has(j));
  const newlyRemoved = orphans.filter((x) => x.from === 'old');
  const comingBack = records.filter((x, j) => used.has(j) && x.from === 'removed');
  const removedText = (list) => {
    const cols = [...new Set([...opt.keys, ...list.flatMap((x) => Object.keys(x.o))])];
    return csv([cols, ...list.map((x) => cols.map((c) => x.o[c] ?? ''))]);
  };
  // 寫檔的順序（writeCsv）：before 在主檔之前寫，after 在主檔寫成功之後才寫。
  // 要離開主檔的紀錄先進已移除檔；要搬回主檔的紀錄，等主檔寫好了才從已移除檔拿掉。
  // 任何一步失敗，每一筆紀錄都至少還在一個檔案裡；兩邊都有的，下次重跑由上面的 oldSigs 去重。
  const final = orphans.length ? { text: removedText(orphans) } : res.removedExists ? { drop: true } : null;
  if (newlyRemoved.length) {
    res.before = { text: removedText([...orphans, ...comingBack]) };
    if (comingBack.length) res.after = final;
  } else {
    res.after = final;
  }
  if (res.hadData || restored) {
    res.notes.push(res.hadData ? `搬回 ${restored} 列手填的紀錄` : `從 ${removedName} 搬回 ${restored} 列紀錄`);
    if (multi.length) res.notes.push(`${[...new Set(multi)].join('、')} 有不只一列紀錄，每一列都保留了`);
    if (extra.length) res.notes.push(`保留自己加的欄位：${extra.join('、')}`);
    if (newlyRemoved.length) {
      res.notes.push(`${newlyRemoved.length} 列${opt.gone}（${[...new Set(newlyRemoved.map((x) => keyOf(x.o).split('|')[0]))].join('、')}），紀錄移到 ${removedName}`);
    }
  }
  if (skipped) res.notes.push(`舊檔標題列上面的 ${skipped} 列不是表格內容，沒有搬過來`);
  res.rows = [newHead, ...out];
  return res;
}
/** 用寫入模式試開一次：檔案在 Excel 裡開著、或被設成唯讀時，在動任何檔案之前就知道寫不進去。 */
function probeWrite(p) {
  if (!fs.existsSync(p)) return null;
  try {
    fs.closeSync(fs.openSync(p, 'r+'));
    return null;
  } catch (e) {
    return e;
  }
}
/**
 * 搬回手填紀錄後寫出 CSV。順序：
 * 1. 試開主檔和已移除檔，寫不進去就什麼都不動。
 * 2. 舊檔內容會變時先備份；舊檔有手填紀錄、卻備份不起來，就不寫。
 * 3. 寫已移除檔的 before（要離開主檔的紀錄先放進去），再寫主檔，主檔寫成功才寫 after（或刪掉已移除檔）。
 * 舊檔或已移除檔讀不懂時不覆蓋，請使用者處理。
 */
function writeCsv(name, rows, opt) {
  const p = path.join(outDir, name);
  let m;
  try {
    m = mergeCsv(name, rows, opt);
  } catch (e) {
    writeFailed.push({
      name,
      msg: isLocked(e)
        ? `${LOCKED_MSG}。這次連舊檔都讀不到，為了不蓋掉你手填的紀錄，這個檔案沒有更新`
        : `讀不到舊檔：${e.message}。為了不蓋掉手填的紀錄，這個檔案沒有更新`,
    });
    return null;
  }
  if (m.unreadable) {
    writeFailed.push({
      name,
      msg: `讀不懂 ${m.unreadable}（可能被另存成別的格式，或找不到「${opt.keys.join('、')}」這幾欄的標題列）。為了不蓋掉裡面手填的紀錄，${name} 這次沒有更新：在 Excel 裡把 ${m.unreadable} 另存成「CSV UTF-8」，或把它移到別的資料夾（腳本會重新產生），再跑一次`,
    });
    return null;
  }
  const removedPath = path.join(outDir, m.removedName);
  const touchRemoved = !!(m.before || m.after);
  for (const [who, e] of [[name, probeWrite(p)], [m.removedName, touchRemoved ? probeWrite(removedPath) : null]]) {
    if (!e) continue;
    const why = isLocked(e) ? LOCKED_MSG : `寫不進去：${e.message}`;
    writeFailed.push({
      name,
      msg: who === name
        ? `${why}。手填的紀錄都還在原本的檔案裡，這次沒有動`
        : `${who} ${why.replace(/^寫不進去：這個檔案/, '寫不進去：它')}。為了不弄丟紀錄，${name} 這次也沒有更新`,
    });
    return null;
  }
  const text = csv(m.rows);
  let b = '';
  if (m.oldExists) {
    let same = false;
    try {
      same = fs.readFileSync(p).equals(Buffer.from(text, 'utf8'));
    } catch {
      // 讀不到就照樣備份
    }
    if (!same) {
      b = backup(name);
      if (!b && m.hadData) {
        writeFailed.push({ name, msg: `舊檔有手填的紀錄，但備份不起來（out/備份 建不起來或寫不進去），為了保險這次沒有更新` });
        return null;
      }
    }
  }
  if (m.before && !write(m.removedName, m.before.text)) return null; // 什麼都還沒動
  const done = write(name, text);
  if (!done) return null; // 要離開主檔的紀錄已經在已移除檔裡，舊的主檔在 out/備份/；下次重跑會去重
  if (m.before) written.push(path.join(outDir, m.removedName));
  if (m.after?.text != null) {
    try {
      writeText(removedPath, m.after.text);
      if (!m.before) written.push(removedPath);
    } catch {
      // 不算失敗：紀錄都在，只是已移除檔多了已經搬回主檔的幾列
      m.notes.push(`${m.removedName} 沒有更新（可能被別的程式開著），已經搬回主檔的紀錄下次重跑會自動從那裡清掉`);
    }
  } else if (m.after?.drop) {
    try {
      removeFile(removedPath);
    } catch {
      m.notes.push(`${m.removedName} 刪不掉（可能被別的程式開著），裡面的紀錄都已經搬回主檔，下次重跑會再清一次`);
    }
  }
  if (m.notes.length) {
    if (b) m.notes.push(`舊檔備份在 ${b}`);
    csvNotes.push(`${name}：${m.notes.join('；')}`);
  }
  return done;
}
const SHOT_MANUAL = ['模型', 'seed', '抽卡次數', '採用版本', '驗收結果', '備註'];
const SHOT_CSV = { keys: ['鏡號'], manual: SHOT_MANUAL, generated: SHOT_GENERATED, gone: '已經不在分鏡裡' };
const ANIMATIC_CSV = { keys: ['鏡號'], manual: [], gone: '已經不在分鏡裡' };
const ASSET_CSV = { keys: ['編號', '類型', '語言'], loose: ['編號', '類型'], manual: ['模型', 'seed', '定稿檔名', '備註'], gone: '已經不在資產清單裡（資產刪了或改了編號）' };

const lenText = EP_LEN ? `${EP_LEN[0]} 到 ${EP_LEN[1]} 秒` : '';
/** 設定表的「工具限制」：工具未定時不套用任何限制；定了就列出這個工具做不好、腳本會檢查的事。 */
function toolLimitText() {
  if (!TOOL_SET) return '未套用（工具未定，提示詞照故事需要寫完整；定了工具再填 tool_limits 與秒數、長度上限）';
  const weak = Object.entries(TL_KEYS).filter(([k]) => TL[k] === false).map(([, n]) => n);
  const nums = [
    HAS_CLIP ? `單次秒數 ${RANGE ? `${RANGE[0]} 到 ${RANGE[1]}` : CLIPS.join(' / ')}` : '',
    Object.keys(LIMITS).length ? '提示詞長度上限' : '',
    REF_NUM && REF_MAX ? `參考圖最多 ${REF_MAX} 張` : '',
  ].filter(Boolean);
  if (!weak.length && !nums.length) return P.tool_limits == null ? '還沒填（見檢查結果）' : '沒有限制';
  return [...nums, weak.length ? `工具做不好：${weak.join('、')}` : ''].filter(Boolean).join('；');
}
const minSec = (sec) => {
  const r = Math.round(sec); // 先取整數再拆分，119.6 秒才不會變成「1 分 60 秒」
  return r >= 60 ? `${Math.floor(r / 60)} 分 ${r % 60} 秒` : `${r} 秒`;
};

// ---------- settings.md / assets.csv（只檢查分集劇本時不寫） ----------
if (scriptText == null) {
  const L = [];
  L.push(`# ${P.title || '未命名專案'}　設定表`, '');
  L.push('## 本次參數', '');
  L.push(table(['項目', '內容'], [
    ['形式', FORMAT],
    ...(P.medium ? [['媒材', P.medium]] : []),
    ['畫幅', P.aspect ? `${P.aspect}（在生成工具裡選，提示詞不含畫幅）` : ''],
    ['圖像工具', P.image_tool || '未定'],
    ['影片工具', P.video_tool || '未定'],
    ['工具限制', toolLimitText()],
    ['影片生成方式', MODE === 'i2v' ? '圖生影片（先出首幀圖）' : '文字生影片'],
    ['首尾幀', USE_LAST ? '使用' : '不使用'],
    ['聲音方案', P.audio_plan || ''],
    ['提示詞語言', langs.map((l) => T[l].name).join('＋')],
    ['參考圖模式', RM === '混合'
      ? `混合（外貌照文字完整寫，再標上「${langs.map((l) => T[l].refSee(refToken(1, l)).trim()).join('」「')}」這類編號；有掛圖就照分鏡表列的順序上傳${REF_MAX ? `，一次最多 ${REF_MAX} 張` : ''}，沒掛圖文字也完整）`
      : REF_MODE
      ? `參考圖（提示詞用「${langs.map((l) => refToken(1, l)).join('」「')}」這類編號指向參考圖，每一鏡依分鏡表列的順序上傳${REF_MAX ? `，一次最多 ${REF_MAX} 張` : ''}）`
      : '文字（外貌與造型完整寫進每一鏡的提示詞，參考圖是加強）'],
    ['單次可生成秒數', RANGE ? `${RANGE[0]} 到 ${RANGE[1]}` : CLIPS.length ? CLIPS.join(' / ') : '未填'],
    ...(EP_LEN ? [['單集長度', lenText]] : []),
    ...(P.narration ? [['旁白', P.narration]] : []),
    ...(show(P.narrator_voice) ? [['旁白的聲線', show(P.narrator_voice)]] : []),
    ...(P.music ? [['配樂方向', P.music]] : []),
    ...(IMAGE_SUFFIX ? [['圖像提示詞最後的參數', `\`${IMAGE_SUFFIX}\`（首幀、尾幀、機位背景圖）`]] : []),
    ...(ASSET_SUFFIX ? [['資產圖最後的參數', `\`${ASSET_SUFFIX}\``]] : []),
  ]), '');
  if (Array.isArray(bible.pending) && bible.pending.length) {
    L.push('## 待確認設定', '', '以下是原文沒寫、先補上的暫定值。要改請直接說，改一處所有鏡頭會一起更新。', '');
    for (const p of bible.pending) L.push(`- ${p}`);
    L.push('');
  }
  L.push('## 角色', '');
  // 聲線：角色的、各形態自己的，以及工具裡選定的音色（voice_ref）
  const voiceCell = (c, vs) => [show(c.voice), ...vs.filter((v) => show(v.voice)).map((v) => `${v.id}：${show(v.voice)}`), c.voice_ref ? `音色：${c.voice_ref}` : ''].filter(Boolean).join('<br>');
  const hasVoice = charList.some(({ c, vs }) => voiceCell(c, vs));
  L.push(table(['編號', '名稱', '短稱', '固定外貌', '辨識特徵', '造型變體', ...(hasVoice ? ['聲線'] : [])], charList.map(({ c, vs }) => {
    const extra = [kindOf(c) !== '人' ? kindOf(c) : '', c.mouthless ? '沒有嘴' : ''].filter(Boolean).join('，');
    return [
      c.id, `${c.name || ''}${extra ? `（${extra}）` : ''}`, show(c.tag), show(c.look), show(c.marks),
      vs.map((v) => {
        const desc = [show(v.look) ? `外貌：${show(v.look)}` : '', show(v.tag) ? `短稱：${show(v.tag)}` : '', show(v.outfit), show(v.state)].filter(Boolean).join('；');
        return `${v.id}${v.label ? `（${v.label}）` : ''}${desc ? `：${desc}` : ''}`;
      }).join('<br>'),
      ...(hasVoice ? [voiceCell(c, vs)] : []),
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
  L.push('## 資產提示詞', '', '先生成這些圖並定稿，之後每一鏡都掛它們當參考圖。標題後面是建議畫幅，在生成工具裡選：設定圖與組圖要橫幅才放得下幾個角度，道具與特效用方形。近景以內的鏡頭會另外掛角色的頭像，臉才撐得起特寫。', '');
  let last = '';
  for (const a of assets) {
    const h = `### ${a.id}　${a.kind}（畫幅 ${a.ar}）`;
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
  written.push(writeCsv('assets.csv', [
    ['編號', '類型', '建議畫幅', '語言', '提示詞', '模型', 'seed', '定稿檔名', '備註'],
    ...assets.map((a) => [a.id, a.kind, a.ar, T[a.lang].name, a.prompt, '', '', '', '']),
  ], ASSET_CSV));
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
if (ep && epBlocked) {
  writeFailed.push({ name: '分鏡表與 CSV', msg: `${epBlocked}，為了不蓋掉別一集的產出，這次沒有寫出（見檢查結果）` });
}
if (ep && !epBlocked) {
  const epId = EP_ID;
  const total = shots.reduce((n, s) => n + (Number(s.duration) || 0), 0);
  const who = (s) => (s.cast || []).map((e) => e.char).join('、') || '—';
  const lineText = (s) => {
    const ln = s.line;
    if (!ln || !ln.text) return '';
    const hit = chars.get(ln.who);
    const name = hit ? hit.c.name || ln.who : ln.who || '';
    return `${ln.type || ''}${name && name !== ln.type ? ` ${name}` : ''}：「${rawPick(ln.text, langs[0])}」`; // 旁白的 who 也是「旁白」，不重複寫
  };
  // 這一句台詞用誰的聲線：角色（這一鏡入鏡的形態優先）或旁白
  const speakerVoice = (s) => {
    const ln = s.line;
    if (!ln || !ln.text) return '';
    const hit = chars.get(ln.who);
    if (!hit) return ln.type === '旁白' || ln.who === '旁白' ? zhOf(P.narrator_voice) : '';
    const inShot = (s.cast || []).map((e) => chars.get(e.char)).find((h) => h && h.c.id === hit.c.id);
    const v = voiceOf(hit.c, (inShot || hit).v, langs[0]);
    return v ? `${v}${hit.c.voice_ref ? `（音色：${hit.c.voice_ref}）` : ''}` : '';
  };
  const soundCell = (s) => [zhOf(s.sound), s.music ? `♪ ${zhOf(s.music)}` : ''].filter(Boolean).join('<br>');
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
  L.push(`共 ${shots.length} 鏡${split}，成片約 ${Math.round(total)} 秒${lenText ? `（單集長度 ${lenText}）` : ''}${P.aspect ? `，畫幅 ${P.aspect}（在生成工具裡選）` : ''}。設定表與資產提示詞見 settings.md；首幀出完後，用 ${epId}-animatic.csv 與 ${epId}.srt 排一版動態分鏡，見「動態分鏡」一節。`, '');
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
      const h = `### ${a.id}　${a.kind}（畫幅 ${a.ar}）`;
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
  const cues = shots.map((s, i) => ({ s, i })).filter(({ s }) => s.music);
  if (cues.length) {
    L.push('## 配樂提示', '', '給剪接的人：配樂在哪裡進、轉、停，重拍落在哪一鏡。時間是這一鏡開始的累計時間。', '');
    L.push(table(['鏡號', '開始', '提示'], cues.map(({ s, i }) => [s.id, tc(i ? ends[i - 1] : 0), zhOf(s.music)])), '');
  }
  L.push('## 導演表', '');
  L.push(table(
    ['鏡號', '原文對應', '節拍', '場景', '機位', '角色', '秒', '累計', '景別', '運鏡', '銜接', '動作', '對白／旁白', '聲音', '備註', '切點'],
    shots.map((s, i) => [s.id, s.source || '', beatLabel(s), s.scene, s.setup || '—', who(s), s.duration, tc(ends[i]), sizeLabel(s, true), camLabel(s), linkText(s), zhOf(s.action), lineText(s), soundCell(s), note(s), cutOf(s, i)]),
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
    if (speakerVoice(s)) L.push(`- 聲線：${speakerVoice(s)}`);
    if (s.music) L.push(`- 音樂：${zhOf(s.music)}`);
    const refs = refLabels(s);
    if (REF_NUM && s.link !== '接續' && refs.length) {
      L.push(`- 參考圖（依這個順序上傳，提示詞裡的「${refToken(1, langs[0]).replace(/1/, 'N')}」就是第 N 張）：${refs.map((r, k) => `${k + 1}. ${r}`).join('；')}`);
    } else if (!REF_NUM && refs.length) L.push(`- 參考圖：${refs.join('＋')}`);
    const g = isStill(s) ? undefined : genLength(Number(s.duration) || 0);
    // 51：結尾要留著的鏡頭（有尾幀，或下一鏡接續）只裁開頭，裁掉結尾就裁掉了設計好的那一幀
    const keepEnd = hasEndFrame(s) || shots[i + 1]?.link === '接續';
    if (g) L.push(`- 成片 ${s.duration} 秒，建議生成 ${g} 秒段${keepEnd ? `，只裁開頭、結尾留著（${shots[i + 1]?.link === '接續' ? '下一鏡從這一鏡的最後一幀接' : '最後一幀就是設計好的尾幀'}）` : '再裁頭尾'}`);
    if (noEndNote(s, 'zh')) L.push(`- 尾幀：${noEndNote(s, 'zh')}`);
    const focus = focusOf(s, i);
    if (focus.length) L.push(`- 驗收重點：${focus.join('；')}`);
    L.push('');
    for (const l of langs) {
      L.push(`首幀圖像提示詞${langLabel(l)}`, '', code(firstFrame(s, i, l)), '');
      if (lastFramePrompt(s, l)) L.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`, '', code(lastFramePrompt(s, l)), '');
      if (!isStill(s)) L.push(`影片提示詞${langLabel(l)}`, '', code(videoPrompt(s, l)), '');
      if (pick(s.negative, l)) L.push(`這一鏡額外的負面詞${langLabel(l)}`, '', code(pick(s.negative, l)), '');
    }
  });
  L.push('## 動態分鏡', '', '首幀圖全部出完、生成影片之前，先用首幀圖排一版粗剪。影片是最貴的一步，節奏、軸線和長度的問題在這裡抓最便宜。', '');
  L.push(`1. 照 \`${epId}-animatic.csv\` 的順序，把「用哪張圖」放上剪輯軟體的時間線，每張停「秒數」那麼久；「粗剪做法」寫了怎麼模擬動作與運鏡。`);
  L.push(`2. 匯入 \`${epId}.srt\` 當臨時字幕，照「聲線」錄臨時配音，或先用文字轉語音。`);
  L.push('3. 從頭看一遍：鏡頭長短和停頓對不對、相鄰兩鏡人物的左右有沒有跳、整集長度合不合。要改就改分鏡檔重跑，再生成影片。', '');
  L.push('## 檢查結果', '', issueTable(), '');
  written.push(write(`${epId}-storyboard.md`, L.join('\n')));

  const head = ['鏡號', '原文對應', '節拍', '場景', '機位', '角色', '成片秒數', '累計', '生成方式', '建議生成秒數', '景別', '鏡頭類型', '角度', '機位高度', '焦段', '運鏡', '速度', '銜接', '轉場', '動作', '對白／旁白', '台詞語氣', '聲線', '聲音', '音樂', '建議切點'];
  for (const l of langs) {
    head.push(`首幀圖像提示詞${langLabel(l)}`);
    if (USE_LAST) head.push(`尾幀提示詞（拿首幀圖做圖像編輯）${langLabel(l)}`);
    head.push(`影片提示詞${langLabel(l)}`, `負面詞${langLabel(l)}`);
  }
  head.push(REF_NUM ? '參考圖（依序上傳）' : '參考圖', '風險', '連戲備註', '後製', '驗收重點', '模型', 'seed', '抽卡次數', '採用版本', '驗收結果', '備註');
  const rows = shots.map((s, i) => {
    const sp = spec(s);
    const gen = isStill(s) ? '' : genLength(Number(s.duration) || 0) ?? '';
    const r = [s.id, s.source || '', beatLabel(s), s.scene, s.setup || '', who(s), s.duration, tc(ends[i]), renderOf(s), gen, sp.size || zhOf(s.size), sp.type, sp.angle || '', sp.height || '', sp.lens || '', zhOf(s.camera), zhOf(s.speed), s.link, s.transition || '', zhOf(s.action), lineText(s), zhOf(s.line?.tone), speakerVoice(s), zhOf(s.sound), zhOf(s.music), cutOf(s, i)];
    for (const l of langs) {
      r.push(firstFrame(s, i, l));
      if (USE_LAST) r.push(lastFramePrompt(s, l) || noEndNote(s, l));
      r.push(videoPrompt(s, l), negativePrompt(s, l));
    }
    const refs = REF_NUM && s.link === '接續' ? [] : refLabels(s);
    r.push(REF_NUM ? refs.map((x, k) => `${k + 1}. ${x}`).join('；') : refs.join('＋'), s.risk || '', s.continuity || '', postNote(s), focusOf(s, i).join('；'), '', '', '', '', '', '');
    return r;
  });
  written.push(writeCsv(`${epId}-shots.csv`, [head, ...rows], SHOT_CSV));
  if (plateAssets.length) {
    written.push(writeCsv(`${epId}-assets.csv`, [
      ['編號', '類型', '建議畫幅', '語言', '提示詞', '模型', 'seed', '定稿檔名', '備註'],
      ...plateAssets.map((a) => [a.id, a.kind, a.ar, T[a.lang].name, a.prompt, '', '', '', '']),
    ], ASSET_CSV));
  }

  // 動態分鏡：每一鏡用哪張圖、停多久、怎麼模擬動作，配上台詞、聲線與配樂提示
  const startOf = (i) => (i ? ends[i - 1] : 0);
  const imageFor = (s, i) => {
    const prev = shots[i - 1];
    if (s.link === '接續' && prev) return `${prev.id} 的${hasEndFrame(prev) ? '尾幀圖' : '首幀圖'}`;
    return `${s.id} 的首幀圖`;
  };
  const roughOf = (s) => {
    if (isStill(s)) return renderOf(s) === '靜幀運鏡' && !isStatic(s) ? `在圖上做${camTerm(s, 'zh')}` : '停住';
    const how = hasEndFrame(s) ? '首幀疊化到尾幀，代替動作' : '首幀停住';
    const cam = isStatic(s) ? '' : `，在圖上做${camTerm(s, 'zh')}代替運鏡`;
    return `${how}${cam}${speedOf(s) ? `（成片是${zhOf(s.speed)}）` : ''}`;
  };
  written.push(writeCsv(`${epId}-animatic.csv`, [
    ['鏡號', '開始', '結束', '秒數', '用哪張圖', '粗剪做法', '對白／旁白', '聲線', '聲音', '音樂', '轉場', '建議切點'],
    ...shots.map((s, i) => [s.id, tc(startOf(i)), tc(ends[i]), s.duration, imageFor(s, i), roughOf(s), lineText(s), speakerVoice(s), zhOf(s.sound), zhOf(s.music), s.transition || '', cutOf(s, i)]),
  ], ANIMATIC_CSV));
  // 臨時字幕：每句台詞從鏡頭開始後 0.2 秒起，講完（字數 ÷ 語速）就收，不超過這一鏡
  const srtTime = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const subCues = shots.map((s, i) => ({ s, i })).filter(({ s }) => isObj(s.line) && s.line.text).map(({ s, i }) => {
    const a = startOf(i) + 0.2;
    return { a, b: Math.max(a + 0.8, Math.min(ends[i], a + speakSeconds(s.line.text) + 0.3)), text: rawPick(s.line.text, langs[0]) };
  });
  // 很短的鏡頭撐不到 0.8 秒的字幕時，截到下一句開始之前，字幕才不會疊在一起
  subCues.forEach((c, k) => {
    const next = subCues[k + 1];
    if (next && c.b > next.a - 0.05) c.b = Math.max(c.a + 0.1, next.a - 0.05);
  });
  const subs = subCues.map((c, k) => `${k + 1}\r\n${srtTime(c.a)} --> ${srtTime(c.b)}\r\n${c.text}\r\n`);
  written.push(write(`${epId}.srt`, subs.join('\r\n')));

  console.log(`${epId}：${shots.length} 鏡，成片約 ${Math.round(total)} 秒`);
}

// ---------- 結果 ----------
if (scriptText != null) {
  const st = scriptStats;
  console.log(`${path.basename(second)}：${st.scenes} 場，畫面（△）${st.visuals} 行，台詞與旁白 ${st.lines} 句、約 ${Math.round(st.seconds)} 秒${lenText ? `（單集長度 ${lenText}）` : ''}，後製文字 ${st.texts} 處`);
  if (st.bySpeaker.size) console.log(`說話時間：${[...st.bySpeaker].map(([w, s]) => `${w} ${Math.round(s)} 秒`).join('、')}`);
}
if (written.filter(Boolean).length) {
  console.log('已寫出：');
  for (const p of written.filter(Boolean)) console.log(`  ${p}`);
}
if (csvNotes.length) {
  console.log('CSV 的手填紀錄：');
  for (const n of csvNotes) console.log(`  ${n}`);
}
if (writeFailed.length) {
  console.log('沒有寫出：');
  for (const x of writeFailed) console.log(`  [錯誤] ${x.name}：${x.msg}`);
}
const count = (lv) => issues.filter((x) => x.level === lv).length;
console.log(`檢查：錯誤 ${count('錯誤')}、警告 ${count('警告')}、提示 ${count('提示')}`);
for (const x of issues) console.log(`  [${x.level}] ${x.where}：${x.msg}`);
process.exit(count('錯誤') || writeFailed.length ? 1 : 0);
