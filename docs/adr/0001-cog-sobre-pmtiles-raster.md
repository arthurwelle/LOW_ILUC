# 0001 — COG single-band + `cog://` em vez de tiles PNG raster em PMTiles

Status: aceito · 2026-07-12

## Contexto

O explorador mostra rasters de potencial/risco. O usuário exige duas coisas que
puxam a decisão: (a) **ler o valor exato do pixel** no hover e (b) **trocar de rampa
de cor no cliente**. Além disso a página é estática, servida localmente hoje e em
GitHub Pages no futuro (sem servidor de tiles/titiler).

## Decisão

Cada camada vira um **Cloud-Optimized GeoTIFF (COG) em EPSG:3857**, renderizado no
navegador via `maplibre-cog-protocol` (protocolo `cog://`, espelhando o `pmtiles://`
do projeto AGS). A colorização é feita no cliente (`setColorFunction` + d3); as
*overviews* internas do COG fazem a agregação por zoom.

## Alternativas consideradas

- **Tiles PNG raster em PMTiles** (cor cozida na build): mais simples e leve, mas o
  PNG **perde o valor bruto** — inviabiliza (a) e (b).
- **titiler / servidor de tiles dinâmico**: resolve tudo, mas exige backend —
  incompatível com GitHub Pages estático.

## Consequências

- (+) Valor exato no hover (`locationValues`) e troca de rampa/camada sem rebuild.
- (+) 1 arquivo estático por camada, servido por HTTP Range (ok em GitHub Pages).
- (−) Depende de lib WebGL (`maplibre-cog-protocol`) e de reprojeção para 3857 na
  build (`gdalwarp`). COGs precisam estar em 3857 (a lib não reprojeta).
- (−) `locationValues` no hover faz range-read; mitigado com throttle (1 leitura em
  voo por vez).
