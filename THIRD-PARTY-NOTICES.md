# Third-party notices

OfficeVibe incorporates third-party source code and art assets. Their licenses
and required attributions are reproduced below. These terms apply in addition to
the project `LICENSE`; where they differ, the third-party terms govern the
material they cover.

---

## 1. Ported source code — `shahar061/the-office` (ISC)

OfficeVibe is derived from **[`shahar061/the-office`](https://github.com/shahar061/the-office)**.
In particular, the office-rendering engine under `src/renderer/src/scene/office/`
(e.g. `pathfinding.ts`, `TiledMapRenderer.ts`, `Camera.ts`, `SeatPool.ts`,
`Character.ts`, `CharacterSprite.ts`, `SpriteAdapter.ts`, `ToolBubble.ts`,
`portraitArt.ts`) and the Tiled maps under `src/renderer/src/assets/maps/`
(`office.tmj`, `lobby.tmj`) are ported or adapted from that project, which is
licensed under the ISC license:

```
ISC License

Copyright (c) 2026 shahar061

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## 2. Pixel art — LimeZu (FREE VERSION license, NON-COMMERCIAL)

The tilesets (`src/renderer/src/assets/tilesets/*.png`) and the base character
walk sheets used as recolor sources
(`src/renderer/src/assets/characters/{Adam,Alex,Amelia,Bob}_walk.png`) are
LimeZu pixel-art assets, distributed under the **LimeZu FREE VERSION license**
(see `src/renderer/src/assets/tilesets/LIMEZUASSETS-LICENSE.txt`):

```
FREE VERSION LICENSE:

CAN:
YOU CAN USE THE ASSET IN NON COMMERCIAL PROJECTS
YOU CAN EDIT THE SPRITES AND USE THEM IN NON COMMERCIAL PROJECTS

CAN'T:
YOU CAN'T USE THE ASSET IN COMMERCIAL PROJECTS
YOU CAN'T EDIT THE SPRITES AND USE THEM IN COMMERCIAL PROJECTS
YOU CAN'T EDIT AND RESELL THE SPRITES
```

The recolored Office-cast sprites in this repo are derived edits of these base
sheets and inherit the same **non-commercial** restriction. If OfficeVibe is ever
used commercially, these assets must be removed/replaced or a paid LimeZu license
obtained.

---

## 3. Office tileset — Donarg

`src/renderer/src/assets/tilesets/A2 Office Floors.png` is governed by the
**Donarg Office Tileset License Agreement** (license text embedded in the PNG):

```
Donarg Office Tileset License Agreement
Credit is not required but appreciated (Donarg).
Any violation of this agreement will result in the termination of the license.
```

---

See also `src/renderer/src/assets/ATTRIBUTION.md` for additional asset-level
notes, and `package.json` for the licenses of npm dependencies.
