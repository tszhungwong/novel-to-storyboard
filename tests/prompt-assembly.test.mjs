// 提示詞怎麼組合，以及表演與構圖的提示：審查清單第 41–52 項。
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
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 複製主範例（或指定的範例）到暫存資料夾，改完再跑。 */
function run(t, { example = '', editBible, editEp } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-assembly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bible = readJson(path.join(EXAMPLES, example, 'bible.json'));
  const ep = readJson(path.join(EXAMPLES, example, 'EP01.json'));
  if (editBible) editBible(bible);
  if (editEp) editEp(ep);
  fs.writeFileSync(path.join(dir, 'bible.json'), JSON.stringify(bible));
  fs.writeFileSync(path.join(dir, 'EP01.json'), JSON.stringify(ep));
  const r = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'bible.json'), path.join(dir, 'EP01.json')], { encoding: 'utf8' });
  const file = (name) => fs.readFileSync(path.join(dir, 'out', name), 'utf8');
  return { out: r.stdout + r.stderr, checks: (r.stdout.split('檢查：')[1] || ''), file };
}
/** 分鏡表裡某一鏡、某一種提示詞的內容（第一個程式碼區塊）。 */
function promptOf(md, id, head) {
  const sec = md.split(`### ${id}`)[1].split('\n### ')[0];
  // 只認獨立成行的標題（說明文字裡也可能提到「影片提示詞」）
  const at = sec.split('\n').findIndex((l) => l.startsWith(head));
  if (at < 0) return null;
  return sec.split('\n').slice(at).join('\n').split('```text\n')[1].split('\n```')[0];
}
const sectionOf = (md, id) => md.split(`### ${id}`)[1].split('\n### ')[0];
const shot = (ep, id) => ep.shots.find((s) => s.id === id);

test('#45：填了機位高度，就不再寫「平視」', (t) => {
  const r = run(t, { editEp: (e) => { Object.assign(shot(e, 'EP01-002'), { angle: '平視', height: '地面' }); } });
  const p = promptOf(r.file('EP01-storyboard.md'), 'EP01-002', '首幀圖像提示詞');
  assert.match(p, /機位貼近地面/);
  assert.doesNotMatch(p, /平視角度/);
  assert.doesNotMatch(r.file('EP01-storyboard.md'), /機位背景圖[^#]*平視角度[^#]*機位貼近地面/);
});

test('#46：機位背景圖拿掉 bg 裡的景深字眼與「背景是」', (t) => {
  const r = run(t);
  const plate = sectionOf(r.file('EP01-storyboard.md'), 'S01-C').split('```text\n')[1].split('\n```')[0];
  assert.doesNotMatch(plate, /虛化|背景是/);
  assert.match(plate, /前後景都清楚/);
  // 鏡頭本身的背景照樣可以虛化
  assert.match(promptOf(r.file('EP01-storyboard.md'), 'EP01-005', '首幀圖像提示詞'), /略為虛化/);
});

test('#47：過肩鏡頭先寫景別與鏡頭類型，正面的主體排在前景的背影前面', (t) => {
  const r = run(t);
  const p = promptOf(r.file('EP01-storyboard.md'), 'EP01-005', '首幀圖像提示詞');
  assert.match(p, /^近景，胸部以上入鏡，過肩鏡頭/);
  assert.ok(p.indexOf('二十歲出頭的女性') < p.indexOf('短髮戴眼鏡的高個男子'), p);
});

test('#50：推近的尾幀先裁切、拉遠先擴圖、搖先往那一側擴圖', (t) => {
  const r = run(t, {
    editEp: (e) => {
      shot(e, 'EP01-004').camera = '緩慢拉遠';
      shot(e, 'EP01-007').camera = '左搖';
    },
  });
  const md = r.file('EP01-storyboard.md');
  assert.match(promptOf(md, 'EP01-008', '尾幀提示詞'), /裁切放大/);
  assert.match(promptOf(md, 'EP01-004', '尾幀提示詞'), /先向四周擴圖/);
  assert.match(promptOf(md, 'EP01-007', '尾幀提示詞'), /先向左側擴圖/);
});

test('#50：升降這類改變透視的運鏡不出尾幀，結束的樣子寫進影片提示詞；下一鏡接續時從首幀圖接', (t) => {
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-005').camera = '搖臂上升'; } });
  const md = r.file('EP01-storyboard.md');
  assert.equal(promptOf(md, 'EP01-005', '尾幀提示詞'), null);
  assert.match(sectionOf(md, 'EP01-005'), /- 尾幀：不出尾幀/);
  assert.match(promptOf(md, 'EP01-005', '影片提示詞'), /結束時：/);
  const animatic = r.file('EP01-animatic.csv');
  assert.match(animatic, /"EP01-006"[^\n]*"EP01-005 的首幀圖"/);
});

test('#51：有尾幀或下一鏡接續的鏡頭，只裁開頭', (t) => {
  const r = run(t);
  const md = r.file('EP01-storyboard.md');
  assert.match(sectionOf(md, 'EP01-005'), /只裁開頭、結尾留著（下一鏡從這一鏡的最後一幀接）/);
  assert.match(sectionOf(md, 'EP01-004'), /只裁開頭、結尾留著（最後一幀就是設計好的尾幀）/);
});

test('last_frame: false：不出尾幀，也不要求 end', (t) => {
  const r = run(t);
  assert.equal(promptOf(r.file('EP01-storyboard.md'), 'EP01-003', '尾幀提示詞'), null);
  assert.doesNotMatch(r.checks, /EP01-003：缺少 end/);
});

test('#52：頭像與表情組圖不寫手與身形；沒寫 expressions 會提示', (t) => {
  const r = run(t, { editBible: (b) => { delete b.characters[0].expressions; } });
  const settings = r.file('settings.md');
  const head = settings.split('### C01　頭像')[1].split('```text\n')[1].split('\n```')[0];
  assert.doesNotMatch(head, /手指|指甲|身形|身高/);
  assert.match(r.checks, /C01：林晚 沒有寫 expressions/);
});

test('#41：後配口型的台詞，說話的人在鞠躬或背對鏡頭要警告', (t) => {
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-006').cast[1].pos = '坐在畫面左側中景的桌前，低頭鞠躬'; } });
  assert.match(r.checks, /\[警告\] EP01-006：這句台詞之後另外配音、對口型（後配口型），說話的 C01-a/);
});

test('#42、#43：尾幀和首幀一樣、首幀寫了先後兩個動作，都會提示', (t) => {
  const r = run(t, {
    editEp: (e) => {
      shot(e, 'EP01-004').end = '短髮戴眼鏡的高個男子仍然站在門口';
      shot(e, 'EP01-007').cast[0].gaze = '先看向桌邊，再看向窗外';
    },
  });
  assert.match(r.checks, /EP01-004：end 寫了「仍然」/);
  assert.match(r.checks, /EP01-007：C02-a 的 gaze 寫了先後兩個動作/);
});

test('#44：機位看不到場景的光源、又沒寫自己的光，會提示', (t) => {
  const r = run(t, { editEp: (e) => { delete e.setups.find((u) => u.id === 'S01-B').light; } });
  assert.match(r.checks, /S01-B：這個機位的背景看不到「窗」/);
});

test('後配口型：說話的人正面入鏡時，影片提示詞要他嘴唇閉合；其他有台詞的鏡頭，畫面裡的人不說話', (t) => {
  const r = run(t);
  const md = r.file('EP01-storyboard.md');
  assert.match(promptOf(md, 'EP01-006', '影片提示詞'), /黑髮及肩的年輕女子的嘴唇保持閉合、嘴不動（口型之後另外做）/);
  // 005 說話的是背對鏡頭的陳嶼：畫面裡正面的林晚不說話
  assert.match(promptOf(md, 'EP01-005', '影片提示詞'), /人物嘴唇自然閉合，沒有說話/);
  // 沒有台詞的鏡頭不加
  assert.doesNotMatch(promptOf(md, 'EP01-007', '影片提示詞'), /嘴唇/);
});

test('原生音訊的鏡頭不加嘴唇閉合', (t) => {
  const r = run(t, { example: 'en-action' });
  assert.doesNotMatch(promptOf(r.file('EP01-storyboard.md'), 'EP01-005', '影片提示詞'), /lips stay closed/);
});

test('正面朝向鏡頭卻看向畫面一側，會提示', (t) => {
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-004').cast[0].facing = '正面'; } });
  assert.match(r.checks, /EP01-004：C02-a 正面朝向鏡頭，視線卻看向畫面左側/);
});

test('混合模式（預設）：每個範例的每一鏡，列出的參考圖在首幀提示詞裡都有被指稱', () => {
  for (const ex of ['', 'creature-fx', 'live-action', 'en-action']) {
    const md = fs.readFileSync(path.join(EXAMPLES, ex, 'out', 'EP01-storyboard.md'), 'utf8');
    const bible = readJson(path.join(EXAMPLES, ex, 'bible.json'));
    const zh = (bible.project.prompt_langs || ['zh', 'en']).includes('zh');
    for (const sec of md.split('\n### EP').slice(1)) {
      const id = `EP${sec.split(/\s/)[0]}`;
      const line = sec.split('\n').find((l) => l.startsWith('- 參考圖（依這個順序上傳'));
      if (!line) continue;
      const n = (line.match(/\d+\. /g) || []).length;
      const head = sec.split('\n').findIndex((l) => l.startsWith('首幀圖像提示詞'));
      const p = sec.split('\n').slice(head).join('\n').split('```text\n')[1].split('\n```')[0];
      for (let k = 1; k <= n; k++) {
        const token = zh ? `圖${k}` : `image ${k}`;
        assert.ok(new RegExp(`${token}(?!\\d)`).test(p), `${ex || 'main'} ${id}：第 ${k} 張參考圖沒有在首幀提示詞裡被指稱\n${line}\n${p}`);
      }
    }
  }
});

test('混合模式：外貌照寫，再標上參照第幾張；文字模式不標編號', (t) => {
  const mixed = promptOf(run(t).file('EP01-storyboard.md'), 'EP01-004', '首幀圖像提示詞');
  assert.match(mixed, /二十五歲左右的男性[^。]*（參照圖1）/);
  assert.match(mixed, /（背景參照圖2）/);
  const text = promptOf(run(t, { editBible: (b) => { b.project.ref_mode = '文字'; } }).file('EP01-storyboard.md'), 'EP01-004', '首幀圖像提示詞');
  assert.doesNotMatch(text, /參照圖|（圖\d）/);
  assert.match(text, /二十五歲左右的男性/);
});

test('refs 加的表情組圖接在那個人的表情後面，前一鏡的畫面寫成構圖與光線參照', (t) => {
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-005').refs = ['C01 表情組圖', 'EP01-004 的首幀圖']; } });
  const p = promptOf(r.file('EP01-storyboard.md'), 'EP01-005', '首幀圖像提示詞');
  assert.match(p, /眼眶微紅，嘴唇自然閉合（表情參照圖\d）/);
  assert.match(p, /構圖與光線參照圖\d/);
});

test('表情：中景以內沒寫 face 警告；寫情緒詞提示；中景以內表情排在位置前面', (t) => {
  const r = run(t, {
    editEp: (e) => {
      delete shot(e, 'EP01-007').cast[0].face;
      shot(e, 'EP01-004').cast[0].face = '神情緊張，嘴唇閉著';
    },
  });
  assert.match(r.checks, /\[警告\] EP01-007：C02-a 沒寫 face/);
  assert.match(r.checks, /EP01-004：C02-a 的 face 寫了「神情緊張」這種情緒詞/);
  const p = promptOf(run(t).file('EP01-storyboard.md'), 'EP01-005', '首幀圖像提示詞');
  assert.ok(p.indexOf('眼眶微紅') < p.indexOf('坐在畫面左側中景的桌前'), p);
});

test('看得清楚臉的鏡頭，motion 沒寫臉會提示；短稱裡的「眼鏡」不算寫到臉', (t) => {
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-007').motion = '短髮戴眼鏡的高個男子站在原地，肩膀隨呼吸起伏'; } });
  assert.match(r.checks, /EP01-007：motion 沒寫臉上的變化/);
});

test('#48：9:16 的中景並排兩個人會提示；過肩或有前後縱深就不提示', (t) => {
  const twoShot = (e) => {
    const s = shot(e, 'EP01-007');
    s.size = '中景';
    s.cast = [
      { char: 'C01-a', facing: '側面朝右', pos: '站在畫面左側', gaze: '看著對面的男子', hands: '雙手垂在身側', face: '嘴唇閉著' },
      { char: 'C02-a', facing: '側面朝左', pos: '站在畫面右側', gaze: '看著對面的女子', hands: '雙手垂在身側', face: '嘴唇閉著' },
    ];
  };
  const a = run(t, { editEp: twoShot });
  assert.match(a.checks, /EP01-007：9:16 的中景裡並排兩個人/);
  const b = run(t, { editEp: (e) => { twoShot(e); shot(e, 'EP01-007').cast[1].pos = '站在畫面右側後景'; } });
  assert.doesNotMatch(b.checks, /EP01-007：9:16/);
});

// ---------- 影片提示詞的其他要素：結束時、表情延續、環境、一致性、聲音、運鏡、負面詞 ----------

test('沒有尾幀圖時，end 寫進影片提示詞（工具不吃尾幀，或這一鏡關掉尾幀）', (t) => {
  const a = run(t, { editBible: (b) => { b.project.use_last_frame = false; } });
  assert.match(promptOf(a.file('EP01-storyboard.md'), 'EP01-002', '影片提示詞'), /結束時：頭微微低下，視線從窗外落到桌上的信封/);
  const b = run(t, { editEp: (e) => { shot(e, 'EP01-002').last_frame = false; } });
  const md = b.file('EP01-storyboard.md');
  assert.match(promptOf(md, 'EP01-002', '影片提示詞'), /結束時：頭微微低下/);
  // 有尾幀圖的鏡頭不重複寫
  assert.doesNotMatch(promptOf(md, 'EP01-004', '影片提示詞'), /結束時/);
});

test('表情延續：motion 只寫視線與身體時帶上首幀的表情；寫了表情變化就不加', (t) => {
  const a = run(t, { example: 'live-action' });
  const p = promptOf(a.file('EP01-storyboard.md'), 'EP01-008', '影片提示詞（中文）');
  assert.match(p, /戴細框眼鏡的灰髮中年男子的表情維持首幀的樣子：眼神放低，嘴角帶著客氣的淺笑，嘴唇閉著/);
  assert.match(promptOf(a.file('EP01-storyboard.md'), 'EP01-008', '影片提示詞（English）'), /holds the expression from the first frame: eyes lowered politely/);
  const b = run(t, { example: 'live-action', editEp: (e) => { shot(e, 'EP01-008').motion = { zh: '戴細框眼鏡的灰髮中年男子站定，嘴角的笑收起來，上半身彎下鞠躬', en: 'the grey-haired man stops, his smile fading, and bows from the waist' }; } });
  assert.doesNotMatch(promptOf(b.file('EP01-storyboard.md'), 'EP01-008', '影片提示詞（中文）'), /表情維持/);
});

test('環境的動態：場景的 ambient 進每一鏡，插入與特寫不套用，機位與鏡頭可以覆寫或關掉', (t) => {
  const r = run(t, { example: 'creature-fx' });
  const md = r.file('EP01-storyboard.md');
  assert.match(promptOf(md, 'EP01-005', '影片提示詞'), /窗外的雨絲斜斜落下，吊燈的竹燈罩輕輕晃動/);
  assert.doesNotMatch(promptOf(md, 'EP01-001', '影片提示詞'), /雨絲/); // 特寫的插入鏡頭
  assert.match(promptOf(md, 'EP01-004', '影片提示詞'), /門外的雨絲斜斜落下/); // 這一鏡覆寫
  assert.doesNotMatch(promptOf(md, 'EP01-004', '影片提示詞'), /窗外的雨絲/);
  assert.doesNotMatch(promptOf(md, 'EP01-007', '影片提示詞'), /雨絲/); // 這一鏡填 false
  // 首幀不受影響
  assert.doesNotMatch(promptOf(md, 'EP01-005', '首幀圖像提示詞'), /雨絲斜斜落下/);
  // 主範例：朝玄關拍的機位填了 false
  const m = run(t);
  assert.match(promptOf(m.file('EP01-storyboard.md'), 'EP01-005', '影片提示詞'), /窗簾被微風輕輕帶動/);
  assert.doesNotMatch(promptOf(m.file('EP01-storyboard.md'), 'EP01-004', '影片提示詞'), /窗簾/);
});

test('場景寫了雨卻沒有 ambient 會提示；原生音效、原生音訊沒有 ambient_sound 也會提示', (t) => {
  const r = run(t, { example: 'creature-fx', editBible: (b) => { delete b.scenes[0].ambient; delete b.scenes[0].ambient_sound; } });
  assert.match(r.checks, /S01\.ambient：場景寫了「雨」，卻沒有 ambient/);
  assert.match(r.checks, /S01\.ambient_sound：影片工具會生成聲音/);
});

test('會動又會發光的特效，影片提示詞加一句光跟著晃動', (t) => {
  const r = run(t, { example: 'creature-fx' });
  assert.match(promptOf(r.file('EP01-storyboard.md'), 'EP01-006', '影片提示詞'), /火焰在原地輕輕搖晃，上下浮動，照在周圍的光也跟著明暗晃動/);
});

test('一致性提醒：有人入鏡寫長相與服裝，沒有人寫畫面裡的東西；consistency_line: false 關掉', (t) => {
  const r = run(t, { example: 'creature-fx' });
  const md = r.file('EP01-storyboard.md');
  assert.match(promptOf(md, 'EP01-005', '影片提示詞'), /除了上面寫到的變化，人物的長相、服裝與背景都和首幀一致/);
  assert.match(promptOf(md, 'EP01-001', '影片提示詞'), /除了上面寫到的變化，畫面裡的東西與背景都和首幀一致/);
  const off = run(t, { editBible: (b) => { b.project.consistency_line = false; } });
  assert.doesNotMatch(promptOf(off.file('EP01-storyboard.md'), 'EP01-002', '影片提示詞'), /和首幀一致/);
});

test('原生音效：環境聲與音效進影片提示詞，加「沒有人聲對白」，台詞不進去，說話的人嘴唇閉合', (t) => {
  const r = run(t, { example: 'creature-fx' });
  const md = r.file('EP01-storyboard.md');
  const p = promptOf(md, 'EP01-005', '影片提示詞');
  assert.match(p, /聲音：細雨打在木格窗上。沒有人聲對白。不要字幕，不要背景音樂。$/);
  assert.match(p, /短髮瘦臉的青年的嘴唇保持閉合、嘴不動（口型之後另外做）/);
  assert.doesNotMatch(p, /說：/);
  // 這一鏡的環境聲填 false：雨聲遠去
  assert.match(promptOf(md, 'EP01-008', '影片提示詞'), /聲音：一聲很輕的鈴響，雨聲遠去。/);
  // 導演表的聲音欄也接上環境聲
  assert.match(md, /\| 細雨打在木格窗上，壺蓋輕碰壺身的喀一聲 \|/);
});

test('音訊與影片的短指令：預設擋配樂與自動切鏡，填空字串關掉，自己寫的沒擋到會提示', (t) => {
  const off = run(t, { example: 'creature-fx', editBible: (b) => { b.project.audio_suffix = ''; b.project.video_suffix = ''; } });
  const p = promptOf(off.file('EP01-storyboard.md'), 'EP01-005', '影片提示詞');
  assert.doesNotMatch(p, /不要背景音樂|單一連續鏡頭/);
  const own = run(t, { example: 'creature-fx', editBible: (b) => { b.project.audio_suffix = '不要字幕'; b.project.video_suffix = '畫面穩定'; } });
  assert.match(own.checks, /project\.audio_suffix：audio_suffix 沒有擋掉配樂/);
  assert.match(own.checks, /project\.video_suffix：可靈 會自己把一段影片切成好幾個鏡頭/);
});

test('video_suffix 的 {ar} 換成畫幅、{dur} 換成建議生成秒數', (t) => {
  const r = run(t, { editBible: (b) => { b.project.video_suffix = '--ar {ar} --duration {dur}'; } });
  assert.match(promptOf(r.file('EP01-storyboard.md'), 'EP01-002', '影片提示詞'), /--ar 9:16 --duration \d+。$/);
  assert.doesNotMatch(r.checks, /沒換掉的/);
});

test('影片負面詞：只進影片的負面詞欄，接在通用負面詞後面；沒填會提示', (t) => {
  const r = run(t, { example: 'live-action' });
  const settings = r.file('settings.md');
  assert.match(settings, /## 影片負面詞[\s\S]*多餘的手指，變形的手，浮水印，磨皮過度的皮膚，閃爍，畫面抖動/);
  const csv = r.file('EP01-shots.csv');
  assert.match(csv.split('\n')[0], /"負面詞（中文）","影片負面詞（中文）"/);
  const none = run(t, { example: 'live-action', editBible: (b) => { delete b.project.negative_video; } });
  assert.match(none.checks, /project\.negative_video：填了通用負面詞，還沒有影片專用的/);
  assert.doesNotMatch(none.file('EP01-shots.csv').split('\n')[0], /影片負面詞/);
});

test('手持可以疊在運鏡前面；「手持固定」會提示', (t) => {
  const en = run(t, { example: 'en-action' });
  assert.match(promptOf(en.file('EP01-storyboard.md'), 'EP01-004', '影片提示詞'), /Gentle handheld push-in\./);
  const r = run(t, { editEp: (e) => { shot(e, 'EP01-004').camera = '手持跟拍'; shot(e, 'EP01-007').camera = '手持固定'; } });
  assert.match(promptOf(r.file('EP01-storyboard.md'), 'EP01-004', '影片提示詞'), /鏡頭手持跟拍主體/);
  assert.match(r.checks, /EP01-007：「手持固定」互相矛盾/);
});

test('運鏡的終點：會改變取景的運鏡 end 沒寫取景會提示；鏡頭在動卻沒有尾幀也沒有 end 會提示', (t) => {
  const r = run(t, {
    editEp: (e) => {
      shot(e, 'EP01-007').camera = '緩慢推近';
      Object.assign(shot(e, 'EP01-003'), { camera: '左移', last_frame: false });
    },
  });
  assert.match(r.checks, /EP01-007：運鏡「緩慢推近」會改變取景，end 卻沒寫運鏡之後的取景/);
  assert.match(r.checks, /EP01-003：鏡頭在動（左移），這一鏡卻沒有尾幀，也沒寫 end/);
  // 範例裡寫了取景的不提示
  assert.doesNotMatch(r.checks, /EP01-008：運鏡/);
});
