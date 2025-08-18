import CONFIG from './config.js';

// ---------------------------
// Globals / diagnostics
// ---------------------------
const APP_TOKEN = CONFIG.APP_TOKEN;

window.API_DIAG = {
  tokenPresent: !!APP_TOKEN,
  origin: location.origin,
  last: null
};

// Patch fetch for Socrata (token + 429 backoff)
// Runs before any of our own fetches below.
(function patchFetchForSocrata(){
  const SOC_HOST = "data.cityofnewyork.us";
  const nativeFetch = window.fetch;

  window.fetch = function(input, init = {}){
    let url = "";
    try { url = typeof input === "string" ? input : input.url; } catch {}
    let retries = 0, rateLimited = false;

    // Inject token header for Socrata calls
    try {
      const u = new URL(url, location.origin);
      if (u.hostname.endsWith(SOC_HOST) && APP_TOKEN) {
        const headers = new Headers((init && init.headers) || {});
        if (!headers.has("X-App-Token")) headers.set("X-App-Token", APP_TOKEN);
        init = { ...init, headers };
      }
    } catch(e) { /* ignore */ }

    return nativeFetch(input, init).then(async res => {
      if (res.status !== 429) return record(res);

      // simple backoff for 429s
      rateLimited = true;
      let retryRes = res;
      while (retryRes.status === 429 && retries < 3){
        const ra = parseInt(retryRes.headers.get("Retry-After") || "2", 10);
        const waitMs = Math.max(ra * 1000, 1000 * (2 ** retries));
        await new Promise(r => setTimeout(r, waitMs));
        retryRes = await nativeFetch(input, init);
        retries++;
      }
      return record(retryRes);

      function record(finalRes){
        window.API_DIAG.last = {
          url, status: finalRes.status,
          tokenSent: !!APP_TOKEN,
          retries, rateLimited,
          time: new Date().toISOString()
        };
        window.dispatchEvent(new CustomEvent("soda:request", { detail: window.API_DIAG.last }));
        return finalRes;
      }
    });
  };
})();

// ---------------------------
// DOM helpers
// ---------------------------
const $ = (id) => document.getElementById(id);

// Initialize Diagnostics panel wiring
(function initDiagnosticsUI(){
  const panel = $('diag');
  const btn = $('toggleDiag');
  if (!panel || !btn) return;

  $('d-origin').textContent = window.API_DIAG.origin;
  $('d-token').textContent  = window.API_DIAG.tokenPresent ? 'Yes' : 'No';

  btn.addEventListener('click', () => {
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    btn.textContent = visible ? 'Show Diagnostics & Sources' : 'Hide Diagnostics & Sources';
  });

  window.addEventListener('soda:request', (ev) => {
    const d = ev.detail;
    $('d-url').textContent     = d.url || '';
    $('d-status').textContent  = String(d.status);
    $('d-rl').textContent      = d.rateLimited ? 'Yes' : 'No';
    $('d-retries').textContent = String(d.retries);
    $('d-time').textContent    = d.time;
  });
})();

// ---------------------------
// App constants / state
// ---------------------------
const apiUrl       = 'https://data.cityofnewyork.us/resource/muvi-b6kx.json';
const codeLookupUrl= 'https://data.cityofnewyork.us/resource/myn9-hwsy.json?$limit=1000';
const schemaUrl    = 'https://data.cityofnewyork.us/api/views/muvi-b6kx/columns.json';

let exemptionLookup   = {};
let fieldDescriptions = {};
let yearWithData      = {};
let cachedData        = [];
let currentParid      = '';
let currentYear       = new Date().getFullYear() + 1;
const minYear         = 2021;

// ---------------------------
// UI helpers
// ---------------------------
function showLoading() {
  $('loadingOverlay')?.classList.remove('d-none');
}
async function hideLoading() {
  await new Promise(r => setTimeout(r, 150));
  $('loadingOverlay')?.classList.add('d-none');
}

// Build the exact header text shown in CSV sources preview
function buildCsvHeaderPreview(parid) {
  const EXEMPTIONS_BASE = 'https://data.cityofnewyork.us/resource/muvi-b6kx';
  const PLUTO_BASE      = 'https://data.cityofnewyork.us/resource/64uk-42ks';

  const EXEMPTIONS_JSON_FILTERED = `${EXEMPTIONS_BASE}.json?parid=${encodeURIComponent(parid)}`;
  const PLUTO_JSON_FILTERED      = `${PLUTO_BASE}.json?bbl=${encodeURIComponent(parid)}`;

  return [
    'Compiled by TeamLalaCRE',
    'https://teamlalacre.com/abatements-exemptions',
    '',
    '- NYC Open Data Sources (official JSON):',
    '      Exemptions --- https://data.cityofnewyork.us/resource/muvi-b6kx',
    '      Exemption Code Lookup --- https://data.cityofnewyork.us/resource/myn9-hwsy.json',
    '      PLUTO --- https://data.cityofnewyork.us/resource/64uk-42ks',
    '',
    '- Sources Filtered By BBL (official JSON):',
    `      Exemptions --- ${EXEMPTIONS_JSON_FILTERED}`,
    `      PLUTO --- ${PLUTO_JSON_FILTERED}`,
  ].join('\n');
}
function updateDiagCsvHeader(parid) {
  const el = $('d-csv-header');
  if (!el) return;
  if (!parid || parid.length !== 10) {
    el.textContent = '!!! Run a search to see sources.';
    return;
  }
  el.textContent = buildCsvHeaderPreview(parid);
}
window.addEventListener('soda:request', () => {
  const p = (window.currentParid || $('parid')?.value || '').trim();
  updateDiagCsvHeader(p);
});

// ---------------------------
// Lookups
// ---------------------------
async function loadLookup() {
  const res = await fetch(codeLookupUrl);
  const arr = await res.json();
  arr.forEach(r => {
    exemptionLookup[r.exempt_code] = r.description;
    exemptionLookup[r.column_id]   = r.long_description;
  });
}
async function loadSchema() {
  const res = await fetch(schemaUrl);
  if (res.ok) {
    const data = await res.json();
    data.forEach(col => {
      if (col.fieldName && col.description) {
        fieldDescriptions[col.fieldName] = col.description;
      }
    });
  }
}
async function ensureLookups() {
  if (!Object.keys(exemptionLookup).length)   await loadLookup();
  if (!Object.keys(fieldDescriptions).length) await loadSchema();
}

// ---------------------------
// Core logic
// ---------------------------
function constructParid(boro, block, lot) {
  return `${boro.padStart(1, '0')}${block.padStart(5, '0')}${lot.padStart(4, '0')}`;
}

async function checkYearDataAvailability(parid) {
  yearWithData = {};
  for (let y = currentYear; y >= minYear; y--) {
    const query = `${apiUrl}?$where=year='${y}' AND parid='${parid}'&$limit=1`;
    const res = await fetch(query);
    if (res.ok) {
      const d = await res.json();
      yearWithData[y] = d.length > 0;
      await new Promise(res => setTimeout(res, 75));
    }
  }
}

async function lookupAllYears({ parid }) {
  const query = `${apiUrl}?$where=parid='${parid}'&$limit=5000`;
  const res = await fetch(query);
  cachedData = res.ok ? await res.json() : [];

  // Mark available years for ✔️ indicators
  yearWithData = {};
  cachedData.forEach(row => {
    if (row.year) yearWithData[row.year] = true;
  });

  renderYearButtons('all');

  if (!cachedData.length) {
    $('summary').innerText = 'No exemption records found for any year.';
    $('results').innerHTML = '';
  } else {
    renderData(cachedData, 'All Years');
    $('action-buttons').classList.remove('d-none');
  }
  await loadPlutoData(parid);
}

async function lookupYear(year) {
  const parid = $('parid').value.trim();
  if (!parid) return alert('Missing Parcel ID');

  const data = cachedData.filter(row => String(row.year) === String(year));

  currentYear = year;
  renderYearButtons(year);

  if (!data.length) {
    $('summary').innerText = `No exemption records found for ${year}.`;
    $('results').innerHTML = '';
  } else {
    renderData(data, year);
    $('action-buttons').classList.remove('d-none');
  }
}

// PLUTO details
async function loadPlutoData(parid) {
  const boroCode = parid?.charAt(0);
  const blockStr = parid?.slice(1, 6);
  const lotStr   = parid?.slice(6);
  const blockNum = Number(blockStr);
  const lotNum   = Number(lotStr);

  const BORO_ABBR = { "1":"MN", "2":"BX", "3":"BK", "4":"QN", "5":"SI" };

  // Try #1: numeric bbl comparison
  let url = `https://data.cityofnewyork.us/resource/64uk-42ks.json?$where=bbl=${Number(parid)}&$limit=1`;
  let res = await fetch(url);
  let rows = res.ok ? await res.json() : [];

  // Try #2: block+lot(+borough)
  if (!rows || rows.length === 0) {
    const boroughAbbr = BORO_ABBR[boroCode] || "";
    const whereParts = [
      Number.isFinite(blockNum) ? `block=${blockNum}` : null,
      Number.isFinite(lotNum)   ? `lot=${lotNum}`     : null,
      boroughAbbr ? `borough='${boroughAbbr}'` : null
    ].filter(Boolean).join(" AND ");

    url = `https://data.cityofnewyork.us/resource/64uk-42ks.json?$where=${encodeURIComponent(whereParts)}&$limit=1`;
    res = await fetch(url);
    rows = res.ok ? await res.json() : [];
  }

  if (!rows || rows.length === 0) {
    $('property-details').innerHTML = `<div class="small text-muted">PLUTO data not found for BBL ${parid}.</div>`;
    console.warn("PLUTO lookup returned no rows. Last URL tried:", url);
    return;
  }

  const d = rows[0];
  const n   = v => (v == null || v === '') ? 'N/A' : v;
  const num = v => (v == null || v === '' ? 'N/A' : Number(v).toLocaleString());
  const yes = v => v ? 'Yes' : 'No';

  const z  = [d.zonedist1, d.zonedist2, d.zonedist3, d.zonedist4].filter(Boolean).join(', ');
  const ov = [d.overlay1,  d.overlay2].filter(Boolean).join(', ');
  const sp = [d.spdist1,   d.spdist2,  d.spdist3].filter(Boolean).join(', ');

  const zola = `https://zola.planning.nyc.gov/bbl/${parid}`;

  $('property-details').innerHTML = `
    <h5 class="mb-2">Property Details (PLUTO)</h5>
    <div class="row row-cols-1 row-cols-md-2 g-2 small">
      <div><strong>Address:</strong> ${n(d.address)}</div>
      <div><strong>BBL:</strong> ${parid}
           <span class="text-muted"> (Boro ${boroCode} • Block ${n(d.block)} • Lot ${n(d.lot)})</span></div>

      <div><strong>Bldg Class:</strong> ${n(d.bldgclass)}</div>
      <div><strong>Land Use:</strong> ${n(d.landuse)}</div>

      <div><strong>Lot Area:</strong> ${num(d.lotarea)} sq ft</div>
      <div><strong>Building Area:</strong> ${num(d.bldgarea)} sq ft</div>

      <div><strong>Total Units:</strong> ${n(d.unitstotal)}</div>
      <div><strong>Floors:</strong> ${n(d.numfloors)}</div>

      <div><strong>Year Built:</strong> ${n(d.yearbuilt)}</div>
      <div><strong>Corner Lot:</strong> ${yes(d.cornerlot === 'Y')}</div>

      ${z  ? `<div><strong>Zoning District(s):</strong> ${z}</div>` : ''}
      ${ov ? `<div><strong>Overlay(s):</strong> ${ov}</div>` : ''}
      ${sp ? `<div><strong>Special District(s):</strong> ${sp}</div>` : ''}
      <div><a href="${zola}" target="_blank" rel="noopener">Open in ZOLA</a></div>
    </div>
  `;
}

// Year selector
function renderYearButtons(selectedYear) {
  let html = 'Jump to year: <select id="yearSelect">';
  html += `<option value="all"${selectedYear === 'all' ? ' selected' : ''}>All Years</option>`;

  for (let y = currentYear; y >= minYear; y--) {
    const hasData = yearWithData[y];
    html += `<option value="${y}" ${selectedYear === y ? 'selected' : ''}>${y}${hasData ? ' ✔️' : ''}</option>`;
  }

  html += '</select>';
  $('year-nav').innerHTML = html;

  $('yearSelect').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (value === 'all') {
      const parid = $('parid').value.trim();
      if (!parid) return alert('Missing Parcel ID');
      await lookupAllYears({ parid });
    } else {
      await lookupYear(parseInt(value, 10));
    }
  });
}

// Results render
function renderData(data, year) {
  data.sort((a, b) => {
    const yearDiff = Number(b.year || 0) - Number(a.year || 0);
    if (yearDiff !== 0) return yearDiff;
    return Number(b.period || 0) - Number(a.period || 0);
  });

  const yearText = year === 'All Years'
    ? `${minYear} – ${new Date().getFullYear() + 1}`
    : year;
  const plural = year === 'All Years' ? 'years' : 'year';

  const now = new Date();
  const timestamp = now.toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  $('summary').innerHTML = `
    <strong>Found ${data.length} record(s) for assessment ${plural} ${yearText}.</strong><br>
    <p class="small text-muted">Searched on ${timestamp}</p>
    <p class="small text-muted d-print-none">*CSV export includes all exemption records across available years. Columns include both raw data fields and readable&nbsp;headers.</p>
  `;

  const fields  = ['year', 'period', 'baseyr', 'benftstart', 'no_years', 'exmp_code'];
  const headers = ['Tax Year', 'Period', 'Base Year', 'Benefit Start', '# Of Years', 'Exemption Type'];

  const headerCells = headers.map(h => `<th>${h}</th>`).join('');
  let html = `<div class="table-responsive"><table class="table table-sm" id="resultsTable"><thead><tr>${headerCells}</tr></thead><tbody>`;

  data.forEach(row => {
    html += '<tr>' + fields.map((f,i) => {
      let val = row[f] || '';

      if (f === 'exmp_code') {
       const code = String(row[f] || '');
       const desc = exemptionLookup[code];
       const combined = desc ? `${code} – ${desc}` : code;
       return `<td data-label="${headers[i]}">${combined}</td>`;
      }

      if (f === 'period') {
        const disp = val === '1' ? '1 – Tentative' : val === '3' ? '3 – Final' : val;
        const color = val === '1' ? 'orange' : val === '3' ? 'green' : 'inherit';
        return `<td data-label="${headers[i]}" style="color:${color}; font-weight:bold">${disp}</td>`;
      }

      return `<td data-label="${headers[i]}">${val}</td>`;
    }).join('') + '</tr>';
  });

  html += '</tbody></table></div>';
  $('results').innerHTML = html;

  // Copy link
  $('share').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      const statusBox = $('share-banner');
      statusBox.textContent = 'Link copied!';
      statusBox.classList.remove('d-none');
      setTimeout(() => {
        statusBox.classList.add('d-none');
        statusBox.textContent = '';
      }, 3000);
    }).catch(() => {
      const statusBox = $('share-banner');
      statusBox.textContent = 'Failed to copy';
      statusBox.classList.remove('d-none');
      statusBox.classList.replace('alert-success', 'alert-danger');
      setTimeout(() => {
        statusBox.classList.add('d-none');
        statusBox.textContent = '';
        statusBox.classList.replace('alert-danger', 'alert-success');
      }, 3000);
    });
  });

  $('print-url').textContent = location.href;
}

// CSV download
async function handleDownloadCsv() {
  const parid = currentParid;
  const now = new Date();
  if (!parid || parid.length !== 10) return alert('Missing or invalid Parcel ID');

  const EXEMPTIONS_BASE = 'https://data.cityofnewyork.us/resource/muvi-b6kx';
  const PLUTO_BASE      = 'https://data.cityofnewyork.us/resource/64uk-42ks';

  const EXEMPTIONS_JSON_FILTERED = `${EXEMPTIONS_BASE}.json?parid=${encodeURIComponent(parid)}`;
  const PLUTO_JSON_FILTERED      = `${PLUTO_BASE}.json?bbl=${encodeURIComponent(parid)}`;

  let allRows = [];
  for (let y = new Date().getFullYear() + 1; y >= minYear; y--) {
    const resp = await fetch(`${apiUrl}?$where=year='${y}' AND parid='${parid}'&$limit=1000`);
    if (resp.ok) {
      const rows = await resp.json();
      allRows = allRows.concat(rows);
      await new Promise(res => setTimeout(res, 100));
    }
  }
  if (!allRows.length) return alert('No data to export');

  const fieldNames   = [...new Set(allRows.flatMap(r => Object.keys(r)))];
  const escapeCsv    = s => `"${String(s).replace(/"/g, '""')}"`;
  const rawHeaders   = fieldNames.map(f => escapeCsv(f));
  const humanHeaders = fieldNames.map(f =>
    escapeCsv(fieldDescriptions[f] || f.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))
  );

  let csv = [
    'Compiled by TeamLalaCRE',
    'https://teamlalacre.com/abatements-exemptions',
    '',
    '- NYC Open Data Sources (official JSON):',
    '      Exemptions --- https://data.cityofnewyork.us/resource/muvi-b6kx',
    '      Exemption Code Lookup --- https://data.cityofnewyork.us/resource/myn9-hwsy.json',
    '      PLUTO --- https://data.cityofnewyork.us/resource/64uk-42ks',
    '',
    '- Sources Filtered By BBL (official JSON):',
    `      Exemptions --- ${EXEMPTIONS_JSON_FILTERED}`,
    `      PLUTO --- ${PLUTO_JSON_FILTERED}`,
    '',
    `- Downloaded: ${now.toISOString()}`,
    '',
    rawHeaders.join(','),
    humanHeaders.join(','),
    ''
  ].join('\n');

  for (const row of allRows) {
    const rowData = fieldNames.map(f => escapeCsv(row[f] ?? ''));
    csv += '\n' + rowData.join(',');
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const timestamp = now.toISOString().replace(/[:\-T]/g, '').slice(0, 15);
  a.download = `exemption_data_${parid}_${timestamp}.csv`;
  a.click();
}

// URL params
function updateURLParams({ parid }) {
  const params = new URLSearchParams();
  if (parid) params.set('parid', parid);
  history.replaceState({}, '', `${location.pathname}?${params}`);
}

// Reset
function resetForm() {
  $('input-form').style.display = 'block';
  $('summary').innerHTML = '';
  $('results').innerHTML = '';
  $('year-nav').innerHTML = '';
  $('action-buttons').classList.add('d-none');
}

// ---------------------------
// Event wiring (after DOM is parsed)
// ---------------------------
document.addEventListener('DOMContentLoaded', () => {
  // New Search / Print / CSV buttons (removed inline handlers)
  $('newSearchBtn')?.addEventListener('click', resetForm);
  $('printBtn')?.addEventListener('click', () => window.print());
  $('downloadCsv')?.addEventListener('click', handleDownloadCsv);

  // Search by BBL
  $('searchBBL')?.addEventListener('click', async () => {
    const boro  = $('borough').value;
    const block = $('block').value.trim();
    const lot   = $('lot').value.trim();
    if (!boro || !block || !lot) return alert('Missing BBL');

    const parid = constructParid(boro, block, lot);
    currentParid = parid; window.currentParid = parid;
    $('parid').value = parid;
    updateDiagCsvHeader(parid);

    showLoading();
    try {
      currentYear = new Date().getFullYear() + 1;
      await ensureLookups();
      updateURLParams({ parid });
      await checkYearDataAvailability(parid);
      await lookupAllYears({ parid });
      $('input-form').style.display = 'none';
      $('action-buttons').classList.remove('d-none');
    } finally {
      hideLoading();
    }
  });

  // Search by PARID directly
  $('searchParid')?.addEventListener('click', async () => {
    const parid = $('parid').value.trim();
    currentParid = parid; window.currentParid = parid;
    if (!parid || parid.length !== 10) return alert('Please enter a valid 10-digit Parcel ID.');
    $('parid').value = parid;
    updateDiagCsvHeader(parid);

    showLoading();
    try {
      currentYear = new Date().getFullYear() + 1;
      await ensureLookups();
      updateURLParams({ parid });
      await checkYearDataAvailability(parid);
      await lookupAllYears({ parid });
      $('input-form').style.display = 'none';
      $('action-buttons').classList.remove('d-none');
    } finally {
      hideLoading();
    }
  });

  // Deep link ?parid=...
  const params = new URLSearchParams(location.search);
  const parid = params.get('parid');
  if (parid) {
    showLoading();
    (async () => {
      try {
        await ensureLookups();
        $('parid').value = parid;
        updateDiagCsvHeader(parid);
        currentParid = parid; window.currentParid = parid;
        await checkYearDataAvailability(parid);
        await lookupAllYears({ parid });
        $('input-form').style.display = 'none';
        $('action-buttons').classList.remove('d-none');
      } finally {
        hideLoading();
      }
    })();
  }
});
