#!/usr/bin/env python3
"""Converte DATA/raio_minimo.geojson em DATA/raio_minimo.pmtiles, com menos
pontos nos zooms baixos e todos nos zooms altos.

POR QUE NAO E SO "CONVERTER"
  Nao ha tippecanoe aqui, entao a raleacao por zoom e feita na marra - o que e
  trivial neste caso porque os pontos estao numa grade REGULAR de 10 km: basta
  pegar 1 a cada 4 (40 km) para o zoom baixo e 1 a cada 2 (20 km) para o medio.
  Cada nivel vira uma CAMADA propria dentro do mesmo PMTiles, com sua faixa de
  zoom declarada no CONF do driver MVT do GDAL. Assim o tile do zoom 4 carrega
  ~1,6 mil pontos em vez de 26 mil.

  Os niveis sao cumulativos (o nivel 0 tambem aparece nas camadas de zoom maior),
  senao os pontos "sumiriam" ao aproximar.

  O filtro do MapLibre nao aceita ['zoom'], por isso a separacao tem de existir
  no proprio tile / em camadas de estilo com minzoom/maxzoom - nao da para fazer
  com um unico filtro por atributo.

Rodar:  bash CLAUDE/build_raio_pmtiles.sh
"""
import json
import os
import subprocess
import sys

from osgeo import ogr, osr

ogr.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
GJ = os.path.join(HERE, 'DATA', 'raio_minimo.geojson')
GPKG = os.path.join(HERE, 'DATA', '_raio_niveis.gpkg')
MBT = os.path.join(HERE, 'DATA', '_raio_minimo.mbtiles')
OUT = os.path.join(HERE, 'DATA', 'raio_minimo.pmtiles')

QGIS = os.environ.get('QGIS_DIR', r'C:\Program Files\QGIS 3.38.0')
OGR2OGR = os.path.join(QGIS, 'bin', 'ogr2ogr.exe')
PY = os.path.join(QGIS, 'bin', 'python3.exe')

# grade de origem (EPSG:5880), para recuperar os indices i/j de cada ponto
X0, Y0 = 2771100.0, 10640400.0
PASSO = 10_000.0

NIVEIS = [
    # (nome da camada, nivel maximo incluido, minzoom, maxzoom)
    # Densidade alta de proposito: na grade de 10 km o teto e mostrar tudo, e a
    # partir do z4 o Brasil ja ocupa varios tiles, entao a carga por tile fica
    # baixa mesmo com todos os pontos.
    ('raios_z0', 1, 0, 4),    # 1 a cada 2 -> 20 km
    ('raios_z1', 2, 4, 11),   # todos      -> 10 km
]


def nivel_do_ponto(i, j):
    if i % 4 == 0 and j % 4 == 0:
        return 0
    if i % 2 == 0 and j % 2 == 0:
        return 1
    return 2


def main():
    if not os.path.exists(GJ):
        sys.exit(f'faltando: {GJ} (rode build_raio_minimo.sh antes)')
    gj = json.load(open(GJ, encoding='utf-8'))
    feats = gj['features']
    meta = gj['metadata']
    print(f'{len(feats):,} pontos em {os.path.basename(GJ)}')

    # lon/lat -> EPSG:5880 para recuperar o indice na grade
    src = osr.SpatialReference(); src.ImportFromEPSG(4326)
    dst = osr.SpatialReference(); dst.ImportFromEPSG(5880)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(src, dst)
    xy = tr.TransformPoints([f['geometry']['coordinates'][:2] for f in feats])

    niveis = []
    for (x, y, *_ ) in xy:
        i = round((x - X0) / PASSO - 0.5)
        j = round((Y0 - y) / PASSO - 0.5)
        niveis.append(nivel_do_ponto(i, j))
    for n in (0, 1, 2):
        print(f'  nivel {n}: {niveis.count(n):,} pontos')

    # --- GeoPackage com uma camada por nivel (cumulativo) ---
    if os.path.exists(GPKG):
        os.remove(GPKG)
    drv = ogr.GetDriverByName('GPKG')
    dsw = drv.CreateDataSource(GPKG)
    srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    campos = [k for k in feats[0]['properties'] if k != 'uf']
    for nome, nmax, _, _ in NIVEIS:
        lay = dsw.CreateLayer(nome, srs, ogr.wkbPoint)
        lay.CreateField(ogr.FieldDefn('uf', ogr.OFTString))
        for c in campos:
            lay.CreateField(ogr.FieldDefn(c, ogr.OFTReal))
        defn = lay.GetLayerDefn()
        lay.StartTransaction()
        n = 0
        for f, nv in zip(feats, niveis):
            if nv > nmax:
                continue
            ft = ogr.Feature(defn)
            ft.SetField('uf', f['properties'].get('uf') or '?')
            for c in campos:
                v = f['properties'].get(c)
                if v is not None:
                    ft.SetField(c, float(v))
            lon, lat = f['geometry']['coordinates'][:2]
            g = ogr.Geometry(ogr.wkbPoint); g.AddPoint_2D(lon, lat)
            ft.SetGeometry(g)
            lay.CreateFeature(ft)
            n += 1
        lay.CommitTransaction()
        print(f'  {nome}: {n:,} feicoes')
    dsw = None

    # --- MVT -> MBTiles, com a faixa de zoom de cada camada ---
    conf = {nome: {'minzoom': mn, 'maxzoom': mx} for nome, _, mn, mx in NIVEIS}
    if os.path.exists(MBT):
        os.remove(MBT)
    cmd = [OGR2OGR, '-f', 'MBTiles', MBT, GPKG,
           '-dsco', 'MINZOOM=0', '-dsco', 'MAXZOOM=11',
           '-dsco', f'CONF={json.dumps(conf)}',
           '-dsco', 'MAX_FEATURES=500000',
           # padrao do GDAL e 500 KB: tile de ponto maior que isso e DESCARTADO
           # inteiro (buracos retangulares no z4-z5). Ponto nao simplifica.
           '-dsco', 'MAX_SIZE=4000000',
           '-dsco', 'NAME=raio_minimo',
           '-dsco', 'DESCRIPTION=Raio minimo de captacao por quadra']
    print('\n### gerando tiles vetoriais')
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-2000:]); print(r.stderr[-2000:])
        sys.exit('ogr2ogr falhou')
    print(f'  {MBT}  ({os.path.getsize(MBT)/1e6:.1f} MB)')

    # --- MBTiles -> PMTiles ---
    if os.path.exists(OUT):
        os.remove(OUT)
    print('### convertendo para PMTiles')
    # chamada direta da funcao: o pacote nao expoe `python -m pmtiles.convert`
    # (o modulo nao tem __main__), so o script pmtiles-convert.
    sys.path.insert(0, os.path.expanduser(
        r'~\AppData\Roaming\Python\Python312\site-packages'))
    from pmtiles.convert import mbtiles_to_pmtiles
    mbtiles_to_pmtiles(MBT, OUT, 11)
    if not os.path.exists(OUT):
        sys.exit('pmtiles convert falhou')
    os.remove(MBT); os.remove(GPKG)

    print(f'\n{OUT}  ({os.path.getsize(OUT)/1e6:.2f} MB)')
    print(f'  camadas: {", ".join(n for n, _, _, _ in NIVEIS)}')
    print(f'  metas: {meta["metas_kt"]} | cenarios: {meta["cenarios"]}')

    # metadados que o app usa (o PMTiles nao carrega o nosso 'metadata')
    # Histograma CUMULATIVO do raio, em passos de 5 km (o passo do slider).
    # Com PMTiles as feicoes chegam sob demanda, entao o app nao consegue contar
    # quantos pontos passam no corte lendo os dados - vem daqui.
    PASSO_HIST = 5
    limites = list(range(0, int(meta['raio_max_km']) + PASSO_HIST, PASSO_HIST))
    hist = {}
    for cen in meta['cenarios']:
        hist[cen] = {}
        for m in meta['metas_kt']:
            vals = [f['properties'].get(f'r_{cen}_{m}') for f in feats]
            vals = sorted(v for v in vals if v is not None)
            acum, k = [], 0
            for lim in limites:
                while k < len(vals) and vals[k] <= lim:
                    k += 1
                acum.append(k)
            hist[cen][str(m)] = acum

    # Raio fixo: UMA escala de cor/slider para todos os raios (p99 do maior raio,
    # arredondado para cima em 50 kt) e contagem cumulativa de pontos com q >= limiar.
    # Escala por raio normalizava cada mapa e escondia que 100 km capta mais que 50.
    N_PASSOS_Q = 40
    escala_q, hist_q = {}, {}
    rks = meta.get('raios_fixos_km', [])
    p99 = max((meta['resumo'][c][f'raio_{rk}']['p99_kt']
               for c in meta['cenarios'] for rk in rks), default=0)
    esc = max(50, -(-int(p99) // 50) * 50)
    for rk in rks:
        escala_q[str(rk)] = esc
        limiares = [esc * i / N_PASSOS_Q for i in range(N_PASSOS_Q + 1)]
        for cen in meta['cenarios']:
            vals = sorted(f['properties'].get(f'q_{cen}_{rk}') or 0.0 for f in feats)
            acum, k = [], 0
            for lim in limiares:          # quantos ficam ABAIXO do limiar
                while k < len(vals) and vals[k] < lim:
                    k += 1
                acum.append(len(vals) - k)
            hist_q.setdefault(cen, {})[str(rk)] = acum

    mj = os.path.join(HERE, 'DATA', 'raio_minimo_meta.json')
    with open(mj, 'w', encoding='utf-8') as f:
        json.dump({**meta,
                   'camadas': [{'source_layer': n, 'minzoom': mn, 'maxzoom': mx}
                               for n, _, mn, mx in NIVEIS],
                   'hist_passo_km': PASSO_HIST,
                   'hist_cumulativo': hist,
                   'q_escala_kt': escala_q,
                   'q_passos': N_PASSOS_Q,
                   'hist_q_cumulativo': hist_q},
                  f, ensure_ascii=False)
    print(f'  {mj}  ({os.path.getsize(mj)/1024:.1f} KB)')


if __name__ == '__main__':
    main()
