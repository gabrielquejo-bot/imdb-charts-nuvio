#!/usr/bin/env node
/**
 * scrape-browser.mjs — lê as listas do IMDb com um navegador de verdade.
 *
 * Por que um navegador: o IMDb protege /chart/ com AWS WAF em modo "challenge".
 * A primeira resposta é 202 com ~2 KB de JavaScript; esse script roda, grava um
 * cookie e recarrega a página. Cliente HTTP nenhum passa por isso — nem curl,
 * nem fetch. Chromium passa, porque é exatamente o que o desafio espera.
 *
 * Uso:
 *   node scripts/scrape-browser.mjs            salva em data/charts.json
 *   node scripts/scrape-browser.mjs --push     envia para o addon (/ingest)
 *
 * No GitHub Actions roda sob xvfb, em modo visível: navegador headless é a
 * primeira coisa que detector de bot procura.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CHART_SOURCES, CHART_IDS, buildItemsFromHtml } from '../netlify/lib/imdb.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const push = process.argv.includes('--push');
const headless = process.argv.includes('--headless');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A página está pronta quando há dezenas de links de título no documento. */
const READY = () => document.querySelectorAll('a[href*="/title/tt"]').length > 20;

async function dismissConsent(page) {
  const labels = ['Aceitar', 'Accept', 'Concordo', 'I Agree', 'Aceitar tudo', 'Accept All'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: false });
    if (await button.count().catch(() => 0)) {
      await button.first().click({ timeout: 3000 }).catch(() => {});
      await sleep(500);
      return;
    }
  }
}

async function readChart(context, chartId) {
  const chart = CHART_SOURCES[chartId];
  const page = await context.newPage();
  const errors = [];

  try {
    for (const url of chart.urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          const status = response?.status();

          // 202 + página curta = desafio do WAF em andamento. Ele se resolve
          // sozinho e recarrega; só precisamos esperar o conteúdo aparecer.
          await page.waitForFunction(READY, null, { timeout: 45000 });
          await dismissConsent(page);
          await page.waitForFunction(READY, null, { timeout: 15000 }).catch(() => {});

          // A lista do Top 250 carrega em blocos conforme a rolagem.
          if (chart.limit > 100) {
            for (let i = 0; i < 12; i++) {
              await page.mouse.wheel(0, 20000);
              await sleep(400);
              const count = await page.evaluate(
                () => document.querySelectorAll('a[href*="/title/tt"]').length,
              );
              if (count >= chart.limit + 20) break;
            }
            // botão "50 mais" das listas paginadas, quando existir
            for (let i = 0; i < 5; i++) {
              const more = page.getByRole('button', { name: /mais|more/i });
              if (!(await more.count().catch(() => 0))) break;
              await more.first().click({ timeout: 3000 }).catch(() => {});
              await sleep(1200);
            }
          }

          const html = await page.content();
          const { items, strategy } = buildItemsFromHtml(html, chartId);
          if (items.length < 10) {
            throw new Error(
              `HTTP ${status}, ${html.length} bytes, mas a extração achou ${items.length} títulos`,
            );
          }

          await page.close();
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
          errors.push(`${url} (tentativa ${attempt}): ${err.message.split('\n')[0]}`);
          await sleep(2000 * attempt);
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  throw new Error(`Falha ao ler ${chartId} -> ${errors.join(' | ')}`);
}

/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  headless,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});

const context = await browser.newContext({
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
});

// remove o sinal mais óbvio de automação
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const ok = [];
const failed = [];

for (const chartId of CHART_IDS) {
  try {
    const chart = await readChart(context, chartId);
    ok.push(chart);
    console.log(
      `✓ ${chartId.padEnd(18)} ${String(chart.items.length).padStart(3)} títulos  ` +
        `estratégia ${chart.strategy}  ex.: ${chart.items[0].name} (${chart.items[0].id})`,
    );
  } catch (err) {
    failed.push({ id: chartId, error: err.message });
    console.error(`✗ ${chartId}: ${err.message}`);
  }
  await sleep(1500); // não martelar o IMDb
}

await browser.close();

if (!ok.length) {
  console.error('\nNenhuma lista foi lida. Abortando.');
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
  console.error('\nDefina ADDON_URL e REFRESH_TOKEN para usar --push.');
  process.exit(1);
}

const res = await fetch(`${addonUrl}/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ charts: ok }),
});
const body = await res.text();
console.log(`\n/ingest -> HTTP ${res.status} ${body}`);

if (!res.ok) {
  console.error(
    'O addon recusou o envio. Confira se a variável REFRESH_TOKEN existe na Netlify ' +
      'e se você refez o deploy depois de criá-la.',
  );
}
process.exit(res.ok && failed.length === 0 ? 0 : 1);
