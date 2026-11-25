# 各生成工具的能力對照

> **查證日期：2026-11-25。** 內容來自各家官方文件（來源列在最後）。這個領域幾個月就會大改，這次查證時就發現 Sora 已停止服務、可靈與即夢都換了大版本、Google 正在用 Gemini Omni 取代 Veo。
>
> 所以請這樣用這份表：
> - 使用者說的工具或版本不在表裡，或今天距離查證日期超過三個月，而且你能上網搜尋：先查官方文件再決定參數。
> - 不能搜尋：照表填，並在交付時告訴使用者這些值可能過時，請他確認三件事：單次可生成幾秒、有沒有負面提示詞欄位、支不支援首尾幀。
> - 標「未查證」的格子不要當成事實。

## 不太會變的做法

這幾條是各家文件共同的方向，比版本細節可靠。

- **先出首幀圖，再圖生影片。** 外貌和構圖在圖像階段鎖定，影片階段只管怎麼動。
- **圖生影片的提示詞只寫動作與運鏡。** Runway 的說法是「不要描述圖片裡已經有的東西，用提示詞描述畫面的運動」，Vidu 也是「專心描述動作，不要重複圖片內容」。腳本在圖生影片模式下就是這樣組合的。
- **少用否定句，負面詞預設留空。** 目前多數影片工具沒有負面提示詞欄位，而且官方都提醒否定句容易適得其反（Runway：否定寫法可能產生相反的結果；可靈：負面提示會增加出錯機率；即夢：盡量使用正向描述；Veo：不要寫「不要」）。做法是把「不要什麼」改寫成「要什麼」：不寫「不要多餘手指」，而是在 `hands` 把兩隻手的位置寫清楚。只有確定工具有獨立的負面詞欄位時才填 `negative_global`。可靈與即夢的文件提到「不要字幕」「無背景音樂」這類短指令是有效的。
- **台詞用雙引號括起來。** 有原生音訊的工具都用引號辨識台詞，腳本在「原生音訊」方案下會自動這樣寫。提示詞是英文、台詞是中文時，填 `speech_lang` 讓腳本註明用哪種語言說。不想要工具自己加字幕，把「不要字幕」填進 `audio_suffix`。
- **參考圖用工具自己的指稱語法**（例如 `@Image1`、`@图片1`），把 `refs` 欄列的圖依序掛上去。

## 影片工具

| 工具（查證時的版本） | 提示詞語言 | 負面詞欄位 | 首尾幀 | 參考圖 | 單次秒數 | 原生音訊 |
|---|---|---|---|---|---|---|
| **可靈 Kling 4.0**（2026-10 推出；另有較輕量的 4.0 Flash） | 中文、英文都可以；官方範例是英文敘述加上目標語言的台詞。官方是否建議某一種語言：未查證 | API 沒有這個參數；網頁介面未查證 | 支援首幀、尾幀、首尾幀與中間關鍵幀，最多 10 張；Flash 版不支援首尾幀同時使用 | 全能參考：最多 15 個素材，用 `@Image1`、`@Element1` 指稱 | 3 到 30 秒，每秒一級；Flash 3 到 20 秒 | 有：立體聲、台詞、音效、配樂，口型同步；支援粵語等方言 |
| **即夢 Seedance 2.5**（2026-07 發布） | 中文、英文都支援；上限約 500 個中文字或 1000 個英文詞 | API 沒有這個參數；即夢介面未查證 | API 支援首幀與尾幀；即夢網頁版的首尾幀模式未查證 | 全能參考：最多 30 張圖，用 `@图片1`、`@视频1` 指稱 | 4 到 30 秒 | 有：人聲、音效、配樂預設開啟，台詞用雙引號 |
| **Vidu**（Q3 系列；Q4 Preview 於 2026-10 推出） | 官方稱支援兩百多種語言；中英何者較好：未查證 | API 沒有這個參數；介面未查證 | Q3 支援首尾幀；Q4 Preview 目前只吃一張首幀 | Q4 參考生影片：1 到 15 張圖，可加聲音參考 | Q3 為 1 到 16 秒；Q4 為 3 到 16 秒 | 有：預設開啟，另有獨立的對口型工具 |
| **Google Veo 3.1**（正在被取代，Flow 上的 Fast 與 Quality 於 2026-12-05 下架） | 英文 | Vertex API 有 `negativePrompt`；Flow 介面未查證 | 支援首幀，或首尾幀 | 「素材生影片」最多 3 張，只能 8 秒 | 4、6 或 8 秒 | 有：台詞用引號，可寫 `SFX:`、`Ambient noise:` |
| **Google Gemini Omni 1.2 Flash**（Flow、Gemini app 與 API 的新預設） | 官方只說英文完整支援，其他語言未評估 | 官方明說不支援 | API 支援首尾幀（此時 3 到 10 秒） | 最多 6 張參考圖 | 3 到 15 秒 | 有：影片與聲音同步生成 |
| **Runway Gen-4.5** | 官方範例都是英文；是否支援中文：未查證 | 沒有，而且官方警告否定寫法會出反效果 | 只支援首幀 | 影片模式沒有參考圖輸入；參考圖功能在 Gen-4 圖像，最多 3 張 | 2 到 10 秒 | 官方說法互相矛盾，視為未查證 |
| **OpenAI Sora** | 據查已停止服務：網頁與 App 於 2026-04、API 於 2026-09。官方頁面擋了自動讀取，這一條沒能直接複核。使用者提到 Sora 時，請他確認是否還能用，或改用其他工具 | | | | | |

### 對應到 `bible.json`

| 工具 | `prompt_langs` | `negative_global` | `use_last_frame` | 秒數 |
|---|---|---|---|---|
| 可靈 4.0 | `["zh"]`（使用者用國際版且偏好英文時用 `["en"]`） | 留空 | `true`（Flash 版 `false`） | `"clip_range": [3, 30]` |
| 即夢 Seedance 2.5 | `["zh"]` | 留空 | `true` | `"clip_range": [4, 30]` |
| Vidu Q3 | `["zh"]` | 留空 | `true` | `"clip_range": [1, 16]` |
| Veo 3.1 | `["en"]` | 留空；使用者確定走 Vertex API 時才填 | `true` | `"clip_lengths": [4, 6, 8]` |
| Gemini Omni | `["en"]` | 留空 | `true` | `"clip_range": [3, 10]` |
| Runway Gen-4.5 | `["en"]` | 留空 | `false` | `"clip_range": [2, 10]` |

工具能一次生成很長的片段，不代表分鏡要寫長鏡頭。單鏡仍以 2 到 5 秒、一個動作為原則，長片段留給真的需要連續表演的鏡頭。

可靈 4.0 的文件說它能穩定生成畫面中的文字。使用者用這類工具、而且字很短（招牌上的兩三個字）時，可以放寬「畫面不出現可讀文字」的規則，並在 `risk` 註明要檢查字有沒有寫對；長的文字仍然後製加。

## 圖像工具

| 工具（查證時的版本） | 提示詞語言 | 負面詞 | 參考圖 | 長度上限 |
|---|---|---|---|---|
| **即夢圖像 Seedream 5.5**（2026-11 發布） | 中文、英文都支援 | API 沒有這個參數；即夢介面未查證 | 最多 10 張 | 約 300 個中文字或 600 個英文詞 |
| **Midjourney V8.2**（2026-07 起為預設） | 官方範例是英文；未查到明文說明 | `--no 項目, 項目` | V8.1 與 V8.2 用 Edit Model 掛最多 4 張參考圖，取代了 `--oref` 與 `--cref`；`--sref` 風格參考仍可用。`--oref` 只適用 V7，`--cref` 是更舊的參數 | 未查證 |
| **FLUX 3**（2026-10 發布） | 官方範例是英文；中文提示詞未查證 | 沒有負面詞欄位 | 最多 10 張，在提示詞裡用 image 1、image 2 指稱 | 未查證 |

表裡沒有的圖像工具（例如 Google 的圖像模型、可靈自己的圖像生成）這次沒有查證，使用者用到時請他確認長度上限與參考圖張數，或上網查。

圖像工具有長度上限時，填進 `prompt_limits`，腳本會檢查每一鏡組合後的提示詞有沒有超過，例如即夢圖像：`"prompt_limits": {"image": {"zh": 300, "en": 600}}`。兩個角色都完整描述的鏡頭很容易超過，解法是填 `bg`、`outfit_top`，把背影角色設成 `partial`。

## 聲音與後製

這部分沒有逐一查證版本，只列分工：

- **口型**：工具的原生音訊做不到，或聲線每鏡不一致時，用獨立的對口型工具處理，對白鏡頭保持固定機位。
- **配音與旁白**：TTS 或真人錄音，每個角色先固定聲線。
- **剪接、調色、字幕、混音**：剪映、CapCut、DaVinci Resolve 這類剪輯軟體。

## 來源（重新查證時從這裡開始）

- 可靈：kling.ai/quickstart/kling-4-model-user-guide、kling.ai/document-api/api/usage-guide/kling-4-0
- 即夢 Seedance：docs.volcengine.com/docs/ark/seedance-2-5、docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide、docs.volcengine.com/docs/ark/create-video-generation-task-api
- Vidu：platform.vidu.com/docs/overview/model-map
- Google：support.google.com/flow/answer/16352836、aistudio.google.com/docs/omni、docs.cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide
- Runway：help.runwayml.com 的「Creating with Gen-4.5」「Image to Video Prompting Guide」「Gen-4 Video Prompting Guide」
- Sora：help.openai.com 的「What to know about the Sora discontinuation」
- Midjourney：docs.midjourney.com 的「Version」「Edit Model」「Omni Reference」「No」
- FLUX：docs.bfl.ai/release-notes、docs.bfl.ai/guides/prompting_unified_technical
- 即夢圖像 Seedream：docs.volcengine.com/docs/ark/image-generation-api
