import assert from 'node:assert';

/* ---- simula o imdb.com devolvendo a página real (com __NEXT_DATA__) ---- */
const makeNode = (n, kind) => ({
  node: {
    id: `tt${String(2000000 + n).padStart(7, '0')}`,
    titleText: { text: `${kind} ${n}` },
    releaseYear: { year: 2000 + (n % 24), endYear: kind === 'Série' ? 2024 : null },
    titleType: { id: kind === 'Série' ? 'tvSeries' : 'movie' },
    primaryImage: { url: `https://m.media-amazon.com/images/M/p${n}._V1_QL75_UY207_CR3,0,140,207_.jpg` },
    ratingsSummary: { aggregateRating: 7.5 },
    titleGenres: { genres: [{ genre: { text: n % 2 ? 'Drama' : 'Ação' } }] },
    plot: { plotText: { plainText: `Sinopse ${n}` } },
    runtime: { seconds: 5400 },
  },
});

let requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  const kind = /toptv|tvmeter/.test(url) ? 'Série' : 'Filme';
  const total = /chart\/top\/|toptv/.test(url) ? 250 : 100;
  const edges = Array.from({ length: total }, (_, i) => makeNode(i + 1, kind));
  const body = JSON.stringify({ props: { pageProps: { pageData: { chartTitles: { edges } } } } });
  const html = `<html><body>${'x'.repeat(9000)}<script id="__NEXT_DATA__" type="application/json">${body}</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
};

const { default: addon } = await import('../netlify/functions/addon.mjs');

const call = (path, params = {}, init = {}) =>
  addon(new Request(`https://exemplo.netlify.app${path}`, init), { params });

/* ---- manifest ---- */
{
  const res = await call('/manifest.json');
  const manifest = await res.json();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(manifest.id, 'community.imdb.charts.ptbr');
  assert.deepEqual(
    manifest.catalogs.map((c) => `${c.type}/${c.id}`),
    ['series/imdb_pop_series', 'movie/imdb_pop_movies', 'series/imdb_top_series', 'movie/imdb_top_movies'],
  );
  console.log('✓ manifest com as 4 listas e os mesmos ids da versão atual');
}

/* ---- catálogo (primeira chamada: coleta ao vivo) ---- */
{
  const res = await call('/catalog/movie/imdb_top_movies.json', {
    type: 'movie',
    id: 'imdb_top_movies.json',
  });
  const { metas } = await res.json();
  assert.equal(res.status, 200);
  assert.equal(metas.length, 100, 'primeira página traz 100 itens');
  assert.equal(metas[0].id, 'tt2000001');
  assert.equal(metas[0].type, 'movie');
  assert.equal(metas[0].posterShape, 'poster');
  assert.match(metas[0].poster, /_V1_QL75_UX380_CR0,0,380,562_\.jpg$/, 'pôster redimensionado no CDN do IMDb');
  assert.equal(metas[0].imdbRating, '7.5');
  assert.equal(metas[0].releaseInfo, '2001');
  assert.ok(!('rank' in metas[0]), 'campos internos não vazam para o cliente');
  console.log(`✓ catálogo Top 250 Filmes: ${metas.length} itens, pôster e nota preenchidos`);
}

/* ---- paginação ---- */
{
  const res = await call('/catalog/movie/imdb_top_movies/skip=200.json', {
    type: 'movie',
    id: 'imdb_top_movies',
    extra: 'skip=200.json',
  });
  const { metas } = await res.json();
  assert.equal(metas.length, 50, 'Top 250 termina no item 250');
  assert.equal(metas[0].id, 'tt2000201');
  console.log('✓ paginação por skip funciona até o 250º título');
}

/* ---- cache: segunda leitura não bate no IMDb de novo ---- */
{
  const antes = requests.length;
  await call('/catalog/movie/imdb_top_movies.json', { type: 'movie', id: 'imdb_top_movies.json' });
  assert.equal(requests.length, antes, 'dado dentro das 24h é servido do armazenamento');
  console.log('✓ dentro das 24h o addon não refaz a leitura');
}

/* ---- séries ---- */
{
  const res = await call('/catalog/series/imdb_pop_series.json', {
    type: 'series',
    id: 'imdb_pop_series.json',
  });
  const { metas } = await res.json();
  assert.equal(metas[0].type, 'series');
  assert.equal(metas[0].releaseInfo, '2001-2024', 'série usa intervalo de anos');
  console.log('✓ catálogo de séries com intervalo de anos');
}

/* ---- filtro por gênero ---- */
{
  const res = await call('/catalog/movie/imdb_pop_movies/genre=Ação.json', {
    type: 'movie',
    id: 'imdb_pop_movies',
    extra: 'genre=A%C3%A7%C3%A3o.json',
  });
  const { metas } = await res.json();
  assert.ok(metas.length > 0 && metas.every((m) => m.genres.includes('Ação')));
  console.log(`✓ filtro por gênero (${metas.length} itens de Ação)`);
}

/* ---- tipo trocado / catálogo inexistente ---- */
{
  const res = await call('/catalog/series/imdb_top_movies.json', {
    type: 'series',
    id: 'imdb_top_movies.json',
  });
  assert.equal(res.status, 404);
  console.log('✓ catálogo inválido devolve 404 sem quebrar');
}

/* ---- status ---- */
{
  const res = await call('/status.json');
  const status = await res.json();
  assert.equal(status.refreshIntervalHours, 24);
  assert.equal(status.charts.length, 4);
  const top = status.charts.find((c) => c.id === 'imdb_top_movies');
  assert.equal(top.items, 250);
  assert.equal(top.stale, false);
  console.log('✓ status.json informa idade e volume de cada lista');
}

/* ---- CORS preflight ---- */
{
  const res = await call('/manifest.json', {}, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  console.log('✓ preflight OPTIONS responde 204');
}

/* ---- IMDb fora do ar ---- */
{
  globalThis.fetch = async () => new Response('bloqueado', { status: 403 });

  // lista já salva: continua sendo servida normalmente
  const salva = await call('/catalog/movie/imdb_top_movies.json', {
    type: 'movie',
    id: 'imdb_top_movies.json',
  });
  const { metas } = await salva.json();
  assert.equal(salva.status, 200);
  assert.equal(metas.length, 100);
  console.log('✓ com o IMDb inacessível, o addon segue servindo o último dado bom');

  // lista nunca lida: responde vazio com 200, sem derrubar o app
  const nova = await call('/catalog/series/imdb_top_series.json', {
    type: 'series',
    id: 'imdb_top_series.json',
  });
  assert.equal(nova.status, 200);
  assert.deepEqual(await nova.json(), { metas: [] });
  console.log('✓ lista ainda sem dados responde vazio em vez de erro');
}

/* ---- dado vencido é revalidado em segundo plano ---- */
{
  const { readChart } = await import('../netlify/lib/store.mjs');
  const salvo = await readChart('imdb_pop_movies');
  salvo.updatedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString(); // 30h atrás

  let revalidou = false;
  globalThis.fetch = async (url) => {
    revalidou = true;
    const edges = Array.from({ length: 100 }, (_, i) => makeNode(i + 500, 'Filme'));
    const body = JSON.stringify({ props: { pageProps: { pageData: { chartTitles: { edges } } } } });
    return new Response(
      `<html><body>${'x'.repeat(9000)}<script id="__NEXT_DATA__" type="application/json">${body}</script></body></html>`,
      { status: 200 },
    );
  };

  const pendentes = [];
  const res = await addon(
    new Request('https://exemplo.netlify.app/catalog/movie/imdb_pop_movies.json'),
    { params: { type: 'movie', id: 'imdb_pop_movies.json' }, waitUntil: (p) => pendentes.push(p) },
  );
  const { metas } = await res.json();
  assert.equal(metas[0].id, 'tt2000001', 'resposta imediata usa o dado antigo');
  await Promise.all(pendentes);
  assert.ok(revalidou, 'a revalidação foi disparada em segundo plano');

  const atualizado = await readChart('imdb_pop_movies');
  assert.equal(atualizado.items[0].id, 'tt2000500', 'próxima leitura já traz a lista nova');
  console.log('✓ passadas 24h: responde na hora e atualiza por trás');
}

console.log('\nAddon aprovado em todos os cenários.');
