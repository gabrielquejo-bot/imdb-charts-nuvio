/**
 * addon.mjs — endpoints do addon (protocolo Stremio, usado pelo Nuvio).
 *
 *   GET /manifest.json
 *   GET /catalog/:type/:id.json
 *   GET /catalog/:type/:id/:extra.json      (skip=..., genre=...)
 *   GET /status.json                        diagnóstico das 4 listas
 *   GET|POST /refresh                       atualização manual (opcional)
 *   POST /ingest                            recebe listas coletadas por fora
 */

import { CHART_SOURCES } from '../lib/imdb.mjs';
import { getChart, refreshAll, statusReport, ingestCharts } from '../lib/charts.mjs';

export const config = {
  path: [
    '/manifest.json',
    '/catalog/:type/:id',
    '/catalog/:type/:id/:extra',
    '/status.json',
    '/refresh',
    '/ingest',
  ],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body, { status = 200, cache = 'no-store' } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      ...CORS,
    },
  });

const ADDON_VERSION = '4.0.0';

function buildManifest() {
  const catalogOrder = ['imdb_pop_series', 'imdb_pop_movies', 'imdb_top_series', 'imdb_top_movies'];
  return {
    id: 'community.imdb.charts.ptbr',
    version: ADDON_VERSION,
    name: 'IMDb Charts',
    description:
      'Listas oficiais do IMDb: Séries Populares, Filmes Populares, Top 250 Séries e Top 250 Filmes. ' +
      'Os dados vêm exclusivamente do imdb.com e são atualizados automaticamente a cada 24 horas.',
    logo: 'https://m.media-amazon.com/images/G/01/IMDb/BG_rectangle._CB1509060989_SY230_SX307_AL_.png',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: catalogOrder.map((id) => ({
      type: CHART_SOURCES[id].stremioType,
      id,
      name: CHART_SOURCES[id].name,
      extra: [{ name: 'skip', isRequired: false }],
      extraSupported: ['skip'],
    })),
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

/** "skip=100&genre=Drama" -> { skip: '100', genre: 'Drama' } */
function parseExtra(segment, searchParams) {
  const extra = {};
  if (segment) {
    for (const pair of decodeURIComponent(segment).split('&')) {
      const idx = pair.indexOf('=');
      if (idx > 0) extra[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
    }
  }
  for (const [key, value] of searchParams.entries()) extra[key] = value;
  return extra;
}

const stripJson = (value = '') => value.replace(/\.json$/i, '');

export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname;

  /* ---------------- manifest ---------------- */
  if (path === '/manifest.json') {
    return json(buildManifest(), { cache: 'public, max-age=600' });
  }

  /* ---------------- status ------------------ */
  if (path === '/status.json') {
    return json(await statusReport());
  }

  /* ---------------- refresh manual ---------- */
  if (path === '/refresh') {
    const token = process.env.REFRESH_TOKEN;
    const given = url.searchParams.get('token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (token && given !== token) return json({ error: 'token inválido' }, { status: 401 });
    const report = await refreshAll({ timeoutMs: 12000 });
    return json({ ok: report.failed.length === 0, ...report });
  }

  /* ---------------- ingest (plano B) -------- */
  if (path === '/ingest') {
    const token = process.env.REFRESH_TOKEN;
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
    if (!token) return json({ error: 'REFRESH_TOKEN não configurado no site' }, { status: 403 });
    if (given !== token) return json({ error: 'token inválido' }, { status: 401 });
    if (req.method !== 'POST') return json({ error: 'use POST' }, { status: 405 });
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'corpo JSON inválido' }, { status: 400 });
    }
    const accepted = await ingestCharts(body?.charts);
    return json({ ok: accepted.length > 0, accepted });
  }

  /* ---------------- catálogo ---------------- */
  if (path.startsWith('/catalog/')) {
    const { type, id, extra } = context.params || {};
    const catalogId = stripJson(id || '');
    const chart = CHART_SOURCES[catalogId];

    if (!chart || chart.stremioType !== type) {
      return json({ metas: [], err: 'catálogo não encontrado' }, { status: 404 });
    }

    const data = await getChart(catalogId, context);
    if (!data?.items?.length) {
      // Sem dados e a coleta falhou: devolve vazio sem cache para o cliente tentar de novo.
      return json({ metas: [] }, { status: 200 });
    }

    const params = parseExtra(stripJson(extra || ''), url.searchParams);
    const skip = Math.max(0, Number.parseInt(params.skip, 10) || 0);
    const genre = params.genre;

    let items = data.items;
    if (genre) items = items.filter((m) => (m.genres || []).includes(genre));

    const metas = items.slice(skip, skip + 100).map(({ rank, year, ...meta }) => meta);

    return json(
      { metas },
      {
        cache: 'public, max-age=1800, stale-while-revalidate=86400',
      },
    );
  }

  return json({ error: 'rota desconhecida' }, { status: 404 });
};
