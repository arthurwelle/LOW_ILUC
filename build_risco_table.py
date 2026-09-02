#!/usr/bin/env python3
"""Converte o CSV de risco por decêndio (DATA/*.gz) num JSON compacto para o app.

Entrada: CLAUDE/DATA/DuplaSafra_ZARC_siteMAPA_janelas_soja_e_milho.gz
  colunas: cultura,geocodigo,ciclo,solo,decendio,risco   (risco em {20,30,40,80})
  ciclo e solo vêm como CÓDIGOS (ciclo 20 = Grupo I; solo 11-16 = AD1-AD6,
  1/2/3 = Arenoso/Textura Média/Argiloso). A chave do JSON guarda o código cru —
  a tradução para rótulo fica em RISCO_ROWS no script.js, fonte única de apresentação.

Saída: CLAUDE/DATA/risco_decendio.json
  { "<geocodigo>": { "<cultura>|<ciclo>|<solo>": "<36 chars, 1=20 2=30 3=40 4=80>", ... }, ... }
  Combo ausente para um município = chave ausente (script.js trata como "sem dado").

Rodar: python CLAUDE/build_risco_table.py   (da raiz do repo, …/EMBRAPA_DADOS)
"""
import csv
import gzip
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'DATA', 'DuplaSafra_ZARC_siteMAPA_janelas_soja_e_milho.gz')
OUT = os.path.join(HERE, 'DATA', 'risco_decendio.json')

CODE = {'20': '1', '30': '2', '40': '3', '80': '4'}

# combo -> {decendio(int): code_char}
combos = {}

with gzip.open(SRC, 'rt', encoding='utf-8', newline='') as f:
    reader = csv.DictReader(f)
    for row in reader:
        geo = row['geocodigo']
        key = f"{row['cultura']}|{row['ciclo']}|{row['solo']}"
        dec = int(row['decendio'])
        code = CODE[row['risco']]
        combos.setdefault(geo, {}).setdefault(key, {})[dec] = code

out = {}
incomplete = 0
for geo, combo_map in combos.items():
    muni_out = {}
    for key, dec_map in combo_map.items():
        if len(dec_map) != 36:
            incomplete += 1
            continue  # combo incompleto (não deveria ocorrer; descartado por segurança)
        muni_out[key] = ''.join(dec_map[d] for d in range(1, 37))
    out[geo] = muni_out

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

size = os.path.getsize(OUT)
n_combos = sum(len(v) for v in out.values())
print(f'municípios: {len(out)}')
print(f'combos (linhas) totais: {n_combos}')
print(f'combos incompletos descartados: {incomplete}')
print(f'{OUT}: {size/1024/1024:.2f} MB')
