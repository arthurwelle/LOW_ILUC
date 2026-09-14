/* Explorador de rasters — COG (cog://) + MapLibre + contornos PMTiles.
   Padrão herdado do projeto AGS. Colorização client-side via d3 + setColorFunction. */

// ---- protocolos ----
maplibregl.addProtocol('cog', MaplibreCOGProtocol.cogProtocol);
const pmProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmProtocol.tile.bind(pmProtocol));

// ---- rampas contínuas (d3) ----
const SCHEMES = {
  RdYlGn: d3.interpolateRdYlGn,
  YlGnBu: d3.interpolateYlGnBu,
  Viridis: d3.interpolateViridis,
  Turbo: d3.interpolateTurbo,
};

// ---- estado ----
const BEFORE_ID = 'municipios-outline'; // rasters entram abaixo dos contornos
let LAYERS = [];

// Varias camadas podem ficar visiveis ao mesmo tempo (sobreposicao para comparar).
// Cada uma tem source+layer proprios, com id derivado do id da camada.
const SELECTED = new Set();
const selectedDefs = () => LAYERS.filter((d) => SELECTED.has(d.id));
const srcId = (id) => `raster-src-${id}`;
const lyrId = (id) => `raster-lyr-${id}`;

// Opacidade por camada (0-100), lembrada individualmente: cada camada mantém o
// valor escolhido e o reaplica quando volta a ser selecionada.
const OPACITY = {};
const OPACITY_PADRAO = 90;
const getOpacity = (id) => (id in OPACITY ? OPACITY[id] : OPACITY_PADRAO);

// ---- tabela de risco por decêndio (soja + milho 2ª safra, ciclo único) ----
// Origem: CLAUDE/DATA/risco_decendio.json (gerado por build_risco_table.py a partir
// do CSV cultura,geocodigo,ciclo,solo,decendio,risco, com ciclo/solo em código).
// Chave por município:
// "<cultura>|<ciclo>|<solo>" -> string de 36 chars, 1 char por decêndio
// (1=risco 20, 2=risco 30, 3=risco 40, 4=fora da janela/80).
const RISK_CHAR_COLOR = { '1': '#24466d', '2': '#50a23e', '3': '#b2793f', '4': '#d9d9d9' };
const RISK_CHAR_LABEL = { '1': 'Risco 20', '2': 'Risco 30', '3': 'Risco 40', '4': 'Fora da janela (80)' };
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// 9 linhas fixas, na ordem em que aparecem na tabela.
// As chaves usam os CÓDIGOS do CSV (ciclo 20 = Grupo I; solo 11-16 = AD1-AD6 para soja,
// 1/2/3 = Arenoso/Textura Média/Argiloso para milho). Único lugar que traduz código->rótulo.
const RISCO_ROWS = [
  ...[[11, 'AD-1'], [12, 'AD-2'], [13, 'AD-3'],
      [14, 'AD-4'], [15, 'AD-5'], [16, 'AD-6']].map(([cod, label]) => ({
    group: 'Soja — Grupo I', label, key: `Soja|20|${cod}`,
  })),
  ...[[1, 'Arenoso'], [2, 'Textura média'], [3, 'Argiloso']].map(([cod, label]) => ({
    group: 'Milho 2ª Safra — Grupo I', label, key: `Milho 2ª Safra|20|${cod}`,
  })),
];

let RISCO_DATA = null; // { geocodigo: { "cultura|ciclo|solo": "36 chars" } }
let lastRiscoGeo = undefined; // evita re-render a cada pixel do mousemove
let lastMuniName = null;
let currentAD = null; // "AD-3" no ponto do cursor (lido de solo_ad.tif), null = sem highlight
let soloLookupBusy = false;
let SOLO_FILE = null; // resolvido após LAYERS carregar (layers.json entry id:'solo')

// caminho absoluto p/ o protocolo cog:// (evita ambiguidade de relativo)
const absUrl = (file) => new URL(file, location.href).href;
const cogUrl = (file) => 'cog://' + absUrl(file);

// ---- paleta do basemap (tema claro) ----
// 'terra' é o background: a água agora é camada de verdade, então nada de fundo azulado.
const BASE = {
  terra: '#eef2f6', agua: '#cfe0ee', rio: '#b9d2e6',
  fronteira: '#a3b1bf', rotulo: '#5a6672', halo: 'rgba(255,255,255,0.9)',
};

// ---- mapa ----
const map = new maplibregl.Map({
  container: 'map',
  center: [-53, -14],
  zoom: 3.6,
  style: {
    version: 8,
    // Basemap vetorial OpenFreeMap (keyless). A URL é a do TileJSON: o caminho real
    // dos tiles é versionado e rotaciona — deixar o MapLibre resolver evita quebra futura.
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ' +
          '<a href="https://openfreemap.org/">OpenFreeMap</a> · ' +
          '<a href="https://openmaptiles.org/">OpenMapTiles</a>',
      },
      municipios: { type: 'vector', url: 'pmtiles://./GEO/municipios.pmtiles', promoteId: 'code_muni' },
      estados: { type: 'vector', url: 'pmtiles://./GEO/ufs.pmtiles' },
    },
    layers: [
      // 'background' agora é a TERRA (a água virou camada própria).
      { id: 'background', type: 'background', paint: { 'background-color': BASE.terra } },

      // guarda de geometry-type: a mesma source-layer traz polígonos e linhas
      { id: 'base-water', type: 'fill', source: 'basemap', 'source-layer': 'water',
        filter: ['all',
          ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
          ['!=', ['get', 'brunnel'], 'tunnel'],
        ],
        paint: { 'fill-color': BASE.agua } },

      { id: 'base-waterway', type: 'line', source: 'basemap', 'source-layer': 'waterway',
        minzoom: 6,
        filter: ['all',
          ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
          ['match', ['get', 'class'], ['river', 'canal'], true, false],
        ],
        paint: { 'line-color': BASE.rio,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.6] } },

      // IGUALDADE em admin_level: muitas feições vêm sem a chave e '<=' as descarta
      { id: 'base-boundary', type: 'line', source: 'basemap', 'source-layer': 'boundary',
        filter: ['all',
          ['==', ['get', 'admin_level'], 2],
          ['!=', ['get', 'maritime'], 1],
          ['!=', ['get', 'disputed'], 1],
          ['!', ['has', 'claimed_by']],
        ],
        paint: { 'line-color': BASE.fronteira,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.2] } },

      // fill invisível: só para queryRenderedFeatures pegar o nome do município no hover
      { id: 'municipios-fill', type: 'fill', source: 'municipios', 'source-layer': 'mun',
        paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      // >>> o raster de dados entra AQUI (antes de 'municipios-outline') <<<
      { id: 'municipios-outline', type: 'line', source: 'municipios', 'source-layer': 'mun',
        paint: { 'line-color': '#ffffff', 'line-width': 0.3, 'line-opacity': 0.6 } },
      { id: 'estados-outline', type: 'line', source: 'estados', 'source-layer': 'ufs',
        paint: { 'line-color': '#5a5a5a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 1.2] } },

      // Rótulos por ÚLTIMO, de propósito: ficam acima do raster de dados (opacidade 0,9),
      // senão sumiriam sob ele. Níveis em camadas separadas — 'filter' não aceita ['zoom'].
      { id: 'base-place-pais', type: 'symbol', source: 'basemap', 'source-layer': 'place',
        maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:pt'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 6, 14],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.1,
          'text-max-width': 7,
        },
        paint: { 'text-color': BASE.rotulo, 'text-halo-color': BASE.halo, 'text-halo-width': 1.2 } },

      { id: 'base-place-cidade', type: 'symbol', source: 'basemap', 'source-layer': 'place',
        minzoom: 4,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:pt'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 13],
          'text-max-width': 8,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 20],
        },
        paint: { 'text-color': BASE.rotulo, 'text-halo-color': BASE.halo, 'text-halo-width': 1.2 } },

      { id: 'base-place-vila', type: 'symbol', source: 'basemap', 'source-layer': 'place',
        minzoom: 7,
        filter: ['==', ['get', 'class'], 'town'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:pt'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 11, 12],
          'text-max-width': 8,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 20],
        },
        paint: { 'text-color': BASE.rotulo, 'text-halo-color': BASE.halo, 'text-halo-width': 1.2 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// ---- color function por camada ----
function makeColorFn(def) {
  const hidden = new Set(def.hideValues || []); // valores tratados como NA (transparente)
  if (def.type === 'continuous') {
    const [min, max] = def.domain;
    const interp = SCHEMES[def.scheme] || d3.interpolateViridis;
    // lowValue (opcional): valores abaixo de .max saem numa cor fixa (cinza) em vez
    // da ponta da rampa. A rampa segue ancorada em [min,max] — só a faixa baixa muda.
    const low = def.lowValue || null;
    const lowRgb = low ? d3.rgb(low.color) : null;
    return (pixel, color) => {
      const v = pixel[0];
      if (v == null || Number.isNaN(v) || (def.nodata != null && v === def.nodata) || hidden.has(v)) {
        color.set([0, 0, 0, 0]); return;
      }
      if (low && v < low.max) { color.set([lowRgb.r, lowRgb.g, lowRgb.b, 255]); return; }
      let t = (v - min) / (max - min);
      t = Math.max(0, Math.min(1, t));
      if (def.reverse) t = 1 - t;
      const c = d3.rgb(interp(t));
      color.set([c.r, c.g, c.b, 255]);
    };
  }
  // categórico
  const lut = new Map(def.classes.map((c) => [c.v, d3.rgb(c.color)]));
  return (pixel, color) => {
    const v = pixel[0];
    const key = Math.round(v);
    if (v == null || Number.isNaN(v) || (def.nodata != null && v === def.nodata) || hidden.has(key)) {
      color.set([0, 0, 0, 0]); return;
    }
    const c = lut.get(key);
    if (!c) { color.set([0, 0, 0, 0]); return; }
    color.set([c.r, c.g, c.b, 255]);
  };
}

// ---- sincroniza as camadas raster visiveis ----
function syncRasterLayers() {
  // tira todas e recria: forma simples de garantir a ordem de empilhamento
  for (const def of LAYERS) {
    if (map.getLayer(lyrId(def.id))) map.removeLayer(lyrId(def.id));
    if (map.getSource(srcId(def.id))) map.removeSource(srcId(def.id));
  }
  // Ordem: cada addLayer(..., beforeId) entra logo ABAIXO de BEFORE_ID, entao o
  // ultimo adicionado fica por cima. Percorrendo o manifesto ao contrario, a
  // primeira camada da lista termina no topo do mapa - como se espera de uma
  // lista de camadas.
  const beforeId = map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
  for (const def of [...LAYERS].reverse()) {
    if (!SELECTED.has(def.id)) continue;
    // A source usa cog://<abs>. O render procura a color function pela URL SEM o
    // esquema (regex cog://(.+)/z/x/y -> chave = <abs>), entao registramos com absUrl.
    MaplibreCOGProtocol.setColorFunction(absUrl(def.file), makeColorFn(def));
    map.addSource(srcId(def.id), { type: 'raster', url: cogUrl(def.file), tileSize: 256 });
    map.addLayer({
      id: lyrId(def.id), source: srcId(def.id), type: 'raster',
      paint: { 'raster-resampling': 'nearest', 'raster-opacity': getOpacity(def.id) / 100 },
    }, beforeId);
  }
}

function toggleLayer(def, ligar) {
  if (ligar) SELECTED.add(def.id); else SELECTED.delete(def.id);
  syncRasterLayers();
  renderLegend();
  renderList();
  renderDesc();
}

function renderDesc() {
  const sel = selectedDefs();
  // com varias camadas a descricao de todas ficaria longa; a legenda ja as nomeia
  document.getElementById('layer-desc').textContent =
    sel.length === 1 ? (sel[0].description || '') : '';
}

// ---- valor formatado p/ hover/legenda ----
function formatValue(def, v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (def.type === 'categorical') {
    const cls = def.classes.find((c) => c.v === Math.round(v));
    return cls ? cls.label : `valor ${Math.round(v)}`;
  }
  const [, max] = def.domain;
  const s = max <= 1 ? v.toFixed(3) : v.toFixed(max <= 100 ? 1 : 0);
  return def.unit ? `${s} ${def.unit}` : s;
}

// ---- legenda (um bloco por camada selecionada) ----
function legendaDe(def) {
  if (def.type === 'continuous') {
    const interp = SCHEMES[def.scheme] || d3.interpolateViridis;
    const stops = [];
    for (let i = 0; i <= 10; i++) {
      let t = i / 10; if (def.reverse) t = 1 - t;
      stops.push(`${d3.rgb(interp(t))} ${i * 10}%`);
    }
    const [min, max] = def.domain;
    return `
      <div class="legend-bar" style="background:linear-gradient(to right, ${stops.join(',')})"></div>
      <div class="legend-scale"><span>${min}</span><span>${max}</span></div>
      ${def.unit ? `<div class="legend-unit">${def.unit}</div>` : ''}
      ${def.lowValue ? `<div class="legend-cat" style="margin-top:6px"><span class="legend-swatch" style="background:${def.lowValue.color}"></span>${def.lowValue.label}</div>` : ''}`;
  }
  return def.classes.map((c) =>
    `<div class="legend-cat"><span class="legend-swatch" style="background:${c.color}"></span>${c.label}</div>`
  ).join('');
}

function renderLegend() {
  const el = document.getElementById('legend');
  const sel = selectedDefs();
  if (!sel.length) { el.innerHTML = '<div class="hint">Nenhuma camada marcada.</div>'; return; }
  el.innerHTML = sel.map((def) =>
    `<div class="legend-bloco"><div class="legend-titulo">${def.label}</div>${legendaDe(def)}</div>`
  ).join('');
}

// ---- lista de camadas (checkbox + slider de opacidade) ----
function renderList() {
  const el = document.getElementById('layer-list');
  el.innerHTML = '';
  LAYERS.forEach((def) => {
    const marcada = SELECTED.has(def.id);
    const val = getOpacity(def.id);

    const row = document.createElement('div');
    row.className = 'layer-row';

    // O label envolve so o checkbox e o nome. O slider fica FORA dele - dentro,
    // qualquer clique/arraste no slider tambem marcaria/desmarcaria a camada.
    const lab = document.createElement('label');
    lab.className = 'layer-item' + (marcada ? ' active' : '');
    lab.innerHTML = `<input type="checkbox" ${marcada ? 'checked' : ''}><span>${def.label}</span>`;
    lab.querySelector('input').addEventListener('change', (ev) => toggleLayer(def, ev.target.checked));

    const sld = document.createElement('input');
    sld.type = 'range';
    sld.className = 'layer-opacity';
    sld.min = 0; sld.max = 100; sld.step = 5; sld.value = val;
    sld.title = `Opacidade: ${val}%`;
    sld.addEventListener('input', () => {
      const v = Number(sld.value);
      OPACITY[def.id] = v;
      sld.title = `Opacidade: ${v}%`;
      // aplica ao vivo se a camada estiver no mapa; senao fica guardado
      if (map.getLayer(lyrId(def.id))) {
        map.setPaintProperty(lyrId(def.id), 'raster-opacity', v / 100);
      }
    });

    row.appendChild(lab);
    row.appendChild(sld);
    el.appendChild(row);
  });
}

// ---- legenda fixa da tabela de risco (estática, não depende de dado carregado) ----
function renderRiscoLegend() {
  const el = document.getElementById('risco-legend');
  const items = [
    ['1', 'Risco 20'], ['2', 'Risco 30'], ['3', 'Risco 40'],
    ['4', 'Fora da janela'], [null, 'Sem dado / cultura ausente'],
  ];
  el.innerHTML = items.map(([code, label]) => {
    const color = code ? RISK_CHAR_COLOR[code] : '#ffffff';
    const border = code ? 'transparent' : '#ccc';
    return `<div class="legend-cat"><span class="legend-swatch" style="background:${color};border-color:${border}"></span>${label}</div>`;
  }).join('');
}

// ---- tabela de risco: cabeçalho (meses/decêndios) construído 1x ----
function riscoTableHead() {
  const monthCells = MONTHS.map((m) => `<th colspan="3">${m}</th>`).join('');
  return `<thead>
    <tr class="rt-month-row"><th></th>${monthCells}</tr>
  </thead>`;
}

// ---- corpo da tabela: agrupado em 3 blocos (soja c1, soja c2, milho) ----
// currentAD ("AD-3", lido de solo_ad.tif no cursor) só bate com linhas de Soja —
// linhas de Milho têm rótulos diferentes (Arenoso/Argiloso/Textura média), nunca destacam.
function riscoTableBody(geo, currentAD) {
  const muniData = geo && RISCO_DATA ? RISCO_DATA[geo] : null;
  let html = '';
  let curGroup = null;
  for (const row of RISCO_ROWS) {
    if (row.group !== curGroup) {
      curGroup = row.group;
      html += `<tr class="rt-group-row"><th colspan="37">${curGroup}</th></tr>`;
    }
    const series = muniData ? muniData[row.key] : undefined;
    const absent = !series;
    const isCurrent = currentAD != null && row.label === currentAD;
    let cells = '';
    for (let i = 0; i < 36; i++) {
      const monthStart = i % 3 === 0 ? ' rt-month-start' : '';
      if (absent) {
        cells += `<td class="rt-cell rt-absent${monthStart}"></td>`;
      } else {
        const ch = series[i];
        const color = RISK_CHAR_COLOR[ch] || '#ffffff';
        const title = `${row.label} · decêndio ${i + 1} · ${RISK_CHAR_LABEL[ch] || '—'}`;
        cells += `<td class="rt-cell${monthStart}" style="background:${color}" title="${title}"></td>`;
      }
    }
    const rowClass = isCurrent ? ' class="rt-row-current"' : '';
    html += `<tr${rowClass}><th class="rt-rowlabel${absent ? ' rt-absent' : ''}">${row.label}</th>${cells}</tr>`;
  }
  return `<tbody>${html}</tbody>`;
}

// reconstrói a tabela a partir do estado atual (lastRiscoGeo/lastMuniName/currentAD)
function renderRiscoPanel() {
  const hint = document.getElementById('risco-hint');
  const table = document.getElementById('risco-table');
  const geo = lastRiscoGeo;

  if (!geo) {
    hint.textContent = 'Passe o mouse num município no mapa.';
    table.innerHTML = '';
    return;
  }
  if (!RISCO_DATA) {
    hint.textContent = 'Carregando dados de risco…';
    return;
  }
  hint.textContent = lastMuniName || geo;
  table.innerHTML = riscoTableHead() + riscoTableBody(geo, currentAD);
}

function updateRiscoTable(geo, muniName) {
  if (geo === lastRiscoGeo) return; // mesmo município do último render, nada a fazer
  lastRiscoGeo = geo;
  lastMuniName = muniName;
  if (!geo) currentAD = null; // saiu de qualquer município: limpa highlight
  renderRiscoPanel();
}

// chamado quando a leitura assíncrona de solo_ad.tif resolve; só re-renderiza se
// o AD realmente mudou (evita rebuild da tabela a cada pixel do mousemove).
function updateCurrentAD(ad) {
  if (ad === currentAD) return;
  currentAD = ad;
  if (lastRiscoGeo) renderRiscoPanel();
}

// ---- hover: valor do pixel (locationValues) + nome do município ----
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '260px' });
let lookupBusy = false;

// lê o valor do pixel; tolera locationValues querer cog:// ou o path puro
async function readPixel(file, lngLat) {
  const coord = { latitude: lngLat.lat, longitude: lngLat.lng };
  for (const u of [cogUrl(file), absUrl(file)]) {
    try {
      const vals = await MaplibreCOGProtocol.locationValues(u, coord);
      if (vals && vals.length) return vals[0];
    } catch (_) { /* tenta a próxima forma de URL */ }
  }
  return undefined;
}

map.on('mousemove', (e) => {
  // nome do município (barato, sync)
  const feats = map.queryRenderedFeatures(e.point, { layers: ['municipios-fill'] });
  const p = feats[0] && feats[0].properties;
  const munText = p ? `${p.name_muni || '?'} - ${p.abbrev_state || ''}` : '';
  const geo = p ? String(p.code_muni) : null;

  // tabela de risco por decêndio: independe da camada raster ativa
  updateRiscoTable(geo, p && p.name_muni);

  // highlight do AD (solo_ad.tif) na tabela — leitura própria, throttle separado
  // da leitura de pixel da camada ativa (não bloqueiam uma à outra).
  if (geo && SOLO_FILE && !soloLookupBusy) {
    soloLookupBusy = true;
    readPixel(SOLO_FILE, e.lngLat).then((v) => {
      updateCurrentAD(v == null || Number.isNaN(v) ? null : `AD-${Math.round(v)}`);
    }).catch(() => {}).finally(() => { soloLookupBusy = false; });
  }

  // raio minimo do ponto sob o cursor, se a camada estiver ligada
  let raioText = '';
  if (raiosVisivel && RAIOS_META) {
    const ids = camadasRaios().map((c) => lyrRaios(c.source_layer)).filter((id) => map.getLayer(id));
    if (ids.length) {
      const fr = map.queryRenderedFeatures(e.point, { layers: ids });
      if (fr[0]) {
        const v = fr[0].properties[campoRaio()];
        raioText = raiosModo === 'fixo'
          ? `<span class="val">Em ${raiosFixo} km:</span> ${fmt(v)} mil t`
          : `<span class="val">Raio mínimo:</span> ${v} km`;
      }
    }
  }

  // valores das camadas marcadas (throttle: pula se ja ha leitura em voo)
  const sel = selectedDefs();
  raioAtual = raioText;
  if (!sel.length) { paintPopup(e.lngLat, [], null, munText); return; }
  if (lookupBusy) { paintPopup(e.lngLat, sel, null, munText); return; }
  lookupBusy = true;
  Promise.all(sel.map((d) => readPixel(d.file, e.lngLat).catch(() => undefined)))
    .then((vals) => paintPopup(e.lngLat, sel, vals, munText))
    .catch(() => paintPopup(e.lngLat, sel, null, munText))
    .finally(() => { lookupBusy = false; });
});

let raioAtual = '';
function paintPopup(lngLat, defs, vals, munText) {
  const linhas = defs.map((def, i) => {
    const v = vals ? vals[i] : undefined;
    return `<div><span class="val">${def.label}:</span> ${v === undefined ? '…' : formatValue(def, v)}</div>`;
  }).join('');
  if (!linhas && !munText) { popup.remove(); return; }
  popup.setLngLat(lngLat).setHTML(
    `<div class="raster-popup">${linhas}` +
    (raioAtual ? `<div>${raioAtual}</div>` : '') +
    (munText ? `<div class="mun">Municipio: ${munText}</div>` : '') + `</div>`
  ).addTo(map);
}

map.on('mouseout', () => popup.remove());

// ---- resumo por UF (caixa lateral direita) ----
// Os totais NAO sao calculados aqui: seriam 237 milhoes de pixels por camada.
// Vem prontos de DATA/resumo_uf.json, gerado por build_resumo_uf.py sobre a grade
// nativa em EPSG:5880 (a area por pixel em 3857 seria distorcida pelo Mercator).
// Conferido contra o Usinas.Rmd: bate digito a digito.
let RESUMO = null;
let resumoMetrica = 'area';   // 'area' (ha) | 'qtd' (t)

const METRICAS = {
  area: { rotulo: 'Área (ha)', campoTotal: 'area_total_ha', prefixo: 'area_', sufixo: '_ha', casas: 0 },
  qtd: { rotulo: 'Quantidade (t)', campoTotal: 'qtd_total_t', prefixo: 'qtd_', sufixo: '_t', casas: 0 },
};

const fmt = (n, casas = 0) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

// "n30_lag100_abertura_30" -> "Cen. 30"; usado so no cabecalho, que e estreito
const curto = (nome) => {
  const m = nome.match(/^n(\d+)_/);
  return m ? `Cen. ${m[1]}` : nome;
};

function renderResumo() {
  const metEl = document.getElementById('resumo-metrica');
  const totEl = document.getElementById('resumo-total');
  const tabEl = document.getElementById('resumo-tabela');
  const notaEl = document.getElementById('resumo-nota');
  if (!RESUMO) { totEl.innerHTML = '<div class="resumo-total-linha">Carregando…</div>'; return; }

  const M = METRICAS[resumoMetrica];
  const cens = RESUMO.cenarios;

  // seletor da metrica
  metEl.innerHTML = '';
  for (const [chave, def] of Object.entries(METRICAS)) {
    const lab = document.createElement('label');
    lab.className = 'resumo-op' + (chave === resumoMetrica ? ' active' : '');
    lab.innerHTML = `<input type="radio" name="resumo-met" ${chave === resumoMetrica ? 'checked' : ''}><span>${def.rotulo}</span>`;
    lab.querySelector('input').addEventListener('change', () => { resumoMetrica = chave; renderResumo(); });
    metEl.appendChild(lab);
  }

  const campo = (cen) => `${M.prefixo}${cen}${M.sufixo}`;
  const t = RESUMO.totais;
  totEl.innerHTML =
    `<div class="resumo-total-linha"><span>Total (sem cenário)</span><strong>${fmt(t[M.campoTotal], M.casas)}</strong></div>` +
    cens.map((c) =>
      `<div class="resumo-total-linha"><span>${curto(c)}</span><strong>${fmt(t[campo(c)], M.casas)}</strong></div>`
    ).join('');

  tabEl.innerHTML =
    `<thead><tr><th>UF</th><th>Total</th>${cens.map((c) => `<th title="${c}">${curto(c)}</th>`).join('')}</tr></thead>` +
    '<tbody>' +
    RESUMO.ufs.map((r) =>
      `<tr><td>${r.uf}</td><td>${fmt(r[M.campoTotal], M.casas)}</td>` +
      cens.map((c) => `<td>${fmt(r[campo(c)], M.casas)}</td>`).join('') + '</tr>'
    ).join('') +
    '</tbody>';

  notaEl.innerHTML =
    '<strong>Total</strong>: área potencial sem ponderar por cenário ' +
    '(area_potencial × 0,09 ha), zerada dentro de áreas de conservação.<br>' +
    '<strong>Cenários</strong>: mesma conta ponderada pela marcha de plantio ' +
    '(decêndios aptos ÷ 3). Quantidade = área × produtividade média PAM ÷ 1000.';
}

// ---- pontos de raio minimo (grade de 10 km, 3 portes de usina) ----
// Vem de DATA/raio_minimo.pmtiles (gerado por build_raio_minimo.sh +
// build_raio_pmtiles.sh). Cada ponto e o centroide de uma quadra de 10 km; a
// propriedade r_<cenario>_<meta_kt> e o menor raio que alcanca aquela meta.
//
// O PMTiles traz TRES camadas com faixas de zoom diferentes (raleacao por zoom):
// z0-6 mostra 1 ponto a cada 4 (40 km), z6-8 um a cada 2 (20 km), z8+ todos.
// Cada uma vira uma camada de estilo com seu minzoom/maxzoom - o filtro do
// MapLibre nao aceita ['zoom'], entao a separacao tem de ser por camada.
const RAIOS_SRC = 'raios-src';
const RAIO_MAX_ESCALA = 200;
let RAIOS_META = null;
let raiosCenario = null;
let raiosMeta = null;          // porte de usina em kt (120 / 600 / 2000)
let raiosVisivel = false;
let raiosCorte = 200;          // km; mostra so os pontos com raio <= este valor
// Modo 'fixo' (analise inversa): raio fixo -> quantidade captada, q_<cen>_<km>
// em mil t. O slider vira "quantidade minima", em passos de escala/q_passos.
let raiosModo = 'minimo';      // 'minimo' | 'fixo'
let raiosFixo = 100;           // km
let qCortePasso = 0;           // 0..q_passos

const camadasRaios = () => (RAIOS_META ? RAIOS_META.camadas : []);
const lyrRaios = (sl) => `raios-lyr-${sl}`;

const corDoRaio = (t) => String(d3.rgb(d3.interpolateViridis(t)));
const COR_ZERO = '#dcdcdc';

const escalaQ = () => (RAIOS_META.q_escala_kt || {})[String(raiosFixo)] || 1000;
const qCorte = () => (escalaQ() * qCortePasso) / (RAIOS_META.q_passos || 40);

function escalaRaio(campo) {
  const paradas = [];
  if (raiosModo === 'fixo') {
    // mais quantidade = amarelo (ponta "boa" da viridis, como raio curto no outro modo)
    const esc = escalaQ();
    for (let i = 0; i <= 8; i++) paradas.push((i / 8) * esc, corDoRaio(1 - i / 8));
    const q = ['coalesce', ['get', campo], 0];
    // zero = nada captado no raio: ponto continua visivel, em cinza claro
    return ['case', ['<=', q, 0], COR_ZERO, ['interpolate', ['linear'], q, ...paradas]];
  }
  for (let i = 0; i <= 8; i++) paradas.push((i / 8) * RAIO_MAX_ESCALA, corDoRaio(i / 8));
  return ['interpolate', ['linear'], ['coalesce', ['get', campo], RAIO_MAX_ESCALA], ...paradas];
}

function campoRaio() {
  return raiosModo === 'fixo'
    ? `q_${raiosCenario}_${raiosFixo}`
    : `r_${raiosCenario}_${raiosMeta}`;
}

// Esconde o ponto inviavel naquela combinacao (propriedade ausente) e o que passa
// do corte. O coalesce evita comparar null com numero, que a spec nao permite.
function filtroRaios() {
  if (raiosModo === 'fixo') {
    return ['all',
      ['has', campoRaio()],
      ['>=', ['coalesce', ['get', campoRaio()], 0], qCorte()],
    ];
  }
  return ['all',
    ['has', campoRaio()],
    ['<=', ['coalesce', ['get', campoRaio()], 1e9], raiosCorte],
  ];
}

// Conta pelo histograma cumulativo dos metadados: com PMTiles as feicoes chegam
// sob demanda, entao nao da para contar lendo os dados no cliente.
function contaRaios() {
  if (!RAIOS_META) return null;
  if (raiosModo === 'fixo') {
    const h = ((RAIOS_META.hist_q_cumulativo || {})[raiosCenario] || {})[String(raiosFixo)];
    return h ? { vis: h[Math.min(qCortePasso, h.length - 1)], total: h[0] } : null;
  }
  if (!RAIOS_META.hist_cumulativo) return null;
  const h = (RAIOS_META.hist_cumulativo[raiosCenario] || {})[String(raiosMeta)];
  if (!h) return null;
  const i = Math.min(Math.round(raiosCorte / RAIOS_META.hist_passo_km), h.length - 1);
  return { vis: h[i], total: null };
}

// o slider serve aos dois modos: raio maximo (km) ou quantidade minima (mil t)
function syncSlider() {
  const sld = document.getElementById('raios-corte');
  const rot = document.getElementById('raios-corte-rotulo');
  if (raiosModo === 'fixo') {
    sld.min = 0; sld.max = RAIOS_META ? (RAIOS_META.q_passos || 40) : 40; sld.step = 1;
    sld.value = qCortePasso;
    rot.textContent = `Quantidade mínima: ${RAIOS_META ? fmt(qCorte()) : 0} mil t`;
  } else {
    sld.min = 0; sld.max = 200; sld.step = 5;
    sld.value = raiosCorte;
    rot.textContent = `Raio máximo: ${raiosCorte} km`;
  }
}

function syncRaios() {
  if (!RAIOS_META) return;
  for (const c of camadasRaios()) {
    if (map.getLayer(lyrRaios(c.source_layer))) map.removeLayer(lyrRaios(c.source_layer));
  }
  if (!raiosVisivel) return;
  const antes = map.getLayer('base-place-pais') ? 'base-place-pais' : undefined;
  for (const c of camadasRaios()) {
    map.addLayer({
      id: lyrRaios(c.source_layer), source: RAIOS_SRC,
      'source-layer': c.source_layer, type: 'circle',
      minzoom: c.minzoom, maxzoom: c.maxzoom,
      filter: filtroRaios(),
      paint: {
        'circle-color': escalaRaio(campoRaio()),
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.2, 6, 4, 10, 9],
        'circle-stroke-width': 0.4,
        'circle-stroke-color': 'rgba(0,0,0,0.35)',
      },
    }, antes);
  }
}

// troca de porte/cenario/corte: so repinta e refiltra, nao recria as camadas
function atualizaRaios() {
  limpaCirculo();   // o raio depende do porte/cenario; o circulo antigo nao vale mais
  for (const c of camadasRaios()) {
    const id = lyrRaios(c.source_layer);
    if (!map.getLayer(id)) continue;
    map.setFilter(id, filtroRaios());
    map.setPaintProperty(id, 'circle-color', escalaRaio(campoRaio()));
  }
}

function renderRaios() {
  const metaEl = document.getElementById('raios-meta');
  const cenEl = document.getElementById('raios-cenario');
  const legEl = document.getElementById('raios-legenda');
  if (!RAIOS_META) { legEl.innerHTML = '<div class="hint">Carregando…</div>'; return; }

  const modoEl = document.getElementById('raios-modo');
  modoEl.innerHTML = '';
  const modos = [['minimo', 'Raio mínimo']];
  if ((RAIOS_META.raios_fixos_km || []).length) modos.push(['fixo', 'Raio fixo']);
  modos.forEach(([chave, rot]) => {
    const lab = document.createElement('label');
    lab.className = 'resumo-op' + (chave === raiosModo ? ' active' : '');
    lab.innerHTML = `<input type="radio" name="raios-modo" ${chave === raiosModo ? 'checked' : ''}><span>${rot}</span>`;
    lab.querySelector('input').addEventListener('change', () => {
      raiosModo = chave; syncSlider(); atualizaRaios(); renderRaios();
    });
    modoEl.appendChild(lab);
  });

  metaEl.innerHTML = '';
  if (raiosModo === 'fixo') {
    RAIOS_META.raios_fixos_km.forEach((rk) => {
      const lab = document.createElement('label');
      lab.className = 'resumo-op' + (rk === raiosFixo ? ' active' : '');
      lab.innerHTML = `<input type="radio" name="raios-fixo" ${rk === raiosFixo ? 'checked' : ''}><span>Raio de ${rk} km</span>`;
      lab.querySelector('input').addEventListener('change', () => {
        raiosFixo = rk; syncSlider(); atualizaRaios(); renderRaios();
      });
      metaEl.appendChild(lab);
    });
  } else {
    RAIOS_META.metas_kt.forEach((m) => {
      const lab = document.createElement('label');
      lab.className = 'resumo-op' + (m === raiosMeta ? ' active' : '');
      const rot = m >= 1000 ? `${(m / 1000).toLocaleString('pt-BR')} Mt/ano` : `${m} mil t/ano`;
      lab.innerHTML = `<input type="radio" name="raios-meta" ${m === raiosMeta ? 'checked' : ''}><span>${rot}</span>`;
      lab.querySelector('input').addEventListener('change', () => {
        raiosMeta = m; atualizaRaios(); renderRaios();
      });
      metaEl.appendChild(lab);
    });
  }

  cenEl.innerHTML = '';
  RAIOS_META.cenarios.forEach((nome) => {
    const lab = document.createElement('label');
    lab.className = 'resumo-op' + (nome === raiosCenario ? ' active' : '');
    lab.innerHTML = `<input type="radio" name="raios-cen" ${nome === raiosCenario ? 'checked' : ''}><span>${nome}</span>`;
    lab.querySelector('input').addEventListener('change', () => {
      raiosCenario = nome; atualizaRaios(); renderRaios();
    });
    cenEl.appendChild(lab);
  });

  const fixo = raiosModo === 'fixo';
  const paradas = [];
  for (let i = 0; i <= 10; i++) paradas.push(`${corDoRaio(fixo ? 1 - i / 10 : i / 10)} ${i * 10}%`);
  const resumoCen = RAIOS_META.resumo[raiosCenario] || {};
  const r = resumoCen[fixo ? `raio_${raiosFixo}` : String(raiosMeta)] || {};
  const conta = contaRaios();
  const total = fixo ? (conta && conta.total) || 0 : r.viaveis || 0;
  const n = (v) => v.toLocaleString('pt-BR');
  legEl.innerHTML =
    `<div class="legend-bar" style="background:linear-gradient(to right, ${paradas.join(',')})"></div>` +
    (fixo
      ? `<div class="legend-scale"><span>0</span><span>≥ ${fmt(escalaQ())} mil t</span></div>` +
        `<div class="legend-cat"><span class="legend-swatch" style="background:${COR_ZERO}"></span>Zero no raio</div>`
      : `<div class="legend-scale"><span>0 km</span><span>${RAIO_MAX_ESCALA} km</span></div>`) +
    `<div class="legend-unit">` +
    (conta === null ? `${n(total)} pontos` : `${n(conta.vis)} de ${n(total)} pontos`) +
    (fixo ? ` · mediana ${r.mediana_kt != null ? fmt(r.mediana_kt) : '—'} mil t em ${raiosFixo} km`
      : ` · mediana ${r.raio_km_mediana ?? '—'} km`) + `</div>`;
}

// ---- circulo de captacao (clique num ponto) ----
// O raio foi calculado em EPSG:5880 (distancia plana). O circulo aqui e geodesico
// sobre a esfera; para 200 km a diferenca entre os dois fica na casa de centenas
// de metros - invisivel no mapa, mas nao e o mesmo objeto matematico.
const CIRC_SRC = 'raio-circulo-src';
const CIRC_FILL = 'raio-circulo-fill';
const CIRC_HALO = 'raio-circulo-halo';
const CIRC_LINE = 'raio-circulo-line';
const VAZIO = { type: 'FeatureCollection', features: [] };

function circuloGeodesico(lon, lat, raioKm, n = 180) {
  const R = 6371.0088;                 // raio medio da Terra, km
  const d = raioKm / R;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const anel = [];
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * 2 * Math.PI;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) +
                          Math.cos(la1) * Math.sin(d) * Math.cos(b));
    const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1),
                                 Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    anel.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [anel] } };
}

function limpaCirculo() {
  const src = map.getSource(CIRC_SRC);
  if (src) src.setData(VAZIO);
  const el = document.getElementById('raios-clique');
  if (el) el.textContent = '';
}

function mostraCirculo(lngLat, props) {
  const valor = props[campoRaio()];
  if (valor == null) return;
  const raio = raiosModo === 'fixo' ? raiosFixo : valor;
  const src = map.getSource(CIRC_SRC);
  if (!src) return;
  src.setData({ type: 'FeatureCollection',
                features: [circuloGeodesico(lngLat.lng, lngLat.lat, raio)] });
  // moveLayer sem beforeId manda para o topo: garante que o circulo fique acima
  // dos pontos mesmo depois de syncRaios ter recriado as camadas deles.
  for (const id of [CIRC_FILL, CIRC_HALO, CIRC_LINE]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
  const el = document.getElementById('raios-clique');
  if (el) {
    const area = Math.PI * raio * raio;
    const cab = raiosModo === 'fixo'
      ? `<strong>${fmt(valor)} mil t</strong> em ${raio} km`
      : `<strong>${raio} km</strong>`;
    el.innerHTML = `${cab} · ${props.uf || '?'} · ` +
      `área do círculo ${area.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} km²`;
  }
}

function initRaios() {
  document.getElementById('raios-toggle').addEventListener('change', (ev) => {
    raiosVisivel = ev.target.checked;
    if (!raiosVisivel) limpaCirculo();
    syncRaios();
  });
  const sld = document.getElementById('raios-corte');
  const rot = document.getElementById('raios-corte-rotulo');
  sld.addEventListener('input', () => {
    if (raiosModo === 'fixo') qCortePasso = Number(sld.value);
    else raiosCorte = Number(sld.value);
    syncSlider();
    atualizaRaios();
    renderRaios();
  });

  fetch('./DATA/raio_minimo_meta.json').then((r) => r.json()).then((meta) => {
    RAIOS_META = meta;
    raiosCenario = meta.cenarios[0];
    raiosMeta = meta.metas_kt.includes(600) ? 600 : meta.metas_kt[0];
    map.addSource(RAIOS_SRC, {
      type: 'vector', url: 'pmtiles://./DATA/raio_minimo.pmtiles',
    });

    // Circulo NO TOPO de tudo: sem beforeId. Abaixo dos pontos ele sumia, porque
    // na densidade de 10 km as bolinhas se encostam e tapam o contorno.
    map.addSource(CIRC_SRC, { type: 'geojson', data: VAZIO });
    map.addLayer({
      id: CIRC_FILL, source: CIRC_SRC, type: 'fill',
      paint: { 'fill-color': '#2f6fed', 'fill-opacity': 0.10 },
    });
    // Casing: branco largo embaixo, azul fino em cima. O contorno cruza fundos
    // claros e fundos azuis (agua do basemap, rasters, os proprios pontos), entao
    // uma cor so sempre some em algum trecho; com as duas, uma sempre aparece.
    map.addLayer({
      id: CIRC_HALO, source: CIRC_SRC, type: 'line',
      paint: { 'line-color': '#ffffff', 'line-width': 4.5, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: CIRC_LINE, source: CIRC_SRC, type: 'line',
      paint: { 'line-color': '#1a3ea8', 'line-width': 1.8, 'line-opacity': 1 },
    });

    map.on('click', (ev) => {
      if (!raiosVisivel) return;
      const ids = camadasRaios().map((c) => lyrRaios(c.source_layer)).filter((id) => map.getLayer(id));
      if (!ids.length) return;
      const fr = map.queryRenderedFeatures(ev.point, { layers: ids });
      if (fr[0]) mostraCirculo(ev.lngLat, fr[0].properties);
      else limpaCirculo();          // clique fora de um ponto apaga o circulo
    });
    // cursor de mao sobre os pontos
    map.on('mousemove', (ev) => {
      if (!raiosVisivel) { map.getCanvas().style.cursor = ''; return; }
      const ids = camadasRaios().map((c) => lyrRaios(c.source_layer)).filter((id) => map.getLayer(id));
      map.getCanvas().style.cursor =
        ids.length && map.queryRenderedFeatures(ev.point, { layers: ids }).length ? 'pointer' : '';
    });
    renderRaios();
    syncRaios();
  }).catch(() => {
    document.getElementById('raios-legenda').innerHTML =
      '<div class="hint">raio_minimo.pmtiles ausente — rode build_raio_minimo.sh e build_raio_pmtiles.sh</div>';
  });
}

// ---- boot ----
renderRiscoLegend(); // estática, não depende de rede/mapa
renderResumo();   // mostra 'carregando' até o JSON chegar

// layers.local.json é opcional (gitignored, só existe em ambiente de dev local
// com os COGs pesados em COG_local/); ausente no GitHub Pages, ignorado em silêncio.
map.on('load', async () => {
  const deployLayers = await fetch('./layers.json').then((r) => r.json());
  const localLayers = await fetch('./layers.local.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  LAYERS = [...deployLayers, ...localLayers];
  renderList();
  if (LAYERS.length) toggleLayer(LAYERS[0], true);

  const soloDef = LAYERS.find((l) => l.id === 'solo');
  SOLO_FILE = soloDef ? soloDef.file : null;

  fetch('./DATA/risco_decendio.json').then((r) => r.json()).then((d) => { RISCO_DATA = d; }).catch(() => {});
  initRaios();
  fetch('./DATA/resumo_uf.json').then((r) => r.json())
    .then((d) => { RESUMO = d; renderResumo(); }).catch(() => {});
});
