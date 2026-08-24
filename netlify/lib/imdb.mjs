/**
 * imdb.mjs — coleta de dados EXCLUSIVAMENTE do IMDb.
 *
 * Estratégia: baixamos o HTML da própria página da lista no imdb.com e
 * extraímos o JSON que o próprio IMDb embute no documento (o mesmo JSON que
 * o site usa para desenhar a página). Nenhuma API, banco ou serviço externo.
 *
 * Como o HTML do IMDb muda de tempos em tempos, a extração é feita em
 * "escada": tentamos 5 estratégias, da mais estruturada para a mais bruta.
 * Se uma quebrar, a próxima assume — sem trocar a fonte.
 */

/** Definição das 4 listas pedidas. `urls` são fallbacks da MESMA fonte (IMDb). */
export const CHART_SOURCES = {
  imdb_pop_series: {
    stremioType: 'series',
    name: 'IMDb Séries Populares',
    limit: 100,
    urls: [
      'https://www.imdb.com/pt/chart/tvmeter/?ref_=hm_nv_menu',
      'https://www.imdb.com/chart/tvmeter/',
    ],
  },
  imdb_pop_movies: {
    stremioType: 'movie',
    name: 'IMDb Filmes Populares',
    limit: 100,
    urls: [
      'https://www.imdb.com/pt/chart/moviemeter/?ref_=hm_nv_menu',
      'https://www.imdb.com/chart/moviemeter/',
    ],
  },
  imdb_top_series: {
    stremioType: 'series',
    name: 'IMDb Top 250 Séries',
    limit: 250,
    urls: [
      'https://www.imdb.com/pt/chart/toptv/?ref_=hm_nv_menu',
      'https://www.imdb.com/chart/toptv/',
    ],
  },
  imdb_top_movies: {
    stremioType: 'movie',
    name: 'IMDb Top 250 Filmes',
    limit: 250,
    urls: [
      'https://www.imdb.com/pt/chart/top/?ref_=hm_nv_menu',
      'https://www.imdb.com/chart/top/',
    ],
  },
};

export const CHART_IDS = Object.keys(CHART_SOURCES);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function browserHeaders(attempt = 0) {
  return {
    'User-Agent': USER_AGENTS[attempt % USER_AGENTS.length],
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, { timeoutMs = 12000, attempt = 0 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: browserHeaders(attempt),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    const html = await res.text();
    if (!html || html.length < 5000) throw new Error(`resposta curta demais (${html?.length || 0} bytes)`);
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Extração                                                            */
/* ------------------------------------------------------------------ */

/** Pega o conteúdo de <script ... id="__NEXT_DATA__" ...>{...}</script>. */
function extractNextData(html) {
  const marker = html.indexOf('__NEXT_DATA__');
  if (marker === -1) return null;
  const open = html.indexOf('>', marker);
  const close = html.indexOf('</script>', open);
  if (open === -1 || close === -1) return null;
  const raw = html.slice(open + 1, close).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Pega todos os <script type="application/json"> e <script type="application/ld+json">. */
function extractJsonScripts(html, mime) {
  const out = [];
  const re = new RegExp(`<script[^>]*type=["']${mime}["'][^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    if (end === -1) continue;
    try {
      out.push(JSON.parse(html.slice(start, end).trim()));
    } catch {
      /* ignora blocos que não são JSON válido */
    }
  }
  return out;
}

const isTitleId = (v) => typeof v === 'string' && /^tt\d{6,10}$/.test(v);

/** Um "nó de título" do IMDb tem id ttXXXXXXX e algum campo de nome. */
function looksLikeTitleNode(v) {
  return (
    v &&
    typeof v === 'object' &&
    isTitleId(v.id) &&
    (v.titleText || v.originalTitleText || v.titleType || v.primaryImage || v.releaseYear)
  );
}

/**
 * Percorre o JSON procurando o MAIOR array cujos elementos sejam títulos
 * (direto ou dentro de `.node`). A ordem do array é a ordem do ranking.
 */
function findTitleArray(root) {
  let best = null;
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) {
      const mapped = node
        .map((el) => (looksLikeTitleNode(el?.node) ? el.node : looksLikeTitleNode(el) ? el : null))
        .filter(Boolean);
      if (mapped.length >= 3 && (!best || mapped.length > best.length)) best = mapped;
      for (const el of node) visit(el, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(root, 0);
  return best;
}

/** Fallback: JSON-LD com ItemList (usado nas páginas Top 250). */
function fromJsonLd(html) {
  for (const doc of extractJsonScripts(html, 'application/ld\\+json')) {
    const list = doc?.itemListElement;
    if (!Array.isArray(list) || list.length < 3) continue;
    const items = [];
    for (const entry of list) {
      const item = entry?.item || entry;
      const url = item?.url || '';
      const id = (url.match(/\/title\/(tt\d{6,10})/) || [])[1];
      if (!id) continue;
      items.push({
        id,
        titleText: { text: item.name || item.alternateName },
        primaryImage: item.image ? { url: item.image } : undefined,
        ratingsSummary: item.aggregateRating?.ratingValue
          ? { aggregateRating: Number(item.aggregateRating.ratingValue) }
          : undefined,
      });
    }
    if (items.length >= 3) return items;
  }
  return null;
}

/**
 * Fallback bruto: varre o HTML atrás de objetos JSON com "titleText",
 * inclusive quando vêm escapados dentro de strings JS (payload RSC).
 */
function fromRawScan(html) {
  const attempts = [html];
  if (html.includes('\\"titleText\\"')) attempts.push(html.replace(/\\"/g, '"'));

  for (const source of attempts) {
    const items = [];
    const seen = new Set();
    const re = /"titleText"/g;
    let m;
    while ((m = re.exec(source)) !== null && items.length < 400) {
      const obj = extractEnclosingObject(source, m.index);
      if (!obj || !isTitleId(obj.id) || seen.has(obj.id)) continue;
      seen.add(obj.id);
      items.push(obj);
    }
    if (items.length >= 3) return items;
  }
  return null;
}

function extractEnclosingObject(text, position, maxSpan = 20000) {
  // volta até a abertura `{` do objeto que contém a posição
  let depth = 0;
  let start = -1;
  for (let i = position; i >= Math.max(0, position - maxSpan); i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  // avança fechando as chaves
  depth = 0;
  for (let i = start; i < Math.min(text.length, start + maxSpan); i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Último recurso: só HTML, casando o ranking com o nome exibido. */
function fromHtmlRegex(html) {
  const ids = [];
  const seen = new Set();
  const idRe = /\/title\/(tt\d{6,10})\//g;
  let m;
  while ((m = idRe.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  const names = [];
  const nameRe = /ipc-title__text[^>]*>\s*(\d+)\.\s*([^<]+)</g;
  while ((m = nameRe.exec(html)) !== null) names[Number(m[1]) - 1] = decodeEntities(m[2].trim());

  if (ids.length < 10) return null;
  return ids.slice(0, Math.max(names.length, ids.length)).map((id, i) => ({
    id,
    titleText: { text: names[i] || null },
  }));
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Executa a escada de parsers e devolve os nós crus do IMDb, em ordem. */
export function parseChartHtml(html) {
  const strategies = [
    () => {
      const next = extractNextData(html);
      return next ? findTitleArray(next) : null;
    },
    () => {
      for (const doc of extractJsonScripts(html, 'application/json')) {
        const found = findTitleArray(doc);
        if (found) return found;
      }
      return null;
    },
    () => fromJsonLd(html),
    () => fromRawScan(html),
    () => fromHtmlRegex(html),
  ];

  for (const [index, strategy] of strategies.entries()) {
    try {
      const nodes = strategy();
      if (nodes && nodes.length >= 3) return { nodes, strategy: index + 1 };
    } catch {
      /* tenta a próxima */
    }
  }
  return { nodes: [], strategy: 0 };
}

/* ------------------------------------------------------------------ */
/* Normalização para o formato do addon (Stremio/Nuvio)                */
/* ------------------------------------------------------------------ */

/** Redimensiona o pôster no próprio CDN de imagens do IMDb. */
function posterUrl(url, width = 380) {
  if (typeof url !== 'string' || !url) return undefined;
  const height = Math.round(width * 1.48);
  return url.replace(/\._V1_.*?(\.\w+)$/i, `._V1_QL75_UX${width}_CR0,0,${width},${height}_$1`);
}

function toMetaPreview(node, stremioType, rank) {
  const name =
    node?.titleText?.text ||
    node?.originalTitleText?.text ||
    (typeof node?.titleText === 'string' ? node.titleText : null);
  if (!isTitleId(node?.id) || !name) return null;

  const year = node?.releaseYear?.year ?? node?.releaseYear?.endYear ?? null;
  const endYear = node?.releaseYear?.endYear ?? null;
  const rating = node?.ratingsSummary?.aggregateRating ?? null;
  const genres = (node?.titleGenres?.genres || [])
    .map((g) => g?.genre?.text || g?.text)
    .filter(Boolean);
  const description = node?.plot?.plotText?.plainText || undefined;
  const runtimeSeconds = node?.runtime?.seconds;
  const poster = posterUrl(node?.primaryImage?.url);

  const meta = {
    id: node.id,
    type: stremioType,
    name,
    rank,
  };
  if (poster) {
    meta.poster = poster;
    meta.posterShape = 'poster';
  }
  if (year) {
    meta.releaseInfo = stremioType === 'series' && endYear ? `${year}-${endYear}` : String(year);
    meta.year = String(year);
  }
  if (rating) meta.imdbRating = String(rating);
  if (genres.length) meta.genres = genres;
  if (description) meta.description = description;
  if (runtimeSeconds) meta.runtime = `${Math.round(runtimeSeconds / 60)} min`;
  return meta;
}

/**
 * Baixa e normaliza UMA lista do IMDb.
 * @returns {Promise<{id:string,type:string,name:string,items:Array,updatedAt:string,source:string,strategy:number}>}
 */
export async function scrapeChart(chartId, { timeoutMs = 12000 } = {}) {
  const chart = CHART_SOURCES[chartId];
  if (!chart) throw new Error(`Lista desconhecida: ${chartId}`);

  const errors = [];
  for (const [index, url] of chart.urls.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const html = await fetchHtml(url, { timeoutMs, attempt: index + attempt });
        const { nodes, strategy } = parseChartHtml(html);
        const items = [];
        const seen = new Set();
        for (const node of nodes) {
          const meta = toMetaPreview(node, chart.stremioType, items.length + 1);
          if (!meta || seen.has(meta.id)) continue;
          seen.add(meta.id);
          items.push(meta);
          if (items.length >= chart.limit) break;
        }
        if (items.length < 10) throw new Error(`extração devolveu apenas ${items.length} itens`);
        return {
          id: chartId,
          type: chart.stremioType,
          name: chart.name,
          items,
          updatedAt: new Date().toISOString(),
          source: url,
          strategy,
        };
      } catch (err) {
        errors.push(`${url} (tentativa ${attempt + 1}): ${err.message}`);
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw new Error(`Falha ao ler ${chartId} no IMDb -> ${errors.join(' | ')}`);
}

/** Baixa as 4 listas em paralelo. Falhas individuais não derrubam as demais. */
export async function scrapeAllCharts(options = {}) {
  const results = await Promise.allSettled(CHART_IDS.map((id) => scrapeChart(id, options)));
  const ok = [];
  const failed = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') ok.push(result.value);
    else failed.push({ id: CHART_IDS[i], error: result.reason?.message || String(result.reason) });
  });
  return { ok, failed };
}
