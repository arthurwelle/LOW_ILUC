#!/usr/bin/env python3
"""Producao (e area) captada pela UNIAO dos circulos de raio minimo, por UF, para
cada cenario x porte x corte do slider (0..200 km, passo 5).

PROBLEMA
  No app, o corte X mostra os pontos com raio minimo r <= X, cada um com seu
  circulo. Os circulos se sobrepoem muito; a pergunta e quanto produzem as celulas
  cobertas por PELO MENOS UM circulo (sem contar duas vezes).

TRUQUE - um passe serve para os 41 cortes
  Para cada celula, T = menor r entre os circulos que a cobrem. A celula esta na
  uniao do corte X  <=>  T <= X. Entao basta:
    1. pintar T (circulos em ordem DECRESCENTE de r, atribuicao simples: o menor
       sobrescreve) - grade de 900 m, a mesma geometria do Somador;
    2. histograma de T em passos de 5 km, ponderado pela producao, por UF;
    3. soma cumulativa -> valor para cada posicao do slider.
  O passo 2 roda na grade de 300 m (T repetido 3x3), entao a divisao por UF e exata
  e bate com a coluna do cenario na tabela.

Entradas: stack, DATA/_uf_grid.tif, DATA/raio_minimo.geojson
Saida:    DATA/captacao_uf.json
Rodar:    bash CLAUDE/build_captacao.sh
"""
import json
import os
import sys
import time

import numpy as np
from osgeo import gdal, osr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_raio_minimo import (B_AREA_POT, B_CONSERV, B_PAM, CENARIOS, DECENDIOS,
                               FATOR, HA_POR_UNIDADE, LINHAS_BLOCO, STACK, UF_SIGLA,
                               UFGRID, limpa)

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
GJ = os.path.join(HERE, 'DATA', 'raio_minimo.geojson')
OUT = os.path.join(HERE, 'DATA', 'captacao_uf.json')

PASSO_KM = 5
CORTE_MAX_KM = 200
NB = CORTE_MAX_KM // PASSO_KM + 1          # 41 posicoes do slider
N_UF = 60


def pinta_T(lin_b, col_b, r_km, Hc, Wc, res_m):
    """T[celula] = menor raio (km) que a cobre; inf se nenhum."""
    T = np.full((Hc, Wc), np.inf, dtype=np.float32)
    ordem = np.argsort(-r_km, kind='stable')   # maior primeiro; o menor sobrescreve
    for k in ordem:
        rk = float(r_km[k])
        rc = rk * 1000.0 / res_m
        rr = int(rc)
        cy, cx = int(lin_b[k]), int(col_b[k])
        y0, y1 = max(cy - rr, 0), min(cy + rr + 1, Hc)
        dy = np.arange(y0 - cy, y1 - cy)
        meia = np.sqrt(np.maximum(rc * rc - dy * dy, 0.0)).astype(np.int64)
        x0 = np.clip(cx - meia, 0, Wc)
        x1 = np.clip(cx + meia + 1, 0, Wc)
        for y, a, b in zip(range(y0, y1), x0.tolist(), x1.tolist()):
            T[y, a:b] = rk
    return T


def main():
    for p in (STACK, UFGRID, GJ):
        if not os.path.exists(p):
            sys.exit(f'faltando: {p}')
    ds = gdal.Open(STACK)
    gt = ds.GetGeoTransform()
    W, H = ds.RasterXSize, ds.RasterYSize
    Wc, Hc = -(-W // FATOR), -(-H // FATOR)
    res_busca = gt[1] * FATOR

    gj = json.load(open(GJ, encoding='utf-8'))
    feats = gj['features']
    metas = gj['metadata']['metas_kt']

    src = osr.SpatialReference(); src.ImportFromEPSG(4326)
    dst = osr.SpatialReference(); dst.ImportFromEPSG(5880)
    for s in (src, dst):
        s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(src, dst)
    xy = np.array(tr.TransformPoints([f['geometry']['coordinates'][:2] for f in feats]))
    lin_b = (((gt[3] - xy[:, 1]) / gt[1]).astype(np.int64)) // FATOR
    col_b = (((xy[:, 0] - gt[0]) / gt[1]).astype(np.int64)) // FATOR

    b_area, b_pam = ds.GetRasterBand(B_AREA_POT), ds.GetRasterBand(B_PAM)
    b_cons = ds.GetRasterBand(B_CONSERV)
    uf_ds = gdal.Open(UFGRID)          # manter a referencia: sem ela o GC fecha o dataset
    b_uf = uf_ds.GetRasterBand(1)

    saida = {'passo_km': PASSO_KM, 'corte_max_km': CORTE_MAX_KM,
             'cenarios': list(CENARIOS), 'metas_kt': metas, 'dados': {}}

    for nome, banda in CENARIOS.items():
        print(f'\n### {nome}')
        Ts = {}
        for m in metas:
            campo = f'r_{nome}_{m}'
            r = np.array([f['properties'].get(campo) if f['properties'].get(campo) is not None
                          else np.nan for f in feats], dtype=np.float64)
            ok = np.isfinite(r) & (r <= CORTE_MAX_KM)
            t0 = time.time()
            Ts[m] = pinta_T(lin_b[ok], col_b[ok], r[ok], Hc, Wc, res_busca)
            print(f'  T {m} kt: {int(ok.sum()):,} circulos em {time.time()-t0:.1f}s')

        # hist[m][grandeza] -> (N_UF * NB) somas por (uf, bin)
        hist = {m: {'q': np.zeros(N_UF * NB), 'a': np.zeros(N_UF * NB)} for m in metas}
        b_cen = ds.GetRasterBand(banda)
        t0 = time.time()
        for y in range(0, H, LINHAS_BLOCO):
            n = min(LINHAS_BLOCO, H - y)
            apot = limpa(b_area.ReadAsArray(0, y, W, n).astype(np.float64), b_area)
            if not apot.any():
                continue
            pam = limpa(b_pam.ReadAsArray(0, y, W, n).astype(np.float64), b_pam)
            cons = limpa(b_cons.ReadAsArray(0, y, W, n).astype(np.float64), b_cons)
            cen = limpa(b_cen.ReadAsArray(0, y, W, n).astype(np.float64), b_cen)
            uf = b_uf.ReadAsArray(0, y, W, n).astype(np.int64)

            area = apot * HA_POR_UNIDADE * (cons != 1) * (cen / DECENDIOS)
            prod = area * pam / 1000.0
            sel = (area > 0) & (uf > 0)
            if not sel.any():
                continue
            yy, xx = np.nonzero(sel)
            a_s, q_s, u_s = area[sel], prod[sel], uf[sel]
            ty, tx = (yy + y) // FATOR, xx // FATOR
            for m in metas:
                t = Ts[m][ty, tx]
                fin = np.isfinite(t)
                if not fin.any():
                    continue
                kbin = np.ceil(t[fin] / PASSO_KM - 1e-9).astype(np.int64)
                idx = u_s[fin] * NB + np.clip(kbin, 0, NB - 1)
                hist[m]['q'] += np.bincount(idx, weights=q_s[fin], minlength=N_UF * NB)
                hist[m]['a'] += np.bincount(idx, weights=a_s[fin], minlength=N_UF * NB)
            print(f'  {100*(y+n)/H:5.1f}%', end='\r', flush=True)
        print(f'  somas por UF: {time.time()-t0:.1f}s')

        saida['dados'][nome] = {}
        for m in metas:
            qc = np.cumsum(hist[m]['q'].reshape(N_UF, NB), axis=1)
            ac = np.cumsum(hist[m]['a'].reshape(N_UF, NB), axis=1)
            ufs = {}
            for cod in range(N_UF):
                if qc[cod, -1] <= 0 and ac[cod, -1] <= 0:
                    continue
                ufs[UF_SIGLA.get(cod, str(cod))] = {
                    'qtd_t': [round(float(v)) for v in qc[cod]],
                    'area_ha': [round(float(v)) for v in ac[cod]],
                }
            saida['dados'][nome][str(m)] = ufs
            tot = qc.sum(axis=0)
            print(f'  {m:>4} kt: captado <=50km {tot[10]:>14,.0f} t | '
                  f'<=100km {tot[20]:>14,.0f} t | <=200km {tot[-1]:>14,.0f} t')

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))
    print(f'\n{OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)')


if __name__ == '__main__':
    main()
