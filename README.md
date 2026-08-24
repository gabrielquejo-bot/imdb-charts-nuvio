# IMDb Charts — addon para Nuvio

Addon de catálogos (protocolo Stremio, que o Nuvio usa) com quatro listas lidas
**exclusivamente do imdb.com**:

| Catálogo             | id                 | Origem                                    | Itens |
| -------------------- | ------------------ | ----------------------------------------- | ----- |
| IMDb Séries Populares | `imdb_pop_series`  | `imdb.com/pt/chart/tvmeter/`              | 100   |
| IMDb Filmes Populares | `imdb_pop_movies`  | `imdb.com/pt/chart/moviemeter/`           | 100   |
| IMDb Top 250 Séries   | `imdb_top_series`  | `imdb.com/pt/chart/toptv/`                | 250   |
| IMDb Top 250 Filmes   | `imdb_top_movies`  | `imdb.com/pt/chart/top/`                  | 250   |

Sem API, sem TMDB, sem MDBList, sem banco de dados de terceiros. O addon abre a
própria página da lista no IMDb e lê o JSON que o IMDb já embute no HTML.

Os ids do manifest e dos catálogos são **os mesmos da versão 3.2.0** que você já
tem publicada, então quem já instalou o addon não precisa reinstalar.

---

## O que resolve o problema da atualização

A versão anterior gravava as listas no momento do build: sem um novo deploy, o
conteúdo ficava congelado. Aqui os dados saíram do build e passaram a viver em
um armazenamento que a função consegue reescrever sozinha (Netlify Blobs).
Três camadas garantem as 24 horas:

1. **Cron diário** — `netlify/functions/refresh-charts.mjs` roda todo dia às
   05:10 UTC (02:10 em Brasília), relê as 4 listas e regrava tudo.
2. **Revalidação sob demanda** — se um catálogo é pedido e o dado passou de 24h,
   o Nuvio recebe a resposta na hora (com o dado anterior) e a releitura acontece
   em segundo plano.
3. **Primeira carga** — em um deploy novo, o primeiro acesso a cada catálogo faz
   a leitura na hora, então o addon nunca aparece vazio.

Deploy novo não apaga nada: os dados ficam no armazenamento do site, não no
pacote publicado.

---

## Publicando

### Caminho A — repositório novo

```bash
cd imdb-charts-nuvio
git init && git add . && git commit -m "addon IMDb com atualização diária"
git remote add origin git@github.com:SEU_USUARIO/imdb-charts-nuvio.git
git push -u origin main
```

Na Netlify: **Add new site → Import an existing project → GitHub → escolha o
repositório**. As configurações vêm prontas do `netlify.toml`:

- Build command: `echo 'sem etapa de build'`
- Publish directory: `public`
- Functions directory: `netlify/functions`

### Caminho B — reaproveitar o site atual

Se quiser manter a URL `jocular-phoenix-33af45.netlify.app`, copie o conteúdo
desta pasta por cima do repositório que já está ligado a esse site, **apagando
os arquivos antigos do addon** — principalmente qualquer `manifest.json`,
`catalog/` ou JSON de listas dentro da pasta publicada. Depois é só dar push.

### Depois do primeiro deploy

1. Abra `https://SEU-SITE.netlify.app/` — a página mostra o endereço do manifest
   e o estado das quatro listas.
2. Abra `https://SEU-SITE.netlify.app/status.json` e confirme que as 4 listas
   têm `items` maior que zero.
3. Em **Site configuration → Functions**, confirme que `refresh-charts` aparece
   com o selo *Scheduled* e um horário de próxima execução.

> Funções agendadas só rodam em deploys **publicados em produção** (não em
> deploy previews). É a única pegadinha da Netlify aqui.

---

## Endpoints

| Rota                              | Para que serve                                        |
| --------------------------------- | ----------------------------------------------------- |
| `/manifest.json`                  | endereço para colar no Nuvio                          |
| `/catalog/:type/:id.json`         | uma das quatro listas                                 |
| `/catalog/:type/:id/skip=100.json`| paginação (o Nuvio pede sozinho ao rolar a tela)      |
| `/status.json`                    | idade, quantidade de títulos e origem de cada lista   |
| `/refresh`                        | força a releitura das 4 listas agora                  |
| `/ingest`                         | recebe listas coletadas por fora (plano B, ver abaixo)|

---

## Variáveis de ambiente (opcionais)

Em **Site configuration → Environment variables**:

| Variável                 | Padrão | O que faz                                              |
| ------------------------ | ------ | ------------------------------------------------------ |
| `REFRESH_TOKEN`          | vazio  | exige `?token=...` em `/refresh` e habilita `/ingest`   |
| `REFRESH_INTERVAL_HOURS` | `24`   | idade máxima do dado antes de revalidar                 |

---

## Plano B: coleta pelo GitHub Actions

O IMDb às vezes responde `403` para requisições vindas de datacenters. Se isso
acontecer com a Netlify, `.github/workflows/refresh-imdb.yml` faz a mesma coleta
a partir dos runners do GitHub e envia o resultado para `/ingest`. A fonte
continua sendo só o imdb.com — muda apenas de onde parte a requisição.

Para ativar, crie dois *secrets* no repositório (**Settings → Secrets and
variables → Actions**):

- `ADDON_URL` → `https://SEU-SITE.netlify.app`
- `REFRESH_TOKEN` → o mesmo valor configurado na Netlify

O workflow roda todo dia às 05:40 UTC e também pode ser disparado na mão pela
aba **Actions**. Enquanto o cron da Netlify estiver funcionando, ele é apenas
redundância barata.

---

## Desenvolvimento

```bash
npm install
npm test      # 18 cenários: extração, catálogos, paginação, cache, falhas
npm run scrape # coleta de verdade no IMDb e salva em data/charts.json
npm run dev    # netlify dev, addon em http://localhost:8888/manifest.json
```

`npm run scrape` é o teste mais direto quando algo parar de funcionar: ele
mostra quantos títulos vieram de cada lista e **qual estratégia de extração**
foi usada.

---

## Como a extração aguenta mudanças no IMDb

`netlify/lib/imdb.mjs` tenta cinco caminhos, em ordem, e usa o primeiro que
devolver pelo menos 3 títulos:

1. JSON de `<script id="__NEXT_DATA__">` — é o que o IMDb usa hoje;
2. qualquer outro `<script type="application/json">` da página;
3. JSON-LD (`ItemList`), presente nas páginas Top 250;
4. varredura bruta do HTML atrás de objetos com `titleText`, inclusive quando
   vêm escapados dentro de strings JS (formato do Next.js App Router);
5. só HTML: casa a posição do ranking com o nome exibido.

Cada lista também tem uma URL alternativa no próprio IMDb (a versão sem o
prefixo `/pt/`), tentada duas vezes com User-Agents diferentes. A ordem do
ranking é sempre a ordem em que os títulos aparecem no documento.

De cada título são extraídos: id (`ttXXXXXXX`), nome, ano (ou intervalo, no caso
de séries), nota, gêneros, sinopse, duração e pôster — o pôster redimensionado
no próprio CDN de imagens do IMDb.

O addon declara só o recurso `catalog`. Os metadados de cada título (temporadas,
episódios, elenco) continuam vindo do addon de metadados que você já usa no
Nuvio, como sempre foi no protocolo Stremio.

---

## Quando algo der errado

| Sintoma                             | Onde olhar                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Lista vazia no Nuvio                | `/status.json`: se `items` for 0, veja os logs em **Functions → addon**                     |
| `403` nos logs                      | IMDb bloqueando o IP da Netlify → ative o plano B do GitHub Actions                          |
| Dado parado há mais de 24h          | **Functions → refresh-charts**: confira a última execução e use *Run now*                    |
| Extração devolvendo poucos títulos  | rode `npm run scrape`; se todas as 5 estratégias falharem, o HTML do IMDb mudou de formato   |
| `refresh-charts` não aparece        | o deploy precisa estar publicado em produção                                                 |

Uma observação prática: leitura automatizada de páginas do IMDb não é um uso
previsto nos termos do site, e o formato do HTML pode mudar sem aviso. A escada
de cinco estratégias existe justamente para isso — mas vale conferir o
`/status.json` de vez em quando.
