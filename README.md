# 小說轉分鏡（novel-to-storyboard plugin）

把小說、劇本或故事大綱做成 AI 影片的分鏡：角色與場景設定、資產圖提示詞、逐鏡的首尾幀與影片提示詞、連戲與風險檢查。適用 AI 漫劇、短劇、動畫、真人寫實劇，以及 MV、廣告、推文解說這類影片。

同一個資料夾同時是 Claude Code 與 Codex 的 plugin。

## 裡面有什麼

**三個技能**，照你在哪個階段進來分：

| 技能 | 什麼時候用 |
|---|---|
| `outline-to-episodes` | 手上只有大綱，或要切成每集幾十秒的短集：排分集表、寫分集劇本 |
| `novel-to-storyboard` | 有小說章節、劇本或分集劇本，要拆成分鏡（核心） |
| `storyboard-fix` | 分鏡做好之後：選定或換了生成工具、要修改、生成出來的結果不對 |

**三個審查角色**：攝影與連戲、表演、美術。拆完一集、腳本檢查乾淨之後，三個角色各從自己的角度挑問題，只回報不改檔，由主流程（導演）決定改不改。

- 審查要點寫在 `skills/novel-to-storyboard/references/review-*.md`，兩個工具共用同一份。
- Claude Code 用 `agents/` 裡的三個代理；Codex 和其他能開子代理的工具，由技能叫它開一般的子代理，把審查要點交給它。
- 不能開子代理的環境（例如 claude.ai 的聊天），技能會自己照三份要點各走一遍。

**自動檢查的 hook**：改了 `bible.json`、`EPxx.json`、`series.json` 或分集劇本，就自動跑一次檢查腳本，把錯誤與警告回給模型。它只檢查、不更新 `out/` 的產出，也不動 CSV 裡的手填紀錄。技能本身照樣會叫模型執行腳本，hook 只是保險。

## 安裝

需要 Node.js 16 以上（檢查腳本與 hook 都用 Node，沒有其他相依）。

**Claude Code**

```
/plugin marketplace add tszhungwong/novel-to-storyboard
/plugin install novel-to-storyboard@novel-to-storyboard
```

本機開發時，直接載入這個資料夾：`claude --plugin-dir <這個資料夾>`。

**Codex**

```
codex plugin marketplace add tszhungwong/novel-to-storyboard
codex plugin add novel-to-storyboard@novel-to-storyboard
```

裝好後重開 Codex，開 `/hooks` 檢視並信任這個 plugin 的 hook；Codex 不會自動信任 plugin 帶來的 hook。審查角色在 Codex 裡是一般的子代理，不用另外安裝。

> Codex 的部分照 Codex 的 plugin 格式寫好了，但還沒有在 Codex 上實際跑過；遇到問題請回報。

**claude.ai**

可以上傳整個 plugin。聊天裡不支援 hook 和代理：技能照常可用，審查改由技能自己照三份要點走。

## 資料夾結構

```
.claude-plugin/       Claude Code 的 plugin 與 marketplace 設定
.codex-plugin/        Codex 的 plugin 設定
.agents/plugins/      Codex 的 marketplace 設定
skills/
  novel-to-storyboard/  核心技能：SKILL.md、references/、scripts/build_storyboard.mjs、examples/
  outline-to-episodes/  大綱轉分集：SKILL.md、examples/
  storyboard-fix/       換工具、修改、生成結果不對：SKILL.md
agents/               Claude Code 的三個審查代理
hooks/                hooks.json（Claude Code）、codex-hooks.json（Codex）、check-storyboard.cjs
tests/                腳本的測試（node --test）
evals/                評測案例（claude plugin eval 讀這裡）
```

其他兩個技能共用核心技能的腳本與參考文件，用相對路徑 `../novel-to-storyboard/` 指過去，所以三個技能要一起安裝。

## 自己跑檢查腳本

```
node skills/novel-to-storyboard/scripts/build_storyboard.mjs <bible.json> [<EPxx.json> | <series.json> | <EPxx-script.md>] [--out <資料夾>]
```

範例的產出在各自的 `out/`；改了腳本之後重跑每個範例：

```
node skills/novel-to-storyboard/scripts/build_storyboard.mjs skills/novel-to-storyboard/examples/bible.json skills/novel-to-storyboard/examples/EP01.json
node skills/novel-to-storyboard/scripts/build_storyboard.mjs skills/outline-to-episodes/examples/bible.json skills/outline-to-episodes/examples/series.json
```

`creature-fx`、`en-action`、`live-action` 三個範例照第一行的寫法跑。

## 測試

改了腳本之後，在 repo 根目錄跑（需要 Node 18 以上）：

```
node --test
```

`tests/` 測的是重跑時 CSV 手填紀錄的保留、備份、已移除檔，以及集數和檔名的檢查。測試只在暫存資料夾裡建專案，不動範例的 `out/`。
