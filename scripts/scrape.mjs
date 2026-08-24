#!/usr/bin/env node
/**
 * scrape.mjs — roda a coleta do IMDb fora da Netlify.
 *
 * Dois usos:
 *   node scripts/scrape.mjs           testa a extração e salva data/charts.json
 *   node scripts/scrape.mjs --push    coleta e envia para o addon (/ingest)
 *
 * O modo --push é o plano B: se algum dia o IMDb bloquear os IPs da Netlify,
 * o GitHub Actions faz a coleta e empurra o resultado para o site. A fonte
 * continua sendo exclusivamente o imdb.com.
 *
 * Variáveis usadas no modo --push:
 *   ADDON_URL      ex.: https://seu-site.netlify.app
 *   REFRESH_TOKEN  o mesmo token configurado no painel da Netlify
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeAllCharts } from '../netlify/lib/imdb.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const push = process.argv.includes('--push');

const { ok, failed } = await scrapeAllCharts({ timeoutMs: 20000 });

for (const chart of ok) {
  console.log(
    `✓ ${chart.id.padEnd(18)} ${String(chart.items.length).padStart(3)} itens  ` +
      `estratégia ${chart.strategy}  ex.: ${chart.items[0].name} (${chart.items[0].id})`,
  );
}
for (const fail of failed) console.error(`✗ ${fail.id}: ${fail.error}`);

if (!ok.length) {
  console.error('Nenhuma lista foi coletada. Abortando.');
  process.exit(1);
}

if (!push) {
  const out = resolve(root, 'data/charts.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ charts: ok }, null, 2), 'utf8');
  console.log(`\nSalvo em ${out}`);
  process.exit(failed.length ? 1 : 0);
}

const addonUrl = (process.env.ADDON_URL || '').replace(/\/$/, '');
const token = process.env.REFRESH_TOKEN;
if (!addonUrl || !token) {
  console.error('Defina ADDON_URL e REFRESH_TOKEN para usar --push.');
  process.exit(1);
}

const res = await fetch(`${addonUrl}/ingest`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ charts: ok }),
});

const body = await res.text();
console.log(`\n/ingest -> HTTP ${res.status} ${body}`);
process.exit(res.ok && failed.length === 0 ? 0 : 1);
