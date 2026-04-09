import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import zlib from 'zlib';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const DIDWW_API_KEY = process.env.DIDWW_API_KEY;

const didwwClient = axios.create({
  baseURL: 'https://api.didww.com/v3', 
  headers: {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'Api-Key': DIDWW_API_KEY
  }
});

const digitalOceanClient = axios.create({
  baseURL: 'https://api.digitalocean.com/v2',
  headers: {
    'Authorization': `Bearer ${process.env.DIGITALOCEAN_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

const supabaseAdminClient = axios.create({
  baseURL: 'https://api.supabase.com/v1',
  headers: {
    'Authorization': `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Cache in-memory to prevent long loading times and rate limits
// Cache in-memory
let cachedDids = null;
let lastCacheTime = 0;
let didwwSummary = {
    totalDids: 0,
    totalCost: 0,
    orphanCount: 0,
    clientAggr: {},
    lastSync: null,
    status: 'pending'
};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

// Background Sync Function
async function syncDidwwData() {
    console.log('🔄 Iniciando sincronización en segundo plano...');
    didwwSummary.status = 'syncing';
    try {
        let allDids = [];
        const firstPage = await didwwClient.get('/dids', { params: { 'page[number]': 1, 'page[size]': 100 } });
        const firstData = firstPage.data.data || [];
        allDids.push(...firstData);
        
        const meta = firstPage.data.meta;
        const totalRecords = meta?.total_records || firstData.length;
        const totalPages = Math.ceil(totalRecords / 100);
        
        for (let p = 2; p <= totalPages; p++) {
            const r = await didwwClient.get('/dids', { params: { 'page[number]': p, 'page[size]': 100 } });
            allDids.push(...(r.data.data || []));
            if (p % 20 === 0) console.log(`   Sincronizando: ${Math.round((p/totalPages)*100)}%`);
            // Small delay to prevent hitting rate limits during background sync
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const processed = allDids.filter(d => d?.attributes).map(did => ({
            id: did.id,
            number: did.attributes.number,
            description: did.attributes.description || '',
            expire_at: did.attributes.expires_at || did.attributes.expire_at,
            monthly_price: did.attributes.monthly_price || 0.55
        }));

        // Calculate Summary
        const summary = {
            totalDids: processed.length,
            totalCost: processed.reduce((acc, d) => acc + (d.monthly_price || 0.55), 0),
            orphanCount: processed.filter(d => !d.description).length,
            clientAggr: {},
            lastSync: new Date().toISOString(),
            status: 'ready'
        };

        processed.forEach(d => {
            const client = d.description || 'Sin Cliente';
            if (!summary.clientAggr[client]) summary.clientAggr[client] = { count: 0, total: 0 };
            summary.clientAggr[client].count++;
            summary.clientAggr[client].total += (d.monthly_price || 0.55);
        });

        cachedDids = processed;
        didwwSummary = summary;
        lastCacheTime = Date.now();
        console.log('✅ Sincronización exitosa:', summary.totalDids, 'DIDs');
    } catch (error) {
        console.error('❌ Error en Sync:', error.message);
        didwwSummary.status = 'error';
    }
}

// Trigger initial sync
syncDidwwData();
// Re-sync every 30 mins
setInterval(syncDidwwData, CACHE_TTL);

// Balance Endpoint
app.get('/api/v1/didww/balance', async (req, res) => {
  try {
    const response = await didwwClient.get('/balance');
    // In JSON API format: data[0].attributes.balance
    const balanceData = response.data.data;
    let balance = 0;
    if (Array.isArray(balanceData) && balanceData.length > 0) {
        balance = balanceData[0].attributes.balance;
    } else if (balanceData.attributes && balanceData.attributes.balance) {
        balance = balanceData.attributes.balance;
    }
    res.json({ success: true, balance: parseFloat(balance) });
  } catch (error) {
    console.error('Error fetching balance:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch balance' });
  }
});

// DIDs Endpoint
app.get('/api/v1/didww/dids', async (req, res) => {
  try {
    if (cachedDids && (Date.now() - lastCacheTime) < CACHE_TTL) {
        console.log('✅ Retornando DIDs desde caché', cachedDids.length);
        return res.json({ success: true, data: cachedDids });
    }

    let allDids = [];
    
    // Fetch Page 1
    const firstPage = await didwwClient.get('/dids', {
        params: { 'page[number]': 1, 'page[size]': 100 }
    });
    
    const firstData = firstPage.data.data || [];
    allDids.push(...firstData);
    
    const meta = firstPage.data.meta;
    const totalRecords = meta && meta.total_records ? meta.total_records : firstData.length;
    const totalPages = Math.ceil(totalRecords / 100);
    
    // We fetch the rest in batches of 50 to avoid rate limits while being fast
    let promises = [];
    for (let p = 2; p <= totalPages; p++) {
        promises.push(
            didwwClient.get('/dids', { params: { 'page[number]': p, 'page[size]': 100 } })
                .then(r => r.data.data || [])
                .catch(e => {
                    console.error(`Error page ${p}:`, e.message);
                    return [];
                })
        );
        
        // Wait every 25 requests to accelerate fetching (reduced for stability)
        if (promises.length === 25 || p === totalPages) {
            const results = await Promise.all(promises);
            results.forEach(d => allDids.push(...d));
            promises = [];
        }
        
        if (allDids.length > 20000) break; // Hard safety cap
    }

    // Process and extract requested fields
    const processedDids = allDids
        .filter(did => did && did.attributes) // Safety filter
        .map(did => {
            const attrs = did.attributes;
            return {
                id: did.id,
                number: attrs.number,
                description: attrs.description || '',
                expire_at: attrs.expires_at || attrs.expire_at,
                monthly_price: attrs.monthly_price || 0.55
            };
        });

    console.log(`✅ Sincronización completa. DIDs totales: ${processedDids.length}`);
    cachedDids = processedDids;
    lastCacheTime = Date.now();

    res.json({ success: true, data: processedDids });
  } catch (error) {
    console.error('Error fetching DIDs:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch DIDs' });
  }
});

app.get('/api/v1/didww/summary', (req, res) => {
    res.json({ success: true, summary: didwwSummary });
});

// --- DigitalOcean Endpoints ---

app.get('/api/v1/digitalocean/balance', async (req, res) => {
    try {
        const response = await digitalOceanClient.get('/customers/my/balance');
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error('Error DO Balance:', error.message);
        res.status(500).json({ success: false, error: 'DO Balance fetch failed' });
    }
});

app.get('/api/v1/digitalocean/droplets', async (req, res) => {
    try {
        const response = await digitalOceanClient.get('/droplets');
        res.json({ success: true, data: response.data.droplets });
    } catch (error) {
        console.error('Error DO Droplets:', error.message);
        res.status(500).json({ success: false, error: 'DO Droplets fetch failed' });
    }
});

// --- Supabase Management Endpoints ---

app.get('/api/v1/supabase/projects', async (req, res) => {
    try {
        const response = await supabaseAdminClient.get('/projects');
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error('Error Supabase Projects:', error.message);
        res.status(500).json({ success: false, error: 'Supabase Projects fetch failed' });
    }
});

app.get('/api/v1/didww/balance', async (req, res) => {
    try {
        const response = await didwwClient.get('/balances');
        // JSON:API structure: data[0].attributes.amount
        const balance = response.data.data?.[0]?.attributes?.amount || 0;
        res.json({ success: true, balance: parseFloat(balance) });
    } catch (error) {
        console.error('Error DIDWW Balance:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'DIDWW Balance fetch failed' });
    }
});

// --- Voice Usage & Billing Relay ---

// Relay to fix PDF download issues (names and types)
app.post('/api/v1/billing/download-relay', (req, res) => {
    const { pdfData, fileName } = req.body;
    if (!pdfData || !fileName) {
        return res.status(400).json({ success: false, error: 'Missing data' });
    }

    try {
        // pdfData is "data:application/pdf;base64,..."
        const base64 = pdfData.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Error in download-relay:', error);
        res.status(500).send('Error generating download');
    }
});

// Helper to handle DIDWW Export Lifecycle (Create -> Poll -> Download -> Parse)
async function fetchUsageFromExport(exportType, year, month, didMapping) {
    console.log(`🚀 Iniciando exportación ${exportType} para ${month}/${year}`);
    
    // 1. Create Export
    const createRes = await didwwClient.post('/exports', {
        data: {
            type: 'exports',
            attributes: {
                export_type: exportType,
                filters: { year, month }
            }
        }
    });

    const exportId = createRes.data.data.id;
    let status = 'pending';
    let downloadUrl = null;
    let attempts = 0;

    // 2. Poll for completion
    while (status !== 'completed' && attempts < 12) {
        attempts++;
        await new Promise(r => setTimeout(r, 5000)); // Wait 5s
        const checkRes = await didwwClient.get(`/exports/${exportId}`);
        const attrs = checkRes.data.data.attributes;
        status = attrs.status.toLowerCase();
        console.log(`   Estado exportación ${exportId}: ${status} (Intento ${attempts})`);
        
        if (status === 'completed') {
            downloadUrl = attrs.url;
            break;
        }
        if (status === 'failed') throw new Error(`Exportación ${exportId} falló en DIDWW`);
    }

    if (!downloadUrl) throw new Error(`Tiempo de espera agotado para exportación ${exportId}`);

    // 3. Download CSV.GZ
    console.log(`   Descargando reporte desde: ${downloadUrl}`);
    const downloadRes = await didwwClient.get(downloadUrl, { responseType: 'arraybuffer' });
    
    // 4. Decompress and Parse
    const decompressed = zlib.gunzipSync(downloadRes.data).toString('utf-8');
    const lines = decompressed.split('\n');
    console.log(`   CSV descargado: ${lines.length} líneas.`);
    if (lines.length > 1) {
        console.log(`   Header: ${lines[0]}`);
        console.log(`   Fila 1: ${lines[1]}`);
    }
    const header = lines[0].split(',');
    
    const idxDuration = header.findIndex(h => h.toLowerCase().includes('duration'));
    
    // Prioritize "DID" over "Source" for mapping to our inventory
    let idxDid = header.findIndex(h => h.toLowerCase() === 'did' || h.toLowerCase() === 'did_number');
    if (idxDid === -1) {
        idxDid = header.findIndex(h => h.toLowerCase() === 'source' || h.toLowerCase() === 'src_number');
    }
    
    // Sum cost columns (TollFree, Termination, Metered Channels, etc.)
    const costIndices = [];
    header.forEach((h, i) => {
        if (h.toLowerCase().includes('amount (usd)') || h.toLowerCase() === 'price' || h.toLowerCase() === 'selling_amount') {
            costIndices.push(i);
        }
    });

    console.log(`   Indices encontrados: Duración=${idxDuration}, DID=${idxDid}, Costos=[${costIndices.join(',')}]`);

    const results = {};
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < header.length) continue;

        const didNum = row[idxDid]?.trim();
        const duration = parseFloat(row[idxDuration]) || 0;
        
        let totalCost = 0;
        costIndices.forEach(idx => {
            totalCost += parseFloat(row[idx]) || 0;
        });

        if (!didNum) continue;

        if (!results[didNum]) results[didNum] = { minutes: 0, cost: 0, calls: 0 };
        results[didNum].minutes += (duration / 60);
        results[didNum].cost += totalCost;
        results[didNum].calls++;
    }

    return results;
}

app.get('/api/v1/didww/usage', async (req, res) => {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1; // 1-indexed

        // Fetch Inbound (CDR_IN) and Outbound (CDR_OUT)
        // Note: For simplicity and speed, we start with IN as it maps directly to DIDs
        // In a real scenario we'd do both and merge.
        const inboundUsage = await fetchUsageFromExport('cdr_in', year, month);
        
        // Map numbers to clients
        const usageByClient = {};
        const numberToClient = {};
        
        if (cachedDids) {
            cachedDids.forEach(d => {
                numberToClient[d.number] = d.description || 'Sin Cliente';
            });
        }

        Object.keys(inboundUsage).forEach(num => {
            const client = numberToClient[num] || 'Otros / Sin DID';
            if (!usageByClient[client]) usageByClient[client] = { minutes: 0, cost: 0, calls: 0 };
            
            usageByClient[client].minutes += inboundUsage[num].minutes;
            usageByClient[client].cost += inboundUsage[num].cost;
            usageByClient[client].calls += inboundUsage[num].calls;
        });

        console.log(`✅ Agregación completada para ${Object.keys(usageByClient).length} clientes.`);
        res.json({ success: true, usage: usageByClient });
    } catch (error) {
        console.error('❌ Error in usage endpoint:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
  console.log(`✅ Backend server listening on port ${PORT}`);
});
