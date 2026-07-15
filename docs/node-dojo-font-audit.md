# Node Dojo font-source audit

Audit date: 2026-07-13. Local recovered source folder: `/Users/ahmadjalil/Downloads/Node Dojo Extracted Fonts`.

## Recovered and Blender-validated

| Font | Source/use policy |
| --- | --- |
| `Blurmed.ttf` | Recovered from the Intro project; local commercial binary, embedded glyph outlines only |
| `Degular Text Semibold.ttf` | Recovered; local commercial binary, embedded glyph outlines only |
| `dogica.otf` | Recovered; local binary, embedded glyph outlines only pending license review |
| `Brokenscript OT Bold.ttf` | Recovered; local commercial binary, embedded glyph outlines only |
| `Pixels.ttf` | Byte-identical to Blender's packed version; published as `public/dojo/fonts/pixels.ttf` |
| `DejaVuSans-ExtraLight.ttf` | Official openly licensed DejaVu release; published with its license |

The raw Blurmed, Degular, Dogica, and Brokenscript files remain outside `public/`. Browser ports may include portable polygonal glyph outlines extracted by Blender, without distributing those font binaries. The Typewriter follows this model: exact evaluated Blurmed outlines for ASCII and the default em dash are embedded, while the page lets the user choose their local recovered TTF for matching editor text. Its frame-240 generated geometry now matches Blender exactly at 4,743 vertices / 33 faces.

## Still unavailable as exact binaries

- `BodoniStd-Poster.otf`
- `EurostileLTStd-BoldEx2.otf`
- `Caslon224Std-Black.otf`

Graphs using these three fonts remain source-limited unless a license-safe replacement is applied to both Blender truth and the browser comparison.
