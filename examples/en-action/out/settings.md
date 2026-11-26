# 夜市鐵盒　設定表

## 本次參數

| 項目 | 內容 |
|---|---|
| 形式 | 正式動畫 |
| 畫幅 | 16:9（在生成工具裡選，提示詞不含畫幅） |
| 圖像工具 | FLUX 3 |
| 影片工具 | Gemini Omni 1.2 Flash |
| 影片生成方式 | 圖生影片（先出首幀圖） |
| 首尾幀 | 使用 |
| 聲音方案 | 原生音訊 |
| 提示詞語言 | English |
| 參考圖模式 | 參考圖（提示詞用「image 1」這類編號指向參考圖，每一鏡依分鏡表列的順序上傳，一次最多 10 張） |
| 單次可生成秒數 | 3 到 10 |

## 待確認設定

以下是原文沒寫、先補上的暫定值。要改請直接說，改一處所有鏡頭會一起更新。

- C01 小滿的髮型與服裝：原文沒寫，暫定黑色齊下巴短髮、磚紅色連帽衫
- C02 雨衣男的長相：原文只寫穿雨衣，暫定四十多歲、方下巴、灰白鬍渣、深綠色雨衣
- P01 鐵盒的外觀：原文只寫鐵盒，暫定淺藍色方形餅乾鐵盒
- 風格：依題材暫定手繪動畫電影風
- 工具：暫定圖像用 FLUX 3、影片用 Gemini Omni，提示詞用英文、台詞說普通話

## 角色

| 編號 | 名稱 | 短稱 | 固定外貌 | 辨識特徵 | 造型變體 | 聲線 |
|---|---|---|---|---|---|---|
| C01 | 小滿 | the girl with the short black bob | a girl of about sixteen, round face, chin-length black bob with blunt bangs, large dark eyes, small slim build | a small adhesive bandage on her left cheek | C01-a（逃跑中）：an oversized brick-red hooded sweatshirt, dark denim shorts, white canvas sneakers；hair and shoulders damp from rain<br>C01-b（袖子裂開後）：an oversized brick-red hooded sweatshirt, dark denim shorts, white canvas sneakers；hair and shoulders wet from rain, the right sleeve torn open along the shoulder seam |  |
| C02 | 雨衣男 | the tall man in the green raincoat | a man in his forties, square jaw, short grey-flecked stubble, heavy brows, tall build with broad shoulders |  | C02-a（雨衣）：a long dark green rubber raincoat with the hood up, black work boots；rain beading on the raincoat | a low, gravelly male voice |

## 場景

| 編號 | 名稱 | 空間 | 光線 | 時間／天氣 | 色彩 |
|---|---|---|---|---|---|
| S01 | 夜市巷子 | a narrow night-market lane between two rows of wheeled food carts with canvas awnings, strings of bare bulbs hanging overhead along the lane, wet asphalt underfoot, a brick wall closing the far end of the lane | warm bulbs overhead, red and blue neon tubes reflected on the wet ground, deep shadows between the carts | night, steady rain | saturated red and blue neon accents against deep blue-grey shadows |

## 道具

| 編號 | 名稱 | 固定描述 |
|---|---|---|
| P01 | 鐵盒 | a battered square pale-blue biscuit tin |

## 風格鎖定句

```text
hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain
```

## 資產提示詞

先生成這些圖並定稿，之後每一鏡都掛它們當參考圖。

### C01-a　設定圖

```text
A girl of about sixteen, round face, chin-length black bob with blunt bangs, large dark eyes, small slim build, about 155 cm tall, an oversized brick-red hooded sweatshirt, dark denim shorts, white canvas sneakers, hair and shoulders damp from rain, a small adhesive bandage on her left cheek. Character reference sheet, the same character shown as front, side and back full-body views, natural standing pose, calm expression, plain light grey background, soft even lighting. Hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain.
```

### C01-b　設定圖（由 C01-a 改）

```text
Edit the C01-a character reference sheet: keep the face, hairstyle and build unchanged; change the look to: an oversized brick-red hooded sweatshirt, dark denim shorts, white canvas sneakers, hair and shoulders wet from rain, the right sleeve torn open along the shoulder seam.
```

### C01　表情組圖

```text
A girl of about sixteen, round face, chin-length black bob with blunt bangs, large dark eyes, small slim build, an oversized brick-red hooded sweatshirt, a small adhesive bandage on her left cheek. Expression sheet of the same character, bust view, same angle, expressions in order: calm, frightened, out of breath, relieved, plain light grey background, soft even lighting. Hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain.
```

### C02-a　設定圖

```text
A man in his forties, square jaw, short grey-flecked stubble, heavy brows, tall build with broad shoulders, about 185 cm tall, over a head taller than the girl with the short black bob, a long dark green rubber raincoat with the hood up, black work boots, rain beading on the raincoat. Character reference sheet, the same character shown as front, side and back full-body views, natural standing pose, calm expression, plain light grey background, soft even lighting. Hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain.
```

### S01　場景定稿圖

```text
A narrow night-market lane between two rows of wheeled food carts with canvas awnings, strings of bare bulbs hanging overhead along the lane, wet asphalt underfoot, a brick wall closing the far end of the lane. Warm bulbs overhead, red and blue neon tubes reflected on the wet ground, deep shadows between the carts, night, steady rain, saturated red and blue neon accents against deep blue-grey shadows. Scenery only, unoccupied, wide shot, eye level. Hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain.
```

### P01　道具圖

```text
A battered square pale-blue biscuit tin. A single object centred in frame, plain light grey background, soft even lighting. Hand-painted anime film style, clean ink outlines, cel shading with a single shadow tone, high saturation with strong contrast, soft film grain.
```

## 進度紀錄

- EP01 結束時：小滿（C01-b，右袖從肩線裂開）跪在 S01 攤車旁的積水裡，雙手抱著鐵盒；鐵盒蓋上多了一道凹痕；雨衣男已離開；時間是雨夜
