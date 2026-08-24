/**
 * refresh-charts.mjs — cron da Netlify.
 *
 * Roda sozinha todo dia às 05:10 UTC (02:10 em Brasília), relê as 4 listas
 * no IMDb e grava o resultado. Nenhuma ação manual é necessária.
 *
 * Observação da Netlify: funções agendadas só rodam em deploys publicados e
 * não podem ser chamadas por URL. Para disparar na mão, use /refresh ou o
 * botão "Run now" no painel (Site > Functions > refresh-charts).
 */

import { refreshAll } from '../lib/charts.mjs';

export const config = {
  schedule: '10 5 * * *',
};

export default async () => {
  const report = await refreshAll({ timeoutMs: 15000 });

  console.log(
    `[cron] atualizadas ${report.updated.length}/4 listas em ${report.durationMs}ms`,
    JSON.stringify(report),
  );

  if (report.failed.length) {
    // Log de erro deixa a falha visível no painel de funções da Netlify.
    console.error('[cron] listas que falharam:', JSON.stringify(report.failed));
  }

  return new Response(JSON.stringify(report), {
    headers: { 'Content-Type': 'application/json' },
  });
};
