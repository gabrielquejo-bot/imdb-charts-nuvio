/**
 * charts.mjs — regra de atualização das listas.
 *
 * Três camadas garantem que os dados nunca passem de 24h sem toque manual:
 *   1. Função agendada (cron diário) atualiza as 4 listas de forma proativa.
 *   2. Se um catálogo é pedido e o dado está vencido, ele é revalidado.
 *   3. Se não há dado nenhum, coleta na hora (bloqueando) antes de responder.
 */

import { CHART_IDS, CHART_SOURCES, scrapeChart } from './imdb.mjs';
import { readChart, writeChart, dropMemory } from './store.mjs';

/** Idade máxima aceitável: 24 horas. */
export const MAX_AGE_MS = Number(process.env.REFRESH_INTERVAL_HOURS || 24) * 60 * 60 * 1000;

const inFlight = new Map();

export function ageOf(payload) {
  if (!payload?.updatedAt) return Infinity;
  return Date.now() - new Date(payload.updatedAt).getTime();
}

export const isStale = (payload) => ageOf(payload) > MAX_AGE_MS;

/** Coleta uma lista no IMDb e persiste. Evita coletas duplicadas simultâneas. */
export async function refreshChart(chartId, { timeoutMs } = {}) {
  if (inFlight.has(chartId)) return inFlight.get(chartId);

  const task = (async () => {
    const fresh = await scrapeChart(chartId, { timeoutMs });
    await writeChart(chartId, fresh);
    console.log(
      `[charts] ${chartId}: ${fresh.items.length} itens (estratégia ${fresh.strategy}, ${fresh.source})`,
    );
    return fresh;
  })().finally(() => inFlight.delete(chartId));

  inFlight.set(chartId, task);
  return task;
}

/** Atualiza as 4 listas. Usado pela função agendada e pelo /refresh manual. */
export async function refreshAll({ timeoutMs } = {}) {
  const started = Date.now();
  const results = await Promise.allSettled(CHART_IDS.map((id) => refreshChart(id, { timeoutMs })));
  const report = { updated: [], failed: [], durationMs: 0 };
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      report.updated.push({ id: CHART_IDS[i], items: result.value.items.length });
    } else {
      report.failed.push({
        id: CHART_IDS[i],
        error: result.reason?.message || String(result.reason),
      });
    }
  });
  report.durationMs = Date.now() - started;
  return report;
}

/**
 * Devolve a lista pronta para servir.
 * @param {string} chartId
 * @param {{waitUntil?: Function}} ctx  contexto da função (para revalidar em 2º plano)
 */
export async function getChart(chartId, ctx = {}) {
  if (!CHART_SOURCES[chartId]) return null;

  const stored = await readChart(chartId);

  // Nada salvo ainda (primeiro acesso / deploy novo): coleta agora.
  if (!stored?.items?.length) {
    try {
      return await refreshChart(chartId, { timeoutMs: 9000 });
    } catch (err) {
      console.error(`[charts] coleta inicial de ${chartId} falhou:`, err.message);
      return null;
    }
  }

  // Passou de 24h: entrega o que temos e revalida em segundo plano.
  if (isStale(stored)) {
    const task = refreshChart(chartId).catch((err) =>
      console.error(`[charts] revalidação de ${chartId} falhou:`, err.message),
    );
    if (typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  }

  return stored;
}

/** Recebe listas já coletadas por fora (plano B do GitHub Actions). */
export async function ingestCharts(charts) {
  const accepted = [];
  for (const chart of charts || []) {
    if (!CHART_SOURCES[chart?.id] || !Array.isArray(chart.items) || chart.items.length < 10) continue;
    const payload = {
      id: chart.id,
      type: CHART_SOURCES[chart.id].stremioType,
      name: CHART_SOURCES[chart.id].name,
      items: chart.items.slice(0, CHART_SOURCES[chart.id].limit),
      updatedAt: chart.updatedAt || new Date().toISOString(),
      source: chart.source || 'imdb.com (via GitHub Actions)',
      strategy: chart.strategy ?? null,
    };
    dropMemory(chart.id);
    await writeChart(chart.id, payload);
    accepted.push({ id: chart.id, items: payload.items.length });
  }
  return accepted;
}

/** Situação de cada lista, para a página de status. */
export async function statusReport() {
  const charts = [];
  for (const id of CHART_IDS) {
    const stored = await readChart(id);
    charts.push({
      id,
      name: CHART_SOURCES[id].name,
      type: CHART_SOURCES[id].stremioType,
      items: stored?.items?.length || 0,
      updatedAt: stored?.updatedAt || null,
      ageHours: stored ? Math.round((ageOf(stored) / 3600000) * 10) / 10 : null,
      stale: stored ? isStale(stored) : true,
      source: stored?.source || CHART_SOURCES[id].urls[0],
    });
  }
  return {
    refreshIntervalHours: MAX_AGE_MS / 3600000,
    checkedAt: new Date().toISOString(),
    charts,
  };
}
