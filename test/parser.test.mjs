import assert from 'node:assert';
import { parseChartHtml } from '../netlify/lib/imdb.mjs';

const node = (n) => ({
  node: {
    id: `tt${String(1000000 + n).padStart(7, '0')}`,
    titleText: { text: `Título ${n}` },
    originalTitleText: { text: `Original ${n}` },
    releaseYear: { year: 1990 + (n % 30), endYear: null },
    titleType: { id: 'movie', text: 'Movie' },
    primaryImage: { url: `https://m.media-amazon.com/images/M/abc${n}._V1_QL75_UY207_CR3,0,140,207_.jpg` },
    ratingsSummary: { aggregateRating: 8 + (n % 10) / 10, voteCount: 1000 * n },
    titleGenres: { genres: [{ genre: { text: 'Drama' } }, { genre: { text: 'Crime' } }] },
    plot: { plotText: { plainText: `Sinopse do título ${n}.` } },
    runtime: { seconds: 7200 },
  },
});

const edges = Array.from({ length: 250 }, (_, i) => node(i + 1));
const payload = { props: { pageProps: { pageData: { chartTitles: { edges } } } } };
const filler = '<div class="ipc-page">' + 'x'.repeat(9000) + '</div>';

/* 1. __NEXT_DATA__ */
{
  const html = `<html><body>${filler}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
  const { nodes, strategy } = parseChartHtml(html);
  assert.equal(strategy, 1, 'deveria usar a estratégia 1');
  assert.equal(nodes.length, 250);
  assert.equal(nodes[0].id, 'tt1000001');
  assert.equal(nodes[249].id, 'tt1000250', 'ordem do ranking preservada');
  console.log('✓ 1. __NEXT_DATA__ (ordem e volume preservados)');
}

/* 2. <script type="application/json"> genérico, estrutura diferente */
{
  const alt = { data: { list: { items: edges.slice(0, 100).map((e) => e.node) } } };
  const html = `<html><body>${filler}<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(alt)}</script></body></html>`;
  const { nodes, strategy } = parseChartHtml(html);
  assert.equal(strategy, 2);
  assert.equal(nodes.length, 100);
  console.log('✓ 2. script JSON genérico com outra estrutura');
}

/* 3. JSON-LD ItemList */
{
  const ld = {
    '@type': 'ItemList',
    itemListElement: edges.slice(0, 25).map((e) => ({
      item: {
        url: `https://www.imdb.com/title/${e.node.id}/`,
        name: e.node.titleText.text,
        image: e.node.primaryImage.url,
        aggregateRating: { ratingValue: 8.4 },
      },
    })),
  };
  const html = `<html><body>${filler}<script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
  const { nodes, strategy } = parseChartHtml(html);
  assert.equal(strategy, 3);
  assert.equal(nodes.length, 25);
  assert.equal(nodes[0].titleText.text, 'Título 1');
  console.log('✓ 3. JSON-LD ItemList');
}

/* 4. payload escapado dentro de string JS (App Router / RSC) */
{
  const escaped = JSON.stringify(JSON.stringify({ edges: edges.slice(0, 60) })).slice(1, -1);
  const html = `<html><body>${filler}<script>self.__next_f.push([1,"${escaped}"])</script></body></html>`;
  const { nodes, strategy } = parseChartHtml(html);
  assert.equal(strategy, 4);
  assert.ok(nodes.length >= 55, `esperado ~60, veio ${nodes.length}`);
  assert.equal(nodes[0].id, 'tt1000001');
  console.log(`✓ 4. varredura bruta de payload escapado (${nodes.length} itens)`);
}

/* 5. só HTML, sem nenhum JSON */
{
  const rows = edges
    .slice(0, 40)
    .map(
      (e, i) =>
        `<li><a href="/pt/title/${e.node.id}/?ref_=chttp"><h3 class="ipc-title__text">${i + 1}. ${e.node.titleText.text}</h3></a></li>`,
    )
    .join('');
  const html = `<html><body>${filler}<ul>${rows}</ul></body></html>`;
  const { nodes, strategy } = parseChartHtml(html);
  assert.equal(strategy, 5);
  assert.equal(nodes.length, 40);
  assert.equal(nodes[3].titleText.text, 'Título 4');
  console.log('✓ 5. fallback só com HTML');
}

/* 6. página quebrada de verdade */
{
  const { nodes, strategy } = parseChartHtml(`<html><body>${filler}</body></html>`);
  assert.equal(strategy, 0);
  assert.equal(nodes.length, 0);
  console.log('✓ 6. página sem títulos devolve vazio (não trava)');
}

console.log('\nTodas as estratégias de extração passaram.');
