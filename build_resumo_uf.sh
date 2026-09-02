#!/usr/bin/env bash
# Gera CLAUDE/DATA/resumo_uf.json (area e quantidade potenciais por UF, por cenario).
#
# Usa o Python do QGIS: o Python do sistema não tem GDAL. Rodar da raiz do repo:
#   bash CLAUDE/build_resumo_uf.sh
#
# Depende de CLAUDE/DATA/_uf_grid.tif (UFs rasterizadas na grade do stack).
# Se não existir, este script o gera a partir de CLAUDE/GEO/ufs.gpkg.
set -euo pipefail

Q="${QGIS_DIR:-/c/Program Files/QGIS 3.38.0}"
export PYTHONHOME="$Q/apps/Python312"
export PATH="$Q/bin:$Q/apps/Python312:$Q/apps/Python312/Scripts:$PATH"
export GDAL_DATA="$Q/share/gdal"
export PROJ_LIB="$Q/share/proj"

STACK="MAPBIOMAS/stack_PAM_Risco_AreaApta_AreasConservacao_D.tif"
UFGRID="CLAUDE/DATA/_uf_grid.tif"

if [ ! -f "$UFGRID" ]; then
  echo "### rasterizando UFs na grade do stack"
  # ufs.gpkg vem em SIRGAS geografico (graus) e o stack esta em EPSG:5880 (metros).
  # gdal_rasterize NAO reprojeta: sem este ogr2ogr a extensao nao se cruza e sai
  # um raster vazio (foi o que aconteceu na primeira tentativa).
  SRS=$("$Q/bin/gdalsrsinfo.exe" -e "$STACK" | grep -m1 "^EPSG:")
  echo "    reprojetando ufs.gpkg -> $SRS"
  rm -f CLAUDE/DATA/_ufs_proj.gpkg
  "$Q/bin/ogr2ogr.exe" -t_srs "$SRS" CLAUDE/DATA/_ufs_proj.gpkg CLAUDE/GEO/ufs.gpkg
  read XMIN YMAX XMAX YMIN W H <<< $("$Q/bin/gdalinfo.exe" -json "$STACK" | "$Q/bin/python3.exe" -c "
import json,sys
d=json.load(sys.stdin); gt=d['geoTransform']; w,h=d['size']
print(gt[0], gt[3], gt[0]+gt[1]*w, gt[3]+gt[5]*h, w, h)")
  "$Q/bin/gdal_rasterize.exe" -a code_state -a_nodata 0 -ot Byte     -te "$XMIN" "$YMIN" "$XMAX" "$YMAX" -ts "$W" "$H"     -co COMPRESS=DEFLATE CLAUDE/DATA/_ufs_proj.gpkg "$UFGRID"
  rm -f CLAUDE/DATA/_ufs_proj.gpkg
fi

echo "### agregando por UF"
"$Q/bin/python3.exe" CLAUDE/build_resumo_uf.py
