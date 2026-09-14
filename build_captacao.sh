#!/usr/bin/env bash
# Gera CLAUDE/DATA/captacao_uf.json (producao na uniao dos circulos, por UF).
# Usa o Python do QGIS: o do sistema nao tem GDAL.
#   bash CLAUDE/build_captacao.sh
set -euo pipefail
Q="${QGIS_DIR:-/c/Program Files/QGIS 3.38.0}"
export PYTHONHOME="$Q/apps/Python312"
export PATH="$Q/bin:$Q/apps/Python312:$Q/apps/Python312/Scripts:$PATH"
export GDAL_DATA="$Q/share/gdal"
export PROJ_LIB="$Q/share/proj"
"$Q/bin/python3.exe" CLAUDE/build_captacao.py
