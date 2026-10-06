# Low ILUC — explorador territorial

Página estática que explora, em escala de pixel, o potencial de expansão do milho de
2ª safra com **baixo risco de mudança indireta de uso da terra (low ILUC)** no Brasil.

Acompanha o trabalho *"Indicador espacial de risco de ILUC para o planejamento de
usinas de etanol de milho no Brasil"* (Embrapa Agricultura Digital).

O que dá para fazer:

- **Sobrepor camadas raster** (área potencial, solo, produtividade, cenários de risco),
  com opacidade por camada, lendo o **valor exato do pixel** no hover.
- Ver a **tabela de risco por decêndio** do município sob o cursor (36 decêndios ×
  9 combinações de cultura/solo).
- Ver **área e quantidade potenciais por UF**, por cenário.
- Ver o **raio mínimo de captação** de uma usina, por porte, e clicar num ponto para
  desenhar o círculo correspondente.

---

## Rodando

Precisa de servidor com **HTTP Range (206)** — COG e PMTiles leem pedaços do arquivo:

```
npx serve .
```

⚠️ `python -m http.server` **não serve**: devolve `200` e ignora Range, então os COGs
e PMTiles não carregam direito.

No GitHub Pages funciona sem configuração: o Pages suporta Range.

---

## Arquitetura

Tudo é estático — não há servidor de tiles nem backend.

| Camada de dados | Formato | Por quê |
|---|---|---|
| Rasters | **COG** em EPSG:3857 | valor bruto preservado; colorido no navegador (`cog://`), então dá para trocar rampa e ler o pixel exato. Overviews do COG = agregação por zoom. Ver [ADR 0001](docs/adr/0001-cog-sobre-pmtiles-raster.md) |
| Contornos | **PMTiles** vetorial | municípios/UFs, 1 arquivo servido por Range |
| Pontos de raio | **PMTiles** vetorial | 26 mil pontos com raleação por zoom |
| Tabelas | JSON pré-calculado | agregações impossíveis no navegador (237 M pixels) |

Basemap: **OpenFreeMap** (vetorial, sem API key), com as camadas de fundo escritas à
mão em vez de importar o estilo pronto.

---

## Camadas raster

10 camadas, todas extraídas do mesmo stack multibanda
(`stack_PAM_Risco_AreaApta_AreasConservacao_D.tif`, 20 bandas). Dos 12 cenários de
risco, apenas 2 entram no app.

```
bash build_cogs.sh          # roda da raiz do repo pai
```

Cada camada é uma linha em `build_cogs.sh` (`from_stack <banda> <id> <average|mode>
<dtype> <nodata>`) mais uma entrada em `layers.json`. **Não é preciso mexer no
`script.js`** para adicionar ou trocar camada.

Os valores são inteiros de faixa pequena, então são gravados em `Byte` (ou `UInt16` no
PAM) com NA explícito — em `Float32` o deploy passava de 200 MB; assim fica em 68 MB,
sem perda de informação.

`average` para variável contínua, `mode` para classe (nunca faz média de classe).

---

## Tabela de risco por decêndio

Hover num município preenche uma tabela de **9 linhas × 36 decêndios**: soja em 6
classes de solo (AD-1…AD-6) + milho 2ª safra em 3 texturas, num único ciclo (Grupo I).
A linha da classe de solo **sob o cursor** fica destacada.

Cores: 20 = azul, 30 = verde, 40 = laranja, 80 = "fora da janela" em cinza, linha
ausente (cultura não avaliada no município) em branco.

```
python build_risco_table.py
```

Lê o CSV bruto e grava `DATA/risco_decendio.json` (~1,9 MB; ~80 KB no gzip). `ciclo` e
`solo` ficam em código no JSON — a tradução para rótulo está em `RISCO_ROWS`, no topo
do `script.js`, que é o único lugar de apresentação.

---

## Área e quantidade por UF

```
bash build_resumo_uf.sh
```

Calculado sobre a grade **nativa EPSG:5880** — em 3857 a área por pixel seria
distorcida pelo Mercator e os totais sairiam errados. Confere dígito a dígito com o
`Usinas.Rmd` de referência.

A coluna **Total** é a área potencial sem ponderar por cenário; as colunas de cenário
aplicam a marcha de plantio (decêndios aptos ÷ 3).

---

## Raio mínimo de captação

Grade de candidatos de **10 km**. Para cada centroide, o menor raio cuja produção
somada alcança a meta (±2 %). Centroides em RS, SC, Nordeste, AM ou dentro de área de
conservação são descartados **como local de usina** — a biomassa ainda pode vir de
qualquer lugar dentro do raio.

| Porte | Viáveis (cen. 30) | Mediana | ≤ 50 km |
|---|---:|---:|---:|
| 120 mil t/ano | 26.381 | 70 km | 7.979 |
| 600 mil t/ano | 19.725 | 125 km | 600 |
| 2 Mt/ano | 7.324 | 152 km | 0 |

```
bash build_raio_minimo.sh     # ~3 min -> DATA/raio_minimo.geojson
bash build_raio_pmtiles.sh    # GeoJSON -> DATA/raio_minimo.pmtiles
```

**Captado (coluna da tabela à direita).** Produção e área sob a **união** dos círculos de
raio mínimo visíveis (cenário × porte × corte do slider), sobreposição contada uma vez,
por UF da célula. Para cada célula guarda-se T = menor raio que a cobre; a célula está
na união do corte X sse T ≤ X, então um histograma de T (passo 5 km) dá as 41 posições
do slider num passe só, na grade de 300 m. Conferido por força bruta (máscara booleana):
bate em 1 t.

```
bash build_captacao.sh        # ~3 min -> DATA/captacao_uf.json (33 KB)
```

**Raio fixo (análise inversa).** Nos mesmos pontos, a produção captada num raio fixo
de **100, 75 e 50 km** (`q_<cenário>_<km>`, mil t). No app, modo "Raio fixo": o slider
vira quantidade mínima. Custa uma soma de círculo por raio — sem bisseção.

| Raio | Mediana (cen. 30) | p99 | Máx. |
|---|---:|---:|---:|
| 100 km | 131 mil t | 2.228 mil t | 3.297 mil t |
| 75 km | 58 mil t | 1.389 mil t | 2.092 mil t |
| 50 km | 20 mil t | 693 mil t | 1.050 mil t |

**Algoritmo.** A soma dentro do círculo usa *prefix sum* por linha: um círculo é uma
pilha de segmentos de linha, então custa O(linhas) e não O(área) — para 200 km a 900 m
são ~445 consultas em vez de ~200 mil células. Como a soma cresce com o raio, a busca é
uma bisseção. A soma no raio máximo é calculada **uma vez por ponto** e reusada nas três
metas, então passar de 1 para 3 portes custa pouco. Medido: 0,76–1,28 ms/ponto,
3,5× mais rápido que a versão por histograma radial.

**Raleação por zoom.** O PMTiles tem duas camadas com faixas de zoom próprias (20 km
até z4, 10 km acima), porque o filtro do MapLibre **não aceita `['zoom']`** — a
raleação precisa estar no próprio tile.

O clique desenha um círculo **geodésico**; o raio foi calculado em EPSG:5880 (distância
plana). Para 200 km a diferença fica em centenas de metros — invisível no mapa, mas não
é o mesmo objeto matemático.

---

## Exportação para o artigo (CSV)

```
python build_export_csv.py       # -> ../MAPBIOMAS/Usinas/OUTPUT/*.csv
```

Formato longo (uma linha por combinação), para refazer mapas e tabelas no ggplot:
pontos com raio mínimo, pontos com quantidade em raio fixo, potencial por UF, captação
pela união dos círculos, resumo e parâmetros da corrida. Só biblioteca padrão — não
precisa do Python do QGIS. Dicionário dos arquivos em `OUTPUT/LEIAME.md`.

---

## Estrutura

```
index.html  script.js  style.css        # o app (sem framework, sem build step)
layers.json                             # MANIFEST das camadas raster
COG/*.tif                               # 10 COGs (EPSG:3857, 300 m) — ~68 MB
GEO/*.pmtiles                           # contornos de municípios e UFs
DATA/risco_decendio.json                # risco por decêndio, por município
DATA/resumo_uf.json                     # área e quantidade por UF
DATA/raio_minimo.pmtiles + _meta.json   # pontos de raio mínimo
build_*.sh  build_*.py                  # pipelines (usam o GDAL do QGIS)
docs/adr/                               # decisões de arquitetura
```

Os **insumos de build** (rasters de origem, CSVs `.gz`, GeoJSON intermediário, grades
auxiliares) ficam **fora do repositório** — ver `.gitignore`. Só o que o site lê em
runtime é versionado.

Os pipelines usam o Python e o GDAL que vêm com o **QGIS** (o Python do sistema não tem
GDAL). Ajuste `QGIS_DIR` nos `.sh` se o caminho for outro.

---

## Créditos

Dados: MapBiomas (uso e cobertura), ZARC/MAPA-Embrapa (risco climático), PAM/IBGE
(produtividade), Embrapa Solos (água disponível), geobr/IPEA (limites).
Basemap: © OpenStreetMap · OpenFreeMap · OpenMapTiles.
