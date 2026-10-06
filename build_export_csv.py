#!/usr/bin/env python3
"""Exporta os resultados do app para CSV, para refazer mapas/tabelas no R (ggplot).

Le o que ja foi calculado (nada e recalculado aqui):
    DATA/raio_minimo.geojson   pontos + raio minimo + quantidade em raio fixo
    DATA/raio_minimo_meta.json resumo por cenario/porte
    DATA/resumo_uf.json        area e quantidade por UF
    DATA/captacao_uf.json      captado na uniao dos circulos, por UF x corte

Grava em MAPBIOMAS/Usinas/OUTPUT em formato LONGO (uma linha por combinacao), que
e o que o ggplot espera para facetar por cenario/porte.

So usa a biblioteca padrao - nao precisa do Python do QGIS:
    python CLAUDE/build_export_csv.py
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(HERE)
DATA = os.path.join(HERE, 'DATA')
OUT = os.path.join(RAIZ, 'MAPBIOMAS', 'Usinas', 'OUTPUT')

# rotulo curto de cenario, para legenda de grafico
ROTULO = {
    'n30_lag100_abertura_30': 'Alto risco (abertura 30, ciclo 100 d)',
    'n20_lag100_abertura_20': 'Baixo risco (abertura 20, ciclo 100 d)',
}


def escreve(nome, campos, linhas):
    caminho = os.path.join(OUT, nome)
    with open(caminho, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=campos)
        w.writeheader()
        w.writerows(linhas)
    print(f'  {nome:34} {len(linhas):>9,} linhas  '
          f'{os.path.getsize(caminho)/1e6:6.2f} MB')


def main():
    os.makedirs(OUT, exist_ok=True)
    gj = json.load(open(os.path.join(DATA, 'raio_minimo.geojson'), encoding='utf-8'))
    meta = json.load(open(os.path.join(DATA, 'raio_minimo_meta.json'), encoding='utf-8'))
    resumo_uf = json.load(open(os.path.join(DATA, 'resumo_uf.json'), encoding='utf-8'))
    cap = json.load(open(os.path.join(DATA, 'captacao_uf.json'), encoding='utf-8'))
    feats = gj['features']
    cenarios, metas = meta['cenarios'], meta['metas_kt']
    fixos = meta['raios_fixos_km']
    print(f'{len(feats):,} pontos | cenarios {cenarios} | metas {metas} | fixos {fixos}')

    # --- 1. pontos x cenario x porte: raio minimo -----------------------------
    linhas = []
    for f in feats:
        p = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        for cen in cenarios:
            for m in metas:
                r = p.get(f'r_{cen}_{m}')
                linhas.append({
                    'lon': lon, 'lat': lat, 'uf': p.get('uf'),
                    'cenario': cen, 'meta_kt': m,
                    'raio_min_km': '' if r is None else r,
                    'viavel': int(r is not None),
                })
    escreve('pontos_raio_minimo.csv',
            ['lon', 'lat', 'uf', 'cenario', 'meta_kt', 'raio_min_km', 'viavel'],
            linhas)

    # --- 2. pontos x cenario x raio fixo: quantidade captada ------------------
    linhas = []
    for f in feats:
        p = f['properties']
        lon, lat = f['geometry']['coordinates'][:2]
        for cen in cenarios:
            for rk in fixos:
                q = p.get(f'q_{cen}_{rk}')
                if q is None:
                    continue
                linhas.append({
                    'lon': lon, 'lat': lat, 'uf': p.get('uf'),
                    'cenario': cen, 'raio_km': rk, 'quantidade_mil_t': q,
                })
    escreve('pontos_raio_fixo.csv',
            ['lon', 'lat', 'uf', 'cenario', 'raio_km', 'quantidade_mil_t'],
            linhas)

    # --- 3. resumo por UF (potencial total e por cenario) ---------------------
    linhas = []
    for r in resumo_uf['ufs']:
        linhas.append({'uf': r['uf'], 'code_state': r['code_state'],
                       'cenario': 'total', 'cenario_rotulo': 'Total (sem cenario)',
                       'area_ha': r['area_total_ha'], 'quantidade_t': r['qtd_total_t']})
        for cen in resumo_uf['cenarios']:
            linhas.append({'uf': r['uf'], 'code_state': r['code_state'],
                           'cenario': cen, 'cenario_rotulo': ROTULO.get(cen, cen),
                           'area_ha': r[f'area_{cen}_ha'],
                           'quantidade_t': r[f'qtd_{cen}_t']})
    escreve('potencial_por_uf.csv',
            ['uf', 'code_state', 'cenario', 'cenario_rotulo', 'area_ha',
             'quantidade_t'], linhas)

    # --- 4. captado na uniao dos circulos, por UF x corte ---------------------
    passo = cap['passo_km']
    linhas = []
    for cen, por_meta in cap['dados'].items():
        for m, por_uf in por_meta.items():
            for uf, d in por_uf.items():
                for i, (a, q) in enumerate(zip(d['area_ha'], d['qtd_t'])):
                    linhas.append({
                        'cenario': cen, 'cenario_rotulo': ROTULO.get(cen, cen),
                        'meta_kt': int(m), 'corte_km': i * passo, 'uf': uf,
                        'area_ha': a, 'quantidade_t': q,
                    })
    escreve('captacao_uniao_por_uf.csv',
            ['cenario', 'cenario_rotulo', 'meta_kt', 'corte_km', 'uf', 'area_ha',
             'quantidade_t'], linhas)

    # --- 5. resumo por cenario x porte / raio fixo ----------------------------
    linhas = []
    for cen in cenarios:
        res = meta['resumo'][cen]
        for m in metas:
            d = res[str(m)]
            linhas.append({
                'cenario': cen, 'cenario_rotulo': ROTULO.get(cen, cen),
                'analise': 'raio_minimo', 'meta_kt': m, 'raio_km': '',
                'pontos_viaveis': d['viaveis'],
                'raio_mediana_km': d['raio_km_mediana'],
                'pontos_ate_50km': d['ate_50km'], 'pontos_ate_100km': d['ate_100km'],
                'quantidade_mediana_mil_t': '', 'quantidade_p99_mil_t': '',
                'quantidade_max_mil_t': '',
            })
        for rk in fixos:
            d = res[f'raio_{rk}']
            linhas.append({
                'cenario': cen, 'cenario_rotulo': ROTULO.get(cen, cen),
                'analise': 'raio_fixo', 'meta_kt': '', 'raio_km': rk,
                'pontos_viaveis': len(feats), 'raio_mediana_km': '',
                'pontos_ate_50km': '', 'pontos_ate_100km': '',
                'quantidade_mediana_mil_t': d['mediana_kt'],
                'quantidade_p99_mil_t': d['p99_kt'],
                'quantidade_max_mil_t': d['max_kt'],
            })
    escreve('resumo_cenarios.csv',
            ['cenario', 'cenario_rotulo', 'analise', 'meta_kt', 'raio_km',
             'pontos_viaveis', 'raio_mediana_km', 'pontos_ate_50km',
             'pontos_ate_100km', 'quantidade_mediana_mil_t',
             'quantidade_p99_mil_t', 'quantidade_max_mil_t'], linhas)

    # --- 6. parametros da corrida (procedencia) -------------------------------
    par = [
        ('passo_grade_km', meta['passo_grade_km']),
        ('res_busca_m', meta['res_busca_m']),
        ('raio_max_km', meta['raio_max_km']),
        ('tolerancia_meta', meta['tolerancia']),
        ('metas_kt', ';'.join(str(m) for m in metas)),
        ('raios_fixos_km', ';'.join(str(r) for r in fixos)),
        ('cenarios', ';'.join(cenarios)),
        ('ufs_excluidas_como_local', ';'.join(meta['ufs_excluidas'])),
        ('pontos_candidatos', len(feats)),
        ('corte_passo_km', passo),
        ('formula_producao', resumo_uf['formula']),
    ]
    # rotulo so aqui: repetido nos arquivos de ponto, dobraria o tamanho deles
    escreve('cenarios.csv', ['cenario', 'cenario_rotulo'],
            [{'cenario': c, 'cenario_rotulo': ROTULO.get(c, c)} for c in cenarios])
    escreve('parametros.csv', ['parametro', 'valor'],
            [{'parametro': k, 'valor': v} for k, v in par])
    print(f'\n-> {OUT}')


if __name__ == '__main__':
    main()
