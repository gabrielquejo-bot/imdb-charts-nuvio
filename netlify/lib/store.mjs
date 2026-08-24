/**
 * store.mjs — onde as listas já coletadas ficam guardadas entre requisições.
 *
 * Usa Netlify Blobs (armazenamento nativo da própria Netlify, sem serviço
 * externo). Se os Blobs não estiverem disponíveis (ex.: `node scripts/...`
 * fora da Netlify), cai para um cache em memória do processo.
 */

const STORE_NAME = 'imdb-charts';
const keyFor = (chartId) => `chart:${chartId}`;

const memory = new Map();
let blobStore;
let blobsDisabled = false;

async function getBlobStore() {
  if (blobsDisabled) return null;
  if (blobStore) return blobStore;
  try {
    const { getStore } = await import('@netlify/blobs');
    blobStore = getStore({ name: STORE_NAME, consistency: 'strong' });
    return blobStore;
  } catch (err) {
    console.warn('[store] Netlify Blobs indisponível, usando memória:', err.message);
    blobsDisabled = true;
    return null;
  }
}

/** Lê uma lista salva. Devolve null se nunca foi salva. */
export async function readChart(chartId) {
  const cached = memory.get(chartId);
  if (cached) return cached;

  const store = await getBlobStore();
  if (!store) return null;
  try {
    const data = await store.get(keyFor(chartId), { type: 'json' });
    if (data) memory.set(chartId, data);
    return data || null;
  } catch (err) {
    console.warn(`[store] falha ao ler ${chartId}:`, err.message);
    return null;
  }
}

/** Salva uma lista coletada. */
export async function writeChart(chartId, payload) {
  memory.set(chartId, payload);
  const store = await getBlobStore();
  if (!store) return false;
  try {
    await store.setJSON(keyFor(chartId), payload);
    return true;
  } catch (err) {
    console.warn(`[store] falha ao gravar ${chartId}:`, err.message);
    return false;
  }
}

/** Limpa o cache em memória (usado após uma atualização forçada). */
export function dropMemory(chartId) {
  if (chartId) memory.delete(chartId);
  else memory.clear();
}
