// --- State Management ---
let didwwBalance = 0;
let didwwDids = [];
let mergedData = [];
let currentPage = 1;
const ROWS_PER_PAGE = 100;
let allDescriptions = [];
let nextInvoiceNumber = parseInt(localStorage.getItem('nextInvoiceNumber')) || 1000;
let currentInvoiceItems = [];
let currentClient = '';
let activeTab = 'inventory';
let isInitializing = false;
let initRetryCount = 0;
const MAX_INIT_RETIRES = 3;

let doBalance = 0;
let doDroplets = [];
let supabaseProjects = [];
let doMTDCost = 0;
let supabaseEstCost = 0;
let voiceUsageData = {}; 
let didwwSummaryData = null; 
let inventoryLoaded = false;

// --- DOM References ---
const kpiBalance = document.getElementById('kpi-balance');
const kpiProjected = document.getElementById('kpi-projected');
const kpiTotalDids = document.getElementById('kpi-total-dids');
const kpiBurnRate = document.getElementById('kpi-burn-rate');
const kpiOrphans = document.getElementById('kpi-orphans');
const tableBody = document.getElementById('dids-table-body');
const tableInfo = document.getElementById('table-info');
const searchInput = document.getElementById('search-input');
const filterStatus = document.getElementById('filter-status');
const filterClient = document.getElementById('filter-client');
const breakdownSection = document.getElementById('breakdown-section');
const breakdownContainer = document.getElementById('breakdown-container');
const breakdownDaysSelect = document.getElementById('breakdown-days');
const btnExport = document.getElementById('btn-export');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnSyncFull = document.getElementById('btn-sync-full');
const pageInfo = document.getElementById('page-info');
const syncDot = document.getElementById('sync-dot');
const syncText = document.getElementById('sync-text');
const lastSyncLabel = document.getElementById('last-sync-time');
const backendStatusLabel = document.getElementById('backend-sync-info');

const tabInventory = document.getElementById('tab-inventory');
const tabBilling = document.getElementById('tab-billing');
const tabInfrastructure = document.getElementById('tab-infrastructure');
const inventoryView = document.getElementById('inventory-view');
const billingView = document.getElementById('billing-view');
const infrastructureView = document.getElementById('infrastructure-view');

const billingTableBody = document.getElementById('billing-table-body');
const globalUnitPriceInput = document.getElementById('global-unit-price');

const summaryIncome = document.getElementById('summary-income');
const summaryExpenses = document.getElementById('summary-expenses');
const summaryProfit = document.getElementById('summary-profit');
const summaryDIDWWCost = document.getElementById('summary-didww-cost');
const summaryDOCost = document.getElementById('summary-do-cost');
const summarySupabaseCost = document.getElementById('summary-supabase-cost');

const invoiceModal = document.getElementById('invoice-modal');
const closeModal = document.getElementById('close-modal');
const modalInvoiceNumber = document.getElementById('modal-invoice-number');
const modalClientName = document.getElementById('modal-client-name');
const invoiceItemsBody = document.getElementById('invoice-items-body');
const btnAddItem = document.getElementById('btn-add-item');
const invoiceNotes = document.getElementById('invoice-notes');
const modalSubtotal = document.getElementById('modal-subtotal');
const modalTotal = document.getElementById('modal-total');
const btnDownloadPdf = document.getElementById('btn-download-pdf');

const usageModal = document.getElementById('usage-modal');
const closeUsageModal = document.getElementById('close-usage-modal');
const usageClientName = document.getElementById('usage-client-name');
const usageTotalMinutes = document.getElementById('usage-total-minutes');
const usageTotalCost = document.getElementById('usage-total-cost');
const usageTotalCalls = document.getElementById('usage-total-calls');
const usageAvgCost = document.getElementById('usage-avg-cost');
const btnUsageOk = document.getElementById('btn-usage-ok');

const dropletsContainer = document.getElementById('droplets-container');
const supabaseContainer = document.getElementById('supabase-projects-container');
const kpiDoCost = document.getElementById('kpi-do-cost');
const kpiSupabaseCost = document.getElementById('kpi-supabase-cost');

// --- Initialization ---

async function init() {
    if (isInitializing) return;
    isInitializing = true;
    setSyncStatus(true, `Sincronizando (Intento ${initRetryCount + 1})...`);

    try {
        const fetchAPI = async (url, svc) => {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${svc} falló (${r.status})`);
            return r.json();
        };

        const [resBal, resDoB, resDoD, resSupa, resSum] = await Promise.all([
            fetchAPI('/api/v1/didww/balance', 'Balance DIDWW'),
            fetchAPI('/api/v1/digitalocean/balance', 'DO Balance'),
            fetchAPI('/api/v1/digitalocean/droplets', 'DO Droplets'),
            fetchAPI('/api/v1/supabase/projects', 'Supabase'),
            fetchAPI('/api/v1/didww/summary', 'Resumen DIDWW')
        ]);

        if (resBal.success) {
            didwwBalance = resBal.balance;
            kpiBalance.innerText = `$${didwwBalance.toFixed(2)}`;
        }
        if (resDoB.success) {
            doMTDCost = parseFloat(resDoB.data.month_to_date_usage || 0);
            kpiDoCost.innerText = `$${doMTDCost.toFixed(2)}`;
        }
        if (resDoD.success) doDroplets = resDoD.data;
        if (resSupa.success) {
            supabaseProjects = resSupa.data;
            supabaseEstCost = supabaseProjects.filter(p => p.status === 'ACTIVE_HEALTHY').length * 25.00;
            kpiSupabaseCost.innerText = `$${supabaseEstCost.toFixed(2)}`;
        }
        fetchVoiceUsage();
        if (resSum.success) {
            didwwSummaryData = resSum.summary;
            updateKPIsFromSummary();
            renderBillingTable();
            if (didwwSummaryData.status === 'ready') {
                backendStatusLabel.innerText = 'Servidor: Sincronizado';
                backendStatusLabel.classList.replace('text-gray-500', 'text-green-400');
                if (lastSyncLabel) lastSyncLabel.innerText = `Última sinc: ${new Date(didwwSummaryData.lastSync).toLocaleTimeString()}`;
            }
        }

        setSyncStatus(false, 'Sincronizado');
        initRetryCount = 0;
    } catch (err) {
        console.error('❌ Init Error:', err.message);
        if (initRetryCount < MAX_INIT_RETIRES) {
            initRetryCount++;
            setTimeout(init, 3000);
        } else {
            setSyncStatus(false, `Error: ${err.message}`);
        }
    } finally {
        isInitializing = false;
    }
}

async function fetchVoiceUsage() {
    try {
        console.log("⏳ Solicitando analítica de voz (puede tardar ~60s)...");
        const r = await fetch('/api/v1/didww/usage');
        if (!r.ok) throw new Error(`Fallo fetch uso: ${r.status}`);
        const res = await r.json();
        if (res.success) {
            voiceUsageData = res.usage;
            console.log("✅ Analítica de voz cargada satisfactoriamente.");
            renderBillingTable();
        }
    } catch (e) {
        console.error("❌ Error cargando analítica de voz:", e);
    }
}

function updateKPIsFromSummary() {
    if (!didwwSummaryData) return;
    const projectedCost = didwwSummaryData.totalCost;
    const totalDids = didwwSummaryData.totalDids;
    let days = 0;
    if (projectedCost > 0) {
        const daily = projectedCost / 30;
        days = Math.floor(didwwBalance / daily);
    }
    if (kpiProjected) kpiProjected.innerText = `$${projectedCost.toFixed(2)}`;
    if (kpiTotalDids) kpiTotalDids.innerText = `${totalDids} DIDs Activos`;
    if (kpiBurnRate) kpiBurnRate.innerText = `${days} días`;
    if (kpiOrphans) kpiOrphans.innerText = didwwSummaryData.orphanCount;
    renderBreakdownOffline();
}

async function loadFullInventory() {
    if (inventoryLoaded) return;
    try {
        btnSyncFull.disabled = true;
        btnSyncFull.innerHTML = `<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>`;
        const r = await fetch('/api/v1/didww/dids');
        const data = await r.json();
        if (data.success) {
            didwwDids = data.data;
            inventoryLoaded = true;
            processData();
            btnSyncFull.innerHTML = `✅ Inventario Cargado`;
            btnSyncFull.classList.replace('bg-gray-800', 'bg-green-600/20');
        }
    } catch (e) {
        btnSyncFull.disabled = false;
        btnSyncFull.innerText = '❌ Error';
    }
}

function processData() {
    let orphans = 0;
    const today = new Date();
    mergedData = didwwDids.map(d => {
        const isOrphan = !d.description?.trim();
        if (isOrphan) orphans++;
        const exp = new Date(d.expire_at);
        const days = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
        return { ...d, isOrphan, daysLeft: days, isCritical: days <= 7 };
    });

    const descSet = new Set();
    didwwDids.forEach(d => { if (d.description?.trim()) descSet.add(d.description.trim()); });
    allDescriptions = Array.from(descSet).sort();
    
    filterClient.innerHTML = '<option value="all">Cliente: Todos</option>';
    allDescriptions.forEach(desc => {
        const opt = document.createElement('option');
        opt.value = opt.innerText = desc;
        filterClient.appendChild(opt);
    });

    renderBreakdown();
    renderTable();
}

// --- Common Rendering ---

function renderBreakdownOffline() {
    if (!didwwSummaryData || !breakdownContainer) return;
    const entries = Object.entries(didwwSummaryData.clientAggr).sort((a,b) => b[1].total - a[1].total);
    if (entries.length === 0) { breakdownSection.classList.add('hidden'); return; }
    breakdownSection.classList.remove('hidden');
    breakdownContainer.innerHTML = '';
    entries.slice(0, 12).forEach(([name, data]) => {
        const div = document.createElement('div');
        div.className = "glass p-4 rounded-xl border border-gray-800 hover:border-purple-500/50 transition-all group animate-fade-in";
        div.innerHTML = `<div class="text-xs text-gray-500 uppercase tracking-tighter mb-1 font-bold line-clamp-1">${name}</div>
            <p class="text-lg font-bold text-white">$${data.total.toFixed(2)}</p><p class="text-[10px] text-gray-400">${data.count} DIDs</p>`;
        breakdownContainer.appendChild(div);
    });
}

function renderBreakdown() {
    const limit = parseInt(breakdownDaysSelect.value) || 7;
    const clSum = {};
    mergedData.forEach(i => {
        if (i.daysLeft >= 0 && i.daysLeft <= limit) {
            const name = i.description?.trim() || 'Sin Cliente';
            if (!clSum[name]) clSum[name] = { count: 0, total: 0 };
            clSum[name].count++; clSum[name].total += (i.monthly_price || 0.55);
        }
    });
    const ent = Object.entries(clSum).sort((a,b) => b[1].total - a[1].total);
    if (ent.length === 0) { breakdownSection.classList.add('hidden'); return; }
    breakdownSection.classList.remove('hidden');
    breakdownContainer.innerHTML = '';
    ent.slice(0, 12).forEach(([n, d]) => {
        const div = document.createElement('div');
        div.className = "glass p-4 rounded-xl border border-gray-800 hover:border-purple-500/50 transition-all group animate-fade-in";
        div.innerHTML = `<div class="text-xs text-gray-500 uppercase tracking-tighter mb-1 font-bold line-clamp-1">${n}</div>
            <p class="text-lg font-bold text-white">$${d.total.toFixed(2)}</p><p class="text-[10px] text-gray-400">${d.count} por vencer</p>`;
        breakdownContainer.appendChild(div);
    });
}

function renderTable() {
    const search = searchInput.value.toLowerCase();
    const stat = filterStatus.value;
    const cli = filterClient.value;
    let filtered = mergedData.filter(i => {
        if (!i.number.toLowerCase().includes(search) && !(i.description||'').toLowerCase().includes(search)) return false;
        if (stat === 'critical' && !i.isCritical) return false;
        if (stat === 'orphans' && !i.isOrphan) return false;
        if (cli !== 'all' && i.description !== cli) return false;
        return true;
    });
    const totalP = Math.ceil(filtered.length / ROWS_PER_PAGE) || 1;
    if (currentPage > totalP) currentPage = totalP;
    const start = (currentPage - 1) * ROWS_PER_PAGE;
    tableBody.innerHTML = '';
    filtered.slice(start, start + ROWS_PER_PAGE).forEach(i => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-800/50 border-b border-gray-800/50 text-sm';
        const st = i.isOrphan ? '<span class="px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20">Huérfano</span>' : '<span class="px-2 py-0.5 rounded text-[10px] bg-green-500/10 text-green-400 border border-green-500/20">Activo</span>';
        const cr = i.isCritical ? ` <span class="px-2 py-0.5 rounded text-[10px] bg-red-500/10 text-red-100">Vence en ${i.daysLeft}d</span>` : '';
        tr.innerHTML = `<td class="px-6 py-4 font-medium text-gray-100">${i.number}</td><td class="px-6 py-4 text-gray-400">$${(i.monthly_price||0.55).toFixed(2)}</td><td class="px-6 py-4 text-gray-400">${new Date(i.expire_at).toLocaleDateString()}</td><td class="px-6 py-4">${st}${cr}</td><td class="px-6 py-4 text-right text-gray-500">${i.description||'N/A'}</td>`;
        tableBody.appendChild(tr);
    });
    tableInfo.innerText = `Mostrando ${start + 1} - ${Math.min(start + ROWS_PER_PAGE, filtered.length)} de ${filtered.length}`;
    pageInfo.innerText = `Página ${currentPage} de ${totalP}`;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= totalP;
}

function resetPaginationAndRender() { currentPage = 1; renderTable(); }

function exportCsv() {
    const csv = ["Numero,Costo,Vencimiento,Cliente", ...mergedData.map(d => `${d.number},${d.monthly_price},${d.expire_at},${d.description||''}`)].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'inventario_voxflow.csv'; a.click();
}

// --- Billing & Modals ---

function switchTab(tab) {
    activeTab = tab;
    [inventoryView, billingView, infrastructureView].forEach(v => v.classList.add('hidden'));
    [tabInventory, tabBilling, tabInfrastructure].forEach(t => t.classList.remove('active', 'bg-gray-700/50', 'border-blue-500/50'));
    if (tab === 'inventory') { inventoryView.classList.remove('hidden'); tabInventory.classList.add('active', 'bg-gray-700/50', 'border-blue-500/50'); }
    else if (tab === 'billing') { billingView.classList.remove('hidden'); tabBilling.classList.add('active', 'bg-gray-700/50', 'border-blue-500/50'); renderBillingTable(); }
    else if (tab === 'infrastructure') { infrastructureView.classList.remove('hidden'); tabInfrastructure.classList.add('active', 'bg-gray-700/50', 'border-blue-500/50'); renderInfrastructure(); }
}

function renderBillingTable() {
    const price = parseFloat(globalUnitPriceInput.value) || 1.50;
    let income = 0; let netProf = 0;
    const aggr = didwwSummaryData?.clientAggr || {};
    const entries = Object.entries(aggr).sort((a,b) => b[1].count - a[1].count);

    Object.entries(aggr).forEach(([name, data]) => {
        const isVip = name.toLowerCase().includes('voxflowpro') || name.toLowerCase().includes('1kpro');
        const clIncome = data.count * price;
        if (isVip) { income += clIncome; netProf += (clIncome - (data.total || data.count * 0.55)); }
    });

    billingTableBody.innerHTML = '';
    const didCost = didwwSummaryData?.totalCost || 0;
    const totalExp = didCost + doMTDCost + supabaseEstCost;
    const finalProf = netProf - doMTDCost - supabaseEstCost;

    summaryIncome.innerText = `$${income.toFixed(2)}`;
    summaryExpenses.innerText = `$${totalExp.toFixed(2)}`;
    summaryProfit.innerText = `$${finalProf.toFixed(2)}`;
    summaryDIDWWCost.innerText = `DIDWW: $${didCost.toFixed(0)}`;
    summaryDOCost.innerText = `DO: $${doMTDCost.toFixed(0)}`;
    summarySupabaseCost.innerText = `Supa: $${supabaseEstCost.toFixed(0)}`;

    entries.slice(0, 100).forEach(([name, data]) => {
        const usage = voiceUsageData[name] || { minutes: 0, cost: 0 };
        const total = (data.count * price) + usage.cost;
        const isVip = name.toLowerCase().includes('voxflowpro') || name.toLowerCase().includes('1kpro');
        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800 hover:bg-gray-800/30 transition-colors';
        tr.innerHTML = `<td class="px-6 py-4 font-bold text-gray-200">${name}${isVip?' <span class="bg-blue-500/20 text-blue-400 px-1 rounded text-[10px]">VIP</span>':''}</td>
            <td class="px-6 py-4 text-gray-400">${data.count}</td><td class="px-6 py-4 text-gray-400">$${price.toFixed(2)}</td>
            <td class="px-6 py-4 text-xs font-mono text-gray-500">${usage.minutes.toFixed(0)}m</td>
            <td class="px-6 py-4 text-xs font-mono text-red-500">$${usage.cost.toFixed(2)}</td>
            <td class="px-6 py-4 font-bold text-blue-400">$${total.toFixed(2)}</td>
            <td class="px-6 py-4 text-right flex justify-end gap-2 text-[10px]">
                <div class="flex flex-col gap-1 items-end">
                    <button onclick="window.sendReminder('${name.replace(/'/g,"\\'")}', ${total})" class="text-gray-500 hover:text-white">Recordatorio</button>
                    <button onclick="window.showUsageDetail('${name.replace(/'/g,"\\'")}')" class="text-blue-400 hover:text-blue-300 font-bold uppercase">Uso CDR</button>
                </div>
                <button onclick="window.prepareInvoice('${name.replace(/'/g,"\\'")}', ${data.count}, ${price})" class="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-lg font-bold">Facturar</button>
            </td>`;
        billingTableBody.appendChild(tr);
    });
}

// --- Modals Logic (Global Window Scope) ---

window.showUsageDetail = (name) => {
    const u = voiceUsageData[name] || { minutes: 0, cost: 0, calls: 0 };
    usageClientName.innerText = name;
    usageTotalMinutes.innerText = u.minutes.toFixed(1);
    usageTotalCost.innerText = `$${u.cost.toFixed(2)}`;
    usageTotalCalls.innerText = u.calls;
    usageAvgCost.innerText = `$${u.minutes > 0 ? (u.cost / u.minutes).toFixed(4) : '0.0000'}`;
    usageModal.classList.remove('hidden');
};

window.prepareInvoice = (name, count, price) => {
    currentClient = name;
    modalClientName.innerText = name;
    modalInvoiceNumber.innerText = `FACT-${nextInvoiceNumber}`;
    currentInvoiceItems = [{ desc: `Cargos recurrentes por ${count} DIDs - Mes Actual`, qty: count, price: price }];
    if (name.toLowerCase().includes('voxflowpro') || name.toLowerCase().includes('1kpro')) {
        currentInvoiceItems.push({ desc: 'Mantenimiento y Soporte Técnico Pro', qty: 1, price: 300 });
    }
    renderInvoiceItems();
    invoiceModal.classList.remove('hidden');
};

function renderInvoiceItems() {
    invoiceItemsBody.innerHTML = ''; let sub = 0;
    currentInvoiceItems.forEach((itm, i) => {
        const tot = itm.qty * itm.price; sub += tot;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="py-2"><input type="text" value="${itm.desc}" onchange="window.updateItem(${i}, 'desc', this.value)" class="bg-transparent border-b border-gray-800 w-full outline-none"></td>
            <td class="py-2 text-center"><input type="number" value="${itm.qty}" onchange="window.updateItem(${i}, 'qty', this.value)" class="bg-gray-800 rounded w-12 text-center"></td>
            <td class="py-2 text-right"><input type="number" value="${itm.price}" step="0.01" onchange="window.updateItem(${i}, 'price', this.value)" class="bg-gray-800 rounded w-20 text-right"></td>
            <td class="py-2 text-right font-bold text-gray-400">$${tot.toFixed(2)}</td>`;
        invoiceItemsBody.appendChild(tr);
    });
    modalSubtotal.innerText = modalTotal.innerText = `$${sub.toFixed(2)}`;
}

window.updateItem = (i, f, v) => {
    if (f === 'qty' || f === 'price') currentInvoiceItems[i][f] = parseFloat(v) || 0;
    else currentInvoiceItems[i][f] = v;
    renderInvoiceItems();
};

window.sendReminder = (name, total) => {
    const msg = `Recordatorio Voxflow: El pago por $${total.toFixed(2)} USD se encuentra pendiente.`;
    navigator.clipboard.writeText(msg).then(() => alert("Texto de recordatorio copiado"));
};

// --- PDF & Relay ---

async function triggerBackendDownload(data, name) {
    const f = document.createElement('form'); f.method = 'POST'; f.action = '/api/v1/billing/download-relay';
    const iD = document.createElement('input'); iD.type = 'hidden'; iD.name = 'pdfData'; iD.value = data;
    const iN = document.createElement('input'); iN.type = 'hidden'; iN.name = 'fileName'; iN.value = name;
    f.append(iD, iN); document.body.appendChild(f); f.submit(); document.body.removeChild(f);
}

async function downloadPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFillColor(37, 99, 235); doc.rect(0, 0, 210, 15, 'F');
    doc.setFontSize(22); doc.setTextColor(37, 99, 235); doc.text('VOXFLOW LLC', 14, 30);
    doc.setFontSize(12); doc.setTextColor(30, 41, 59); doc.text(`FACTURA ${nextInvoiceNumber}`, 196, 30, { align: 'right' });
    doc.autoTable({ startY: 50, head: [['DESC','CANT','PRECIO','TOTAL']], body: currentInvoiceItems.map(it => [it.desc, it.qty, it.price, it.qty*it.price]) });
    await triggerBackendDownload(doc.output('datauristring'), `Factura_${currentClient.replace(/\s+/g,'_')}.pdf`);
    nextInvoiceNumber++; localStorage.setItem('nextInvoiceNumber', nextInvoiceNumber);
    invoiceModal.classList.add('hidden');
}

window.downloadReminderPDF = (name, total) => {
    const { jsPDF } = window.jspdf; const doc = new jsPDF();
    doc.text('RECORDATORIO DE PAGO', 14, 30); doc.text(name, 14, 40); doc.text(`PENDIENTE: $${total.toFixed(2)} USD`, 14, 60);
    triggerBackendDownload(doc.output('datauristring'), `Recordatorio_${name.replace(/\s+/g,'_')}.pdf`);
};

// --- UI Helpers ---

function setSyncStatus(isSync, txt) {
    syncText.innerText = txt;
    if (isSync) { syncDot.classList.add('animate-pulse','bg-yellow-500'); syncDot.classList.remove('bg-green-500'); }
    else { syncDot.classList.remove('animate-pulse','bg-yellow-500'); syncDot.classList.add('bg-green-500'); }
}

function renderInfrastructure() {
    dropletsContainer.innerHTML = doDroplets.map(d => `<div class="glass p-4 rounded-xl border border-gray-800"><p class="font-bold text-gray-200">${d.name}</p><p class="text-[10px] text-gray-500">${d.status} • $${d.size.price_monthly}/mo</p></div>`).join('') || 'No droplets.';
    supabaseContainer.innerHTML = supabaseProjects.map(p => `<div class="glass p-4 rounded-xl border border-gray-800"><p class="font-bold text-gray-200">${p.name}</p><p class="text-[10px] text-gray-500">${p.status}</p></div>`).join('') || 'No projects.';
}

// --- Global Listeners ---

tabInventory.onclick = () => switchTab('inventory');
tabBilling.onclick = () => switchTab('billing');
tabInfrastructure.onclick = () => switchTab('infrastructure');
globalUnitPriceInput.onchange = renderBillingTable;
searchInput.oninput = resetPaginationAndRender;
filterStatus.onchange = resetPaginationAndRender;
filterClient.onchange = resetPaginationAndRender;
breakdownDaysSelect.onchange = renderBreakdown;
btnExport.onclick = exportCsv;
btnPrev.onclick = () => { if (currentPage > 1) { currentPage--; renderTable(); window.scrollTo({top:0}); } };
btnNext.onclick = () => { currentPage++; renderTable(); window.scrollTo({top:0}); };
btnSyncFull.onclick = loadFullInventory;
closeModal.onclick = () => invoiceModal.classList.add('hidden');
closeUsageModal.onclick = () => usageModal.classList.add('hidden');
btnUsageOk.onclick = () => usageModal.classList.add('hidden');
btnDownloadPdf.onclick = downloadPDF;
btnAddItem.onclick = () => { currentInvoiceItems.push({ desc: 'Nuevo concepto...', qty: 1, price: 0 }); renderInvoiceItems(); };

init();
