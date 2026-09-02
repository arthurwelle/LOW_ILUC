#!/usr/bin/env python3
"""Agrega area e quantidade potenciais por UF, para cada cenario, e grava um JSON
pequeno que o app so exibe (o calculo e impossivel no navegador: 237 milhoes de
pixels por camada).

Duas grandezas por UF, conferidas contra o Usinas.Rmd (bate digito a digito):

  TOTAL (sem ponderar por cenario) - equivale a linha 2271 do Rmd:
    area_total_ha = area_potencial * 0,09            (zerado dentro de UC)
    qtd_total_t   = area_total_ha * pam / 1000       (fator de risco = 1)

  POR CENARIO (ponderado pela marcha) - equivale a linha 2256 do Rmd:
    area_ha      = area_total_ha * (cenario / 3)
    quantidade_t = area_ha * pam / 1000

  * 0,09 ha = um pixel de 30 m. A celula de 300 m comporta 100 deles => max 9 ha.
  * cenario/3 = "marcha de plantio": 1 decendio apto habilita 1/3 da area,
    2 habilitam 2/3, 3 habilitam a area toda.
  * PAM esta em kg/ha, por isso /1000 para toneladas.

Entradas (grade nativa SIRGAS Polyconic 300 m - NAO usar os COGs em 3857, cuja
area por pixel e distorcida pelo Mercator):
    MAPBIOMAS/stack_PAM_Risco_AreaApta_AreasConservacao_D.tif
    CLAUDE/DATA/_uf_grid.tif   (UFs rasterizadas na mesma grade; ver README)

Saida: CLAUDE/DATA/resumo_uf.json

Rodar com o Python do QGIS (o do sistema nao tem GDAL):
    bash CLAUDE/build_resumo_uf.sh
"""
import json
import os
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(HERE)
STACK = os.path.join(RAIZ, 'MAPBIOMAS',
                     'stack_PAM_Risco_AreaApta_AreasConservacao_D.tif')
UFGRID = os.path.join(HERE, 'DATA', '_uf_grid.tif')
OUT = os.path.join(HERE, 'DATA', 'resumo_uf.json')

# banda (1-based) no stack
B_AREA_POT = 3
B_PAM = 7
B_CONSERV = 8
# ordem = ordem das colunas no painel: permissivo (30) antes do restritivo (20)
CENARIOS = {'n30_lag100_abertura_30': 16, 'n20_lag100_abertura_20': 9}

HA_POR_UNIDADE = 0.09   # 1 pixel de 30 m
DECENDIOS = 3.0         # marcha: cenario 0..3

UF_SIGLA = {
    11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO',
    21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL',
    28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR',
    42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
}

LINHAS_BLOCO = 256   # ~15448 x 256 pixels por leitura


def limpa(a, ds_band):
    """NaN/nodata -> 0."""
    nd = ds_band.GetNoDataValue()
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
    if nd is not None and not np.isnan(nd):
        a = np.where(a == nd, 0.0, a)
    return a


def main():
    for p in (STACK, UFGRID):
        if not os.path.exists(p):
            sys.exit(f'faltando: {p}')

    ds = gdal.Open(STACK)
    uf_ds = gdal.Open(UFGRID)
    W, H = ds.RasterXSize, ds.RasterYSize
    if (uf_ds.RasterXSize, uf_ds.RasterYSize) != (W, H):
        sys.exit('grade das UFs nao bate com a do stack')

    b_area = ds.GetRasterBand(B_AREA_POT)
    b_pam = ds.GetRasterBand(B_PAM)
    b_cons = ds.GetRasterBand(B_CONSERV)
    b_cen = {k: ds.GetRasterBand(v) for k, v in CENARIOS.items()}
    b_uf = uf_ds.GetRasterBand(1)

    # por cenario: [cenario][uf] -> valor
    area = {k: {} for k in CENARIOS}
    qtd = {k: {} for k in CENARIOS}
    # totais sem ponderar por cenario (fator de risco = 1): [uf] -> valor
    area_tot = {}
    qtd_tot = {}
    # diagnostico: area_potencial ja exclui unidades de conservacao?
    cel_pot_em_uc = 0
    cel_pot = 0

    for y in range(0, H, LINHAS_BLOCO):
        n = min(LINHAS_BLOCO, H - y)
        uf = b_uf.ReadAsArray(0, y, W, n).astype(np.int32)
        if not uf.any():
            continue
        apot = limpa(b_area.ReadAsArray(0, y, W, n).astype(np.float32), b_area)
        pam = limpa(b_pam.ReadAsArray(0, y, W, n).astype(np.float32), b_pam)
        cons = limpa(b_cons.ReadAsArray(0, y, W, n).astype(np.float32), b_cons)

        cel_pot += int((apot > 0).sum())
        cel_pot_em_uc += int(((apot > 0) & (cons == 1)).sum())

        # Fator UC do artigo: 0 dentro de unidade de conservacao, 1 fora.
        # Verificado empiricamente que area_potencial NAO exclui essas areas
        # (3,79% das celulas com potencial caem dentro delas), por isso a mascara.
        fora_uc = (cons != 1).astype(np.float32)
        ha_cel = apot * HA_POR_UNIDADE * fora_uc
        q_cel = ha_cel * pam / 1000.0          # quantidade com fator de risco = 1
        ufs_bloco = np.unique(uf[uf > 0])

        for u in ufs_bloco:
            m = uf == u
            k = int(u)
            area_tot[k] = area_tot.get(k, 0.0) + float(ha_cel[m].sum())
            qtd_tot[k] = qtd_tot.get(k, 0.0) + float(q_cel[m].sum())

        for nome, banda in b_cen.items():
            cen = limpa(banda.ReadAsArray(0, y, W, n).astype(np.float32), banda)
            a_ha = ha_cel * (cen / DECENDIOS)
            q_t = a_ha * pam / 1000.0
            for u in ufs_bloco:
                m = uf == u
                area[nome][int(u)] = area[nome].get(int(u), 0.0) + float(a_ha[m].sum())
                qtd[nome][int(u)] = qtd[nome].get(int(u), 0.0) + float(q_t[m].sum())

        pct = 100.0 * (y + n) / H
        print(f'  {pct:5.1f}%', end='\r', flush=True)

    print()
    frac_uc = (cel_pot_em_uc / cel_pot * 100) if cel_pot else 0.0
    print(f'celulas com area_potencial > 0: {cel_pot:,}')
    print(f'  dentro de area de conservacao: {cel_pot_em_uc:,} ({frac_uc:.3f}%)')
    if frac_uc < 0.01:
        print('  -> area_potencial JA exclui conservacao; nada a descontar')
    else:
        print('  -> ATENCAO: ha sobreposicao; considerar aplicar a mascara')

    saida = {
        'formula': ('area_ha = area_potencial * 0.09 * (cenario/3), zerado dentro de '
                    'area de conservacao; quantidade_t = area_ha * pam_kg_ha / 1000'),
        'diagnostico_conservacao': {
            'celulas_potencial': cel_pot,
            'celulas_potencial_em_uc': cel_pot_em_uc,
            'percentual': round(frac_uc, 4),
        },
        'cenarios': {},
    }
    nomes = list(CENARIOS)
    linhas = []
    for cod in sorted(area_tot):
        if area_tot[cod] <= 0:
            continue
        linha = {
            'uf': UF_SIGLA.get(cod, str(cod)),
            'code_state': cod,
            'area_total_ha': round(area_tot[cod], 1),
            'qtd_total_t': round(qtd_tot[cod], 1),
        }
        for nome in nomes:
            linha[f'area_{nome}_ha'] = round(area[nome].get(cod, 0.0), 1)
            linha[f'qtd_{nome}_t'] = round(qtd[nome].get(cod, 0.0), 1)
        linhas.append(linha)
    linhas.sort(key=lambda r: -r['qtd_total_t'])

    somas = {}
    for ch in linhas[0] if linhas else []:
        if ch in ('uf', 'code_state'):
            continue
        somas[ch] = round(sum(r[ch] for r in linhas), 1)

    saida['cenarios'] = nomes
    saida['totais'] = somas
    saida['ufs'] = linhas

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))

    print(f'\n{OUT}  ({os.path.getsize(OUT)/1024:.1f} KB)  {len(linhas)} UFs')
    print(f"  {'TOTAL (sem cenario)':30} {somas['area_total_ha']:>15,.0f} ha  "
          f"{somas['qtd_total_t']:>15,.0f} t")
    for nome in nomes:
        print(f"  {nome:30} {somas[f'area_{nome}_ha']:>15,.0f} ha  "
              f"{somas[f'qtd_{nome}_t']:>15,.0f} t")


if __name__ == '__main__':
    main()
