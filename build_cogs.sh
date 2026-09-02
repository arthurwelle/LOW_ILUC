#!/usr/bin/env bash
# Build EPSG:3857 Cloud-Optimized GeoTIFFs (COG) for the raster explorer.
# One-time local step. Requires GDAL (uses QGIS 3.38 install by default).
# Run from repo root (…/EMBRAPA_DADOS):  bash CLAUDE/build_cogs.sh
set -euo pipefail

GDAL_BIN="${GDAL_BIN:-/c/Program Files/QGIS 3.38.0/bin}"
WARP="$GDAL_BIN/gdalwarp.exe"
TRANSLATE="$GDAL_BIN/gdal_translate.exe"
INFO="$GDAL_BIN/gdalinfo.exe"

SRC="MAPBIOMAS"
OUT="CLAUDE/COG"
OUT_LOCAL="CLAUDE/COG_local"
TMP="$OUT/_tmp"
mkdir -p "$TMP" "$OUT_LOCAL"

# Big warps: give GDAL room and threads.
export GDAL_CACHEMAX=2048
export GDAL_NUM_THREADS=ALL_CPUS

RES=300   # target resolution in metres (EPSG:3857)



# categorical_float_native <src.tif> <id>   (local-only, ~30m nativo, sem downsample)
# Saída em CLAUDE/COG_local/ (gitignored) — nunca vai para o GitHub Pages.
# Arquivos de origem pesados (500MB-1GB); roda 1 de cada vez, checar espaço em disco.
categorical_float_native() {
  local src="$SRC/$1.tif" id="$2"
  echo "### [$id] categorical NATIVE ~30m (mode) -> COG_local/"
  "$WARP" -t_srs EPSG:3857 -tr 30 30 -r mode \
    -multi -wo NUM_THREADS=ALL_CPUS \
    -co COMPRESS=DEFLATE -overwrite "$src" "$TMP/$id.tif"
  "$TRANSLATE" -of COG \
    -co COMPRESS=DEFLATE -co OVERVIEW_RESAMPLING=MODE -co BLOCKSIZE=512 \
    "$TMP/$id.tif" "$OUT_LOCAL/$id.tif"
  rm -f "$TMP/$id.tif"
}

# ---- camadas de deploy: todas vêm de UM stack multibanda ----
# stack_PAM_Risco_AreaApta_AreasConservacao_D.tif (20 bandas, 300 m, SIRGAS Polyconic).
# Só 10 bandas entram no app — dos 12 cenários de risco, apenas 2 (bandas 9 e 16).
STACK="stack_PAM_Risco_AreaApta_AreasConservacao_D"

# from_stack <banda> <id> <average|mode> <dtype> <nodata>
#   average = variável contínua · mode = classes (nunca faz média de classe)
#   dtype/nodata: no stack tudo é Float32/NaN, mas os valores são inteiros de faixa
#   pequena. Gravar em Byte (ou UInt16 no PAM) com NA explícito corta ~4x o tamanho
#   sem perder informação — Float32 gastava 4 bytes/pixel para guardar 0..100.
from_stack() {
  local band="$1" id="$2" resamp="$3" dtype="$4" nd="$5"
  local ov=AVERAGE; [ "$resamp" = mode ] && ov=MODE
  echo "### [$id] banda $band ($resamp, $dtype, NA=$nd)"
  "$TRANSLATE" -b "$band" "$SRC/$STACK.tif" "$TMP/${id}_b.tif"
  WOPT="-multi -wo NUM_THREADS=ALL_CPUS -co COMPRESS=DEFLATE -overwrite"
  "$WARP" -t_srs EPSG:3857 -tr $RES $RES -r "$resamp" -ot "$dtype" -dstnodata "$nd" $WOPT "$TMP/${id}_b.tif" "$TMP/$id.tif"
  COPT="-co COMPRESS=DEFLATE -co BLOCKSIZE=512"
  "$TRANSLATE" -of COG -a_nodata "$nd" $COPT -co OVERVIEW_RESAMPLING=$ov "$TMP/$id.tif" "$OUT/$id.tif"
  rm -f "$TMP/${id}_b.tif" "$TMP/$id.tif"
}

from_stack  1  soja_1_safra                average  Byte    255
from_stack  2  segunda_safra               average  Byte    255
from_stack  3  area_potencial              average  Byte    255
from_stack  4  area_potencial2016          average  Byte    255
from_stack  5  area_potencial2008          average  Byte    255
from_stack  6  solo                        mode     Byte    255
from_stack  7  pam_produtividade_media     average  UInt16  65535
from_stack  8  areas_conservacao           mode     Byte    255
from_stack  9  cen_n20_lag100_abertura_20  mode     Byte    255
from_stack 16  cen_n30_lag100_abertura_30  mode     Byte    255

# ---- camadas pesadas, local-only (COG_local/, gitignored) ----
# Rodar 1 de cada vez; checar espaço livre em disco antes (arquivos de origem 500MB-1GB).

echo
echo "=== done. COGs (deploy): ==="
ls -la "$OUT"/*.tif
echo "=== done. COGs (local-only, gitignored): ==="
ls -la "$OUT_LOCAL"/*.tif 2>/dev/null
echo "=== verifying CRS + overviews ==="
for f in "$OUT"/*.tif "$OUT_LOCAL"/*.tif; do
  [ -f "$f" ] || continue
  echo "-- $f"
  "$INFO" "$f" 2>/dev/null | grep -E "EPSG\",3857|Overviews|Band 1|NoData" | head -4
done
