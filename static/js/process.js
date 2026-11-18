/**
 * BOM Matcher - Process Page JavaScript
 * One table per BOM line: customer BOM columns, the ERP match and the parameter indicators,
 * with auto-fit zoom, MPN/parameter highlights, MPNfree selection and Copy/Delete modes.
 * Clicking a line opens a panel directly under it (design mt-01d): the current match with
 * Remove match / Accept suggestion, the candidates with Use, and a manual ERP search.
 */

let bomData = null;
let matchResults = {};
let mpnfreeResults = {};
let selections = {};
let selectedRow = null;
let copyMode = false;
let deleteMode = false;
let deletedRows = new Set();
let statusFilter = 'all';

// Previous-version (Exact) BOM, keyed by FaberNr → full old-BOM line.
// Drives the green "on old BOM" checkmark and its hover tooltip.
let previousBomByFaberNr = new Map();

/**
 * Get a mapped value from a row, supporting multi-column mappings.
 * When mapping is an array of column names, values are joined with a space.
 */
function getMappedValue(row, mappingValue) {
    if (!mappingValue) return '';
    if (Array.isArray(mappingValue)) {
        return mappingValue.map(c => String(row[c] || '').trim()).filter(v => v).join(' ');
    }
    return String(row[mappingValue] || '');
}

// Column order for the customer BOM part of the table
const leftColumns = ['Description', 'MPN', 'Manufacturer', 'Quantity', 'Refdes'];
const leftColumnLabels = { Description: 'Description', MPN: 'MPN', Manufacturer: 'Manufacturer', Quantity: 'Qty', Refdes: 'Refdes' };

// ERP match columns (13) and parameter columns (5)
const ERP_COLUMN_COUNT = 13;
const PARAM_COLUMN_COUNT = 5;

// ========================================================================
// UI State Persistence (sessionStorage for client-only state)
// ========================================================================

function saveUiState() {
    try {
        sessionStorage.setItem('processUiState', JSON.stringify({
            deletedRows: Array.from(deletedRows),
            selectedRow: selectedRow,
        }));
    } catch (e) { /* ignore */ }
}

function restoreUiState() {
    try {
        const raw = sessionStorage.getItem('processUiState');
        if (!raw) return;
        const state = JSON.parse(raw);
        if (state.deletedRows) deletedRows = new Set(state.deletedRows);
        if (state.selectedRow !== null && state.selectedRow !== undefined) selectedRow = state.selectedRow;
    } catch (e) { /* ignore */ }
}

// ========================================================================
// Page Init
// ========================================================================

async function loadBomData() {
    showLoading();
    try {
        // Parameter settings (package aliases/tags) load alongside, so the first render has the indicators
        const paramSettings = (typeof ensureParamSettings === 'function') ? ensureParamSettings() : Promise.resolve();
        const data = await apiCall('/api/bom-data');
        bomData = data;

        // Load the previous-version (Exact) BOM for the green-checkmark feature
        await loadPreviousBom();
        await paramSettings;

        // Restore server-side state (matches, mpnfree, selections)
        if (data.matches && Object.keys(data.matches).length > 0) {
            matchResults = data.matches;
        }
        if (data.mpnfree && Object.keys(data.mpnfree).length > 0) {
            mpnfreeResults = data.mpnfree;
        }
        if (data.selections && Object.keys(data.selections).length > 0) {
            selections = data.selections;
        }

        // Clear stale client-side state if the BOM has changed
        const prevBomName = sessionStorage.getItem('processBomName');
        const currentBomName = data.name || '';
        if (prevBomName !== currentBomName) {
            sessionStorage.removeItem('processUiState');
        }
        sessionStorage.setItem('processBomName', currentBomName);

        // Restore client-only UI state from sessionStorage
        restoreUiState();

        renderHeader(data);
        renderTables();

        // In previous-BOM mode, run the match automatically when none exists yet
        // (pressing "Process BOM" is expected to match against the old BOM right away).
        if (previousBomMode() && Object.keys(matchResults).length === 0 &&
            bomData && (bomData.total_rows || 0) > 0) {
            await findIpn();
        }
    } catch (e) {
        toast.error('Failed to load BOM data. Go back and upload a file.');
    } finally {
        hideLoading();
    }
}

/** File name as the page title, the customer as a gold pill (only when one is set). */
function renderHeader(data) {
    const name = data.name || 'Untitled';
    const title = document.getElementById('bomName');
    title.textContent = name;
    title.title = `${name} · ${data.total_rows || 0} rows`;

    const pill = document.getElementById('klantPill');
    const klantNr = String(data.klant_nr || '').trim();
    if (pill) {
        pill.textContent = klantNr ? `Klant ${klantNr}` : '';
        pill.hidden = !klantNr;
    }
}

// ========================================================================
// Previous-version (Exact) BOM — green checkmark + hover tooltip
// ========================================================================

async function loadPreviousBom() {
    previousBomByFaberNr = new Map();
    try {
        const data = await apiCall('/api/exact/previous-bom', { method: 'GET' });
        for (const comp of (data.components || [])) {
            const fn = String(comp.FaberNr || '').trim();
            if (fn) previousBomByFaberNr.set(fn, comp);
        }
    } catch (e) {
        // No previous BOM loaded — checkmarks simply won't appear.
    }
}

function isOnPreviousBom(fabernr) {
    if (!fabernr || previousBomByFaberNr.size === 0) return false;
    return previousBomByFaberNr.has(String(fabernr).trim());
}

/** Return a green checkmark badge (with hover handlers) when the FaberNr is on the old BOM. */
function renderPreviousBomCheck(fabernr) {
    if (!isOnPreviousBom(fabernr)) return '';
    const fn = escapeHtml(String(fabernr).trim());
    return ` <span class="prevbom-check" data-fabernr="${fn}" ` +
        `onmouseenter="showPrevBomTooltip(this)" onmouseleave="hidePrevBomTooltip()" ` +
        `title="On previous BOM">✓</span>`;
}

function _getPrevBomTooltipEl() {
    let el = document.getElementById('prevBomTooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'prevBomTooltip';
        el.className = 'prevbom-tooltip';
        el.style.display = 'none';
        document.body.appendChild(el);
    }
    return el;
}

function showPrevBomTooltip(badge) {
    const fabernr = badge.getAttribute('data-fabernr');
    const comp = previousBomByFaberNr.get(String(fabernr).trim());
    if (!comp) return;

    const fields = [
        ['FaberNr', comp.FaberNr],
        ['Description', comp.Description],
        ['Manufacturer', comp.Manufacturer],
        ['MPN', comp.MPN],
        ['Quantity', comp.Quantity],
        ['Mounting', comp.Mounting],
        ['Refdes', comp.Refdes],
    ];
    let rows = fields.map(([label, val]) =>
        `<tr><td class="prevbom-tooltip-label">${escapeHtml(label)}</td>` +
        `<td>${escapeHtml(String(val == null ? '' : val))}</td></tr>`
    ).join('');

    const el = _getPrevBomTooltipEl();
    el.innerHTML = `<div class="prevbom-tooltip-title">On previous BOM</div>` +
        `<table class="prevbom-tooltip-table">${rows}</table>`;
    el.style.display = 'block';

    // Position near the badge, kept within the viewport.
    const rect = badge.getBoundingClientRect();
    const ttRect = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + ttRect.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - ttRect.width - 8);
    }
    if (top + ttRect.height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - ttRect.height - 6);
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
}

function hidePrevBomTooltip() {
    const el = document.getElementById('prevBomTooltip');
    if (el) el.style.display = 'none';
}

// ========================================================================
// Scroll position (one scroll container: the white sheet)
// ========================================================================

// Capture the current scroll position BEFORE an async action so it can be restored after
// renderTables() rebuilds the DOM (the rebuild + select focus change otherwise jumps scroll).
function captureScroll() {
    const sheet = document.getElementById('matchSheet');
    return sheet ? { top: sheet.scrollTop, left: sheet.scrollLeft } : null;
}

function restoreScroll(saved) {
    if (!saved) return;
    // rAF so we restore after the re-render and the auto-fit have settled.
    requestAnimationFrame(() => {
        const sheet = document.getElementById('matchSheet');
        if (sheet) { sheet.scrollTop = saved.top; sheet.scrollLeft = saved.left; }
    });
}

// ========================================================================
// Auto-fit zoom: measure at 100%, zoom = available / needed, never below 60%.
// Column widths: every column starts at its natural width (as wide as its content); the user
// can drag a column narrower or wider (the right border of its header). A narrower column cuts
// its text with "..." (full text on hover), so the table needs less room and zooms out less.
// Widths are kept per browser (localStorage); a double click on a border resets that column.
// ========================================================================

const MIN_TABLE_ZOOM = 0.6;
let currentTableZoom = 1;

const COLUMN_WIDTHS_KEY = 'bomMatcher.columnWidths.v2';
const MIN_COLUMN_WIDTH = 24;

function loadColumnWidths() {
    try {
        const parsed = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

let userColumnWidths = loadColumnWidths();

/**
 * Only the columns the user sized cut their text with "..." (and their .clip spans fill the
 * column). The other columns render exactly as in the natural layout: zoomed-out text is a
 * hair wider than at 100%, so cutting those would eat the last letter of a column that fits.
 */
function setCutColumns(positions) {
    let style = document.getElementById('cutColumnsStyle');
    if (!style) {
        style = document.createElement('style');
        style.id = 'cutColumnsStyle';
        document.head.appendChild(style);
    }
    style.textContent = positions.map(n =>
        `#matchTable.fixed-cols thead tr.cols th:nth-child(${n}), #matchTable.fixed-cols tr[data-row] > td:nth-child(${n})` +
        ` { overflow: hidden; text-overflow: ellipsis; }` +
        ` #matchTable.fixed-cols tr[data-row] > td:nth-child(${n}) .clip { max-width: none; }`
    ).join('\n');
}

function saveColumnWidths() {
    try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(userColumnWidths)); } catch (e) { /* ignore */ }
}

function userWidth(key) {
    const w = userColumnWidths[key];
    return (typeof w === 'number' && w >= MIN_COLUMN_WIDTH) ? w : null;
}

/**
 * At zoom 100%: without user widths the table lays itself out (natural widths). With user
 * widths, measure the natural width of every column, take the user's width where set, and fix
 * them in the <colgroup> (table-layout: fixed). Returns the table width, or null when natural.
 */
function applyColumnWidths(table) {
    const cols = Array.from(document.querySelectorAll('#matchCols col'));
    table.classList.remove('fixed-cols');
    cols.forEach(c => { c.style.width = ''; });
    table.style.width = 'auto';
    setCutColumns(cols.map((c, k) => (userWidth(c.dataset.col) ? k + 1 : 0)).filter(Boolean));
    if (!cols.some(c => userWidth(c.dataset.col))) return null;

    const ths = Array.from(document.querySelectorAll('#matchTableHead tr.cols th'));
    if (ths.length !== cols.length) return null;
    const widths = ths.map((th, k) => userWidth(cols[k].dataset.col) || Math.ceil(th.getBoundingClientRect().width));
    cols.forEach((c, k) => { c.style.width = widths[k] + 'px'; });
    table.classList.add('fixed-cols');
    const total = widths.reduce((a, b) => a + b, 0);
    table.style.width = total + 'px';
    return total;
}

function fitMatchTable() {
    const sheet = document.getElementById('matchSheet');
    const table = document.getElementById('matchTable');
    if (!sheet || !table) return;
    const keepTop = sheet.scrollTop;
    const keepLeft = sheet.scrollLeft;

    // The open row panel must not take part in the measurement
    const panelBox = table.querySelector('.xpanel');
    if (panelBox) panelBox.style.display = 'none';

    table.style.zoom = 1;
    const fixedWidth = applyColumnWidths(table);
    const needed = fixedWidth || table.offsetWidth;
    const available = sheet.clientWidth;
    if (!needed || !available || needed <= available) {
        table.style.width = '100%';
        currentTableZoom = 1;
    } else {
        let z = Math.max(MIN_TABLE_ZOOM, available / needed);
        table.style.width = needed + 'px';
        table.style.zoom = z.toFixed(3);
        // Small text does not scale exactly with zoom: shrink a little more until the table really fits.
        for (let i = 0; i < 4 && z > MIN_TABLE_ZOOM; i++) {
            const w = table.getBoundingClientRect().width;
            if (w <= available + 0.5) break;
            z = Math.max(MIN_TABLE_ZOOM, z * available / w - 0.002);
            table.style.zoom = z.toFixed(3);
        }
        currentTableZoom = z;
    }
    if (panelBox) panelBox.style.display = '';
    sizePanel();
    sheet.scrollTop = keepTop;
    sheet.scrollLeft = keepLeft;
}

/** The open row panel: the visible width of the sheet, sticky left, text back at 100%. */
function sizePanel() {
    const sheet = document.getElementById('matchSheet');
    const box = sheet && sheet.querySelector('.xpanel');
    if (!box) return;
    const td = box.closest('td');
    box.style.zoom = (1 / (currentTableZoom || 1)).toFixed(4);
    const visible = Math.min(sheet.clientWidth, td.getBoundingClientRect().width);
    box.style.width = Math.max(600, Math.floor(visible) - 1) + 'px';
}

let _fitFrame = 0;
function scheduleFit() {
    cancelAnimationFrame(_fitFrame);
    _fitFrame = requestAnimationFrame(fitMatchTable);
}

window.addEventListener('resize', scheduleFit);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);

// ========================================================================
// Cell formatting (house style: numbers right in mono, Dutch notation, — for missing)
// ========================================================================

const NIL = '<span class="nil">—</span>';

function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === '';
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
}

const _nlQty = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 });
const _nlPrice = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function fmtQty(n) { return _nlQty.format(n); }

function textCell(value, clipClass) {
    if (isBlank(value)) return `<td>${NIL}</td>`;
    const v = escapeHtml(value);
    if (clipClass) return `<td><span class="clip ${clipClass}" title="${v}">${v}</span></td>`;
    return `<td title="${v}">${v}</td>`;
}

function monoCell(value) {
    if (isBlank(value)) return `<td>${NIL}</td>`;
    return `<td class="fx-mono" title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
}

function numCell(value) {
    const n = toNumber(value);
    if (n === null) return `<td class="fx-num">${NIL}</td>`;
    return `<td class="fx-num fx-mono">${fmtQty(n)}</td>`;
}

/** Kostprijs as '€ 0,0000'; it comes in as 0 when Exact has no cost price, so 0 shows as missing. */
function priceHtml(value) {
    const n = toNumber(value);
    if (n === null || n === 0) return NIL;
    return `€ ${_nlPrice.format(n)}`;
}

function priceCell(value) {
    const html = priceHtml(value);
    return html === NIL ? `<td class="fx-num">${NIL}</td>` : `<td class="fx-num fx-mono">${html}</td>`;
}

/** Voorraad: Dutch notation, a red badge when out of stock. */
function stockHtml(value) {
    const n = toNumber(value);
    if (n === null) return NIL;
    if (n <= 0) return `<span class="fx-badge fx-badge-danger fx-badge-mono" title="Out of stock">✖ ${fmtQty(n)}</span>`;
    return fmtQty(n);
}

function stockCell(value) {
    const n = toNumber(value);
    const html = stockHtml(value);
    return (n === null || n <= 0) ? `<td class="fx-num">${html}</td>` : `<td class="fx-num fx-mono">${html}</td>`;
}

const MOUNTING_TONES = { SMD: 'sky', HAND: 'gold', PHM: 'slate', PCB: 'steel' };

function mountingBadge(value) {
    if (isBlank(value)) return NIL;
    const tone = MOUNTING_TONES[String(value).trim().toUpperCase()] || 'neutral';
    return `<span class="fx-badge fx-badge-${tone}">${escapeHtml(value)}</span>`;
}

function mountingCell(value) {
    return `<td>${mountingBadge(value)}</td>`;
}

function erpStatusBadge(value) {
    if (isBlank(value)) return NIL;
    const s = String(value).trim();
    const lower = s.toLowerCase();
    if (lower === 'actief') return `<span class="fx-badge fx-badge-success">✓ ${escapeHtml(s)}</span>`;
    if (lower === 'vervallen' || lower === 'geblokkeerd' || lower === 'blocked') {
        return `<span class="fx-badge fx-badge-danger">✖ ${escapeHtml(s)}</span>`;
    }
    return `<span class="fx-badge fx-badge-neutral">${escapeHtml(s)}</span>`;
}

function erpStatusCell(value) {
    return `<td>${erpStatusBadge(value)}</td>`;
}

const SEARCH_METHOD_LABELS = {
    mpn: 'MPN',
    ipn_verify: 'IPN',
    description: 'Description',
    parameterized: 'Parameters',
    previous_mpn: 'Previous BOM, MPN',
    previous_param: 'Previous BOM, parameters',
    previous_none: 'Previous BOM',
    skipped: 'Skipped',
    error: 'Error',
};

/** The status badge of a line: ✓ Matched / ⚠ Partial / ✖ No match / ✕ Deleted, or '' when not matched yet. */
function statusBadge(state) {
    const parts = [];
    if (state.sel.fabernr) {
        parts.push('Selected by hand');
    } else if (state.match) {
        parts.push(SEARCH_METHOD_LABELS[state.match.search_method] || state.match.search_method || 'No search');
        const shown = state.displayItem || state.suggestion;
        const score = shown ? shown._similarity_score : undefined;
        if (score !== undefined && score !== null) parts.push(`${Math.round(score)}%`);
        if (!state.displayItem && state.suggestion) parts.push('suggestion only, click the line to see it');
    }
    const tip = escapeHtml(parts.join(' · '));
    switch (state.status) {
        case 'deleted':
            return `<span class="fx-badge fx-badge-slate row-status" title="Match removed">✕ Deleted</span>`;
        case 'matched':
            return `<span class="fx-badge fx-badge-success row-status" title="${tip}">✓ Matched</span>`;
        case 'partial':
            return `<span class="fx-badge fx-badge-warning row-status" title="${tip}">⚠ Partial</span>`;
        case 'nomatch':
            return `<span class="fx-badge fx-badge-danger row-status" title="${tip}">✖ No match</span>`;
        default:
            return '';
    }
}

function rowStatusCell(state) {
    const badge = statusBadge(state);
    return badge ? `<td class="pin2">${badge}</td>` : `<td class="pin2" title="Not matched yet">${NIL}</td>`;
}

// ========================================================================
// Match state per line
// ========================================================================

/** The match, the assigned FaberNr, the item to show and the line status for one BOM row. */
function getRowState(rowIndex) {
    const strIdx = String(rowIndex);
    const match = matchResults[strIdx];
    const sel = selections[strIdx] || {};

    // Determine match state
    let fabernr = '';
    let confidence = 'none';
    let searchMethod = '';
    if (sel.fabernr) {
        fabernr = sel.fabernr;
        confidence = 'high';
    } else if (match && match.auto_selected) {
        fabernr = match.auto_selected.FaberNr || '';
        confidence = match.confidence || 'none';
        searchMethod = match.search_method || '';
    } else if (match && match.display_suggestion) {
        // Partial match: show suggestion but don't assign fabernr
        confidence = match.confidence || 'none';
        searchMethod = match.search_method || '';
    }

    // The assigned article shown in the row: the one picked by hand, or the one Find IPN assigned.
    // A suggestion (display_suggestion, e.g. another MPN) is not linked: the row stays empty and
    // the suggestion only shows in the row panel, with Accept suggestion.
    let displayItem = null;
    if (sel.fabernr && match && match.suggestions) {
        displayItem = match.suggestions.find(s => s.FaberNr === sel.fabernr) || null;
    }
    if (!displayItem && match && match.auto_selected) {
        displayItem = match.auto_selected;
    }
    const suggestion = (!fabernr && match && match.display_suggestion) || null;

    // Matched / Partial only when a part is linked; a suggestion alone is No match (it shows in
    // the row panel only)
    let status = '';
    if (deletedRows.has(rowIndex)) {
        status = 'deleted';
    } else if (fabernr && confidence === 'high') {
        status = 'matched';
    } else if (fabernr && (confidence === 'medium' || confidence === 'low')) {
        status = 'partial';
    } else if (match) {
        status = 'nomatch';
    }

    return { match, sel, fabernr, confidence, searchMethod, displayItem, suggestion, status };
}

// ========================================================================
// Render the table
// ========================================================================

function getMappedColumns() {
    const mapping = (bomData && bomData.column_mapping) || {};
    const mappedCols = [];
    for (const stdCol of leftColumns) {
        const actualCol = mapping[stdCol];
        if (actualCol) {
            mappedCols.push({ std: stdCol, actual: actualCol });
        }
    }
    return mappedCols;
}

// ERP match and parameter columns: key (for the width), label, header class, header title
const ERP_COLUMNS = [
    ['e:FaberNr', 'FaberNr', 'g-start'], ['e:Omschrijving', 'Omschrijving'], ['e:Manufacturer', 'Manufacturer'],
    ['e:MPN', 'MPN'], ['e:KlantNaam', 'KlantNaam'], ['e:Mounting', 'Mounting'], ['e:Status', 'Status'],
    ['e:Kostprijs', 'Kostprijs', 'fx-num'], ['e:Voorraad', 'Voorraad', 'fx-num'], ['e:Verbruik', 'Verbruik', 'fx-num'],
    ['e:InBestelling', 'InBestelling', 'fx-num'], ['e:KlantNr', 'KlantNr'], ['e:Type', 'Type'],
];
const PARAM_COLUMNS = [
    ['p:value', 'Value', 'param-col g-start', 'Value (Ω resistor, -||- capacitor, L coil)'],
    ['p:tol', '%', 'param-col', 'Tolerance'], ['p:volt', 'V', 'param-col', 'Voltage'],
    ['p:power', 'P', 'param-col', 'Power'], ['p:pkg', 'Package', 'param-col', 'Package'],
];

/** The table head, plus a <colgroup> with one <col> per column (widths: applyColumnWidths). */
function renderTableHead(mappedCols, hasMpnfree) {
    const customerCount = mappedCols.length + (hasMpnfree ? 1 : 0);

    // [key, label, class, title] for every column after #
    const columns = [['status', 'Status', 'pin2']];
    for (const col of mappedCols) {
        const isQty = col.std === 'Quantity';
        columns.push([`c:${col.std}`, leftColumnLabels[col.std] || col.std, isQty ? 'fx-num' : '', isQty ? 'Quantity' : '']);
    }
    if (hasMpnfree) columns.push(['mpnfree', 'MPNfree']);
    columns.push(...ERP_COLUMNS, ...PARAM_COLUMNS);

    let grp = '<tr class="grp"><th class="pin1"></th><th class="pin2"></th>';
    if (customerCount > 0) grp += `<th colspan="${customerCount}">Customer BOM</th>`;
    grp += `<th colspan="${ERP_COLUMN_COUNT}" class="g-start">ERP match</th>`;
    grp += `<th colspan="${PARAM_COLUMN_COUNT}" class="g-start">Params</th></tr>`;

    let cols = '<tr class="cols"><th class="pin1 fx-num">#</th>';
    let colgroup = '<col data-col="#">';
    for (const [key, label, cls, title] of columns) {
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        cols += `<th class="${cls || ''}"${titleAttr}>${escapeHtml(label)}` +
            `<span class="col-resize-handle" data-col="${key}" title="Drag to resize · double-click to reset"></span></th>`;
        colgroup += `<col data-col="${key}">`;
    }
    cols += '</tr>';

    document.getElementById('matchCols').innerHTML = colgroup;
    document.getElementById('matchTableHead').innerHTML = grp + cols;
}

/** Customer BOM cells of one line (plus the MPNfree dropdown at the end when that mode is on). */
function renderCustomerCells(rowIndex, row, mappedCols, hasMpnfree, state) {
    let html = '';
    const hlItem = state.displayItem;
    for (const col of mappedCols) {
        const cellValue = getMappedValue(row, col.actual);
        if (col.std === 'Description') {
            if (isBlank(cellValue)) { html += `<td>${NIL}</td>`; continue; }
            // Highlight BOM description for MPNfree rows with parameterized match results
            let inner;
            if (hasMpnfree && getMpnfreeValue(rowIndex) && hlItem && hlItem._bom_highlights && hlItem._bom_highlights.length > 0) {
                inner = applyHighlights(cellValue, hlItem._bom_highlights);
            } else {
                inner = escapeHtml(cellValue);
            }
            html += `<td><span class="clip clip-desc" title="${escapeHtml(cellValue)}">${inner}</span></td>`;
        } else if (col.std === 'MPN') {
            if (isBlank(cellValue)) { html += `<td>${NIL}</td>`; continue; }
            html += `<td class="fx-mono" title="${escapeHtml(cellValue)}"><span class="mpn-clickable" title="Ctrl+Click: Google | Alt+Click: DigiKey">${escapeHtml(cellValue)}</span></td>`;
        } else if (col.std === 'Quantity') {
            html += isBlank(cellValue) ? `<td class="fx-num">${NIL}</td>` : `<td class="fx-num fx-mono">${escapeHtml(cellValue)}</td>`;
        } else if (col.std === 'Manufacturer') {
            html += textCell(cellValue, 'clip-m');
        } else if (col.std === 'Refdes') {
            html += textCell(cellValue, 'clip-s');
        } else {
            html += textCell(cellValue);
        }
    }
    if (hasMpnfree) {
        html += `<td class="mpnfree-cell">${renderMpnfreeDropdown(rowIndex)}</td>`;
    }
    return html;
}

/** The 13 ERP match cells of one line. */
function renderErpCells(rowIndex, row, state) {
    const auto = state.displayItem;
    if (!auto) {
        return `<td class="g-start">${NIL}</td>` +
            `<td>${NIL}</td>`.repeat(6) +
            `<td class="fx-num">${NIL}</td>`.repeat(4) +
            `<td>${NIL}</td>`.repeat(2);
    }
    const mapping = bomData.column_mapping || {};
    let html = '';

    // FaberNr: the assigned article (steel, with the previous-BOM check). Suggestions never show
    // here, only in the row panel.
    const nr = state.fabernr || auto.FaberNr;
    if (!isBlank(nr)) {
        html += `<td class="g-start" data-copy="${escapeHtml(nr)}"><span class="fnr">${escapeHtml(nr)}</span>${renderPreviousBomCheck(nr)}</td>`;
    } else {
        html += `<td class="g-start">${NIL}</td>`;
    }

    // Omschrijving with the parameter highlights
    if (isBlank(auto.Omschrijving)) {
        html += `<td>${NIL}</td>`;
    } else {
        html += `<td><span class="clip clip-desc" title="${escapeHtml(auto.Omschrijving)}">${renderHighlightedDescription(auto, state.match)}</span></td>`;
    }

    html += textCell(auto.Manufacturer, 'clip-m');
    const mpnHtml = renderMpnHighlights(auto, state.match, row, mapping);
    html += mpnHtml ? `<td class="fx-mono">${mpnHtml}</td>` : `<td>${NIL}</td>`;
    html += textCell(auto.KlantNaam, 'clip-m');
    html += mountingCell(auto.Mounting);
    html += erpStatusCell(auto.Status);
    html += priceCell(auto.Kostprijs);
    html += stockCell(auto.Voorraad);
    html += numCell(auto.Verbruik);
    html += numCell(auto.InBestelling);
    html += monoCell(auto.KlantNr);
    html += textCell(auto.Type, 'clip-t');
    return html;
}

// ========================================================================
// Lines grouped per component type (as BOM Compare): resistors, capacitors, coils, the rest;
// within a group by refdes number. The Export keeps the customer's order.
// ========================================================================

const TYPE_GROUP_ORDER = { resistor: 0, capacitor: 1, inductor: 2, other: 3 };
const TYPE_GROUP_LABELS = {
    resistor: 'Weerstanden',
    capacitor: 'Condensatoren',
    inductor: 'Spoelen en ferrieten',
    other: 'Overig',
};
// ERP article group (field Type) -> group, for lines the customer description does not reveal
const ERP_TYPE_GROUPS = {
    'WEERSTANDEN': 'resistor',
    'CONDENSATOREN': 'capacitor',
    "ELCO'S EN TANTALEN": 'capacitor',
    'SPOELEN EN SUPPRESSORS': 'inductor',
};

/**
 * Group of a line: from the customer's description and refdes (server, row_types). Only when
 * that says 'other', an assigned ERP article's Type can still place it (e.g. a bare MPN line).
 * Suggestions do not move a line, so a wrong suggestion never hides it in another group.
 */
function rowGroup(rowIndex) {
    const fromBom = (bomData.row_types && bomData.row_types[rowIndex]) || 'other';
    if (fromBom !== 'other') return fromBom;
    const state = getRowState(rowIndex);
    const item = state.fabernr ? currentItem(state) : null;
    const erpType = item ? String(item.Type || '').trim().toUpperCase() : '';
    return ERP_TYPE_GROUPS[erpType] || 'other';
}

/** Row indexes in display order, each with its group. */
function displayOrder() {
    const nums = bomData.row_refdes_num || [];
    const refNum = i => (nums[i] === null || nums[i] === undefined ? Infinity : nums[i]);
    return (bomData.rows || []).map((_, i) => ({ i, group: rowGroup(i), num: refNum(i) }))
        .sort((a, b) => (TYPE_GROUP_ORDER[a.group] - TYPE_GROUP_ORDER[b.group]) ||
            (a.num === b.num ? 0 : (a.num < b.num ? -1 : 1)) || (a.i - b.i));
}

function renderTables() {
    if (!bomData) return;

    // Preserve the scroll position before rebuilding the DOM
    const saved = captureScroll();

    const rows = bomData.rows || [];
    const mappedCols = getMappedColumns();
    const hasMpnfree = previousBomMode() || Object.keys(mpnfreeResults).length > 0;
    const paramsReady = typeof paramSettingsLoaded === 'function' && paramSettingsLoaded();

    renderTableHead(mappedCols, hasMpnfree);

    const colCount = 2 + mappedCols.length + (hasMpnfree ? 1 : 0) + ERP_COLUMN_COUNT + PARAM_COLUMN_COUNT;
    const order = displayOrder();
    const groupSize = {};
    order.forEach(o => { groupSize[o.group] = (groupSize[o.group] || 0) + 1; });

    let html = '';
    let lastGroup = null;
    for (const { i, group } of order) {
        // A divider above each group: Weerstanden · 44
        if (group !== lastGroup) {
            html += `<tr class="type-divider" data-group="${group}"><td colspan="${colCount}">` +
                `<span class="type-divider-text"><span class="type-divider-label">${TYPE_GROUP_LABELS[group]}</span>` +
                `<span class="type-divider-count">${groupSize[group]}</span></span></td></tr>`;
            lastGroup = group;
        }
        const row = rows[i];
        const state = getRowState(i);
        const classes = [];
        if (state.status === 'deleted') classes.push('row-deleted');
        const selAttr = selectedRow === i ? ' aria-selected="true"' : '';

        html += `<tr class="${classes.join(' ')}" data-row="${i}" data-group="${group}" data-status="${state.status || 'none'}"${selAttr}>`;
        html += `<td class="pin1 fx-num fx-mono rownum">${i + 1}</td>`;
        html += rowStatusCell(state);
        html += renderCustomerCells(i, row, mappedCols, hasMpnfree, state);
        html += renderErpCells(i, row, state);
        html += paramsReady ? buildMatcherParamCells(i) : '<td class="pc g-start"></td><td class="pc"></td><td class="pc"></td><td class="pc"></td><td class="pc"></td>';
        html += '</tr>';
    }
    html += `<tr class="empty-row" hidden><td colspan="${colCount}" class="table-empty">No lines match the search or the status filter.</td></tr>`;

    document.getElementById('matchTableBody').innerHTML = html;

    // The row panel lives inside the table body: put it back under its line
    if (panel) mountPanel();

    // Parameter indicators: inline above; fill them in once the package settings have loaded
    if (!paramsReady && typeof populateMatcherParamsTable === 'function') {
        populateMatcherParamsTable();
    }
    if (typeof initParamIndicatorTooltips === 'function') initParamIndicatorTooltips();

    // Re-apply any active filters (this also re-fits the table)
    filterTable();

    // Persist UI state for reload
    saveUiState();

    // Restore the scroll position after the DOM rebuild
    if (saved) {
        const sheet = document.getElementById('matchSheet');
        sheet.scrollTop = saved.top;
        sheet.scrollLeft = saved.left;
    }
}

// ========================================================================
// Column resize: drag the right border of a column header; double click resets the column
// ========================================================================

(function setupColumnResize() {
    const head = document.getElementById('matchTableHead');
    if (!head) return;
    const colOf = key => document.querySelector(`#matchCols col[data-col="${CSS.escape(key)}"]`);

    head.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.col-resize-handle');
        if (!handle || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const key = handle.dataset.col;
        const th = handle.closest('th');
        const table = document.getElementById('matchTable');
        const zoom = currentTableZoom || 1;
        // Width in table pixels (the table is zoomed: a screen pixel is 1/zoom table pixels)
        const startWidth = Math.round(th.getBoundingClientRect().width / zoom);
        const startX = e.clientX;
        userColumnWidths[key] = startWidth;
        fitMatchTable();  // fixes all columns at their current width; the zoom stays the same
        const col = colOf(key);
        if (!col) return;
        handle.classList.add('active');
        document.body.classList.add('col-resizing');

        const onMove = (ev) => {
            const w = Math.round(Math.max(MIN_COLUMN_WIDTH, startWidth + (ev.clientX - startX) / zoom));
            userColumnWidths[key] = w;
            col.style.width = w + 'px';
            const total = Array.from(document.querySelectorAll('#matchCols col'))
                .reduce((sum, c) => sum + (parseFloat(c.style.width) || 0), 0);
            table.style.width = total + 'px';
        };
        const onUp = () => {
            handle.classList.remove('active');
            document.body.classList.remove('col-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            saveColumnWidths();
            fitMatchTable();  // zoom again for the new widths
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    head.addEventListener('dblclick', (e) => {
        const handle = e.target.closest('.col-resize-handle');
        if (!handle) return;
        delete userColumnWidths[handle.dataset.col];
        saveColumnWidths();
        fitMatchTable();
    });

    head.addEventListener('click', (e) => {
        if (e.target.closest('.col-resize-handle')) e.stopPropagation();
    });
})();

// ========================================================================
// MPNfree Dropdown Rendering
// ========================================================================

// Previous-BOM mode: matching is driven by the old BOM. MPNfree is output-only here
// (it flows to the Excel export) and stays editable, defaulting to No.
function previousBomMode() {
    return previousBomByFaberNr.size > 0;
}

function getMpnfreeValue(rowIndex) {
    const strIdx = String(rowIndex);
    const sel = selections[strIdx] || {};
    // User override takes precedence
    if (sel.mpnfree !== undefined && sel.mpnfree !== null) {
        return sel.mpnfree;
    }
    // Then AI result
    const aiResult = mpnfreeResults[strIdx];
    if (aiResult) {
        return aiResult.mpnfree || false;
    }
    return false;
}

function renderMpnfreeDropdown(rowIndex) {
    const value = getMpnfreeValue(rowIndex);
    const yesSelected = value ? 'selected' : '';
    const noSelected = !value ? 'selected' : '';
    const cssClass = value ? 'mpnfree-yes' : 'mpnfree-no';
    return `<select class="mpnfree-dropdown ${cssClass}" aria-label="MPNfree for line ${rowIndex + 1}" onchange="overrideMpnfree(${rowIndex}, this.value === 'yes')" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()">
        <option value="no" ${noSelected}>No</option>
        <option value="yes" ${yesSelected}>Yes</option>
    </select>`;
}

async function overrideMpnfree(rowIndex, value) {
    const saved = captureScroll();  // before the async gap — true position
    const strIdx = String(rowIndex);
    if (!selections[strIdx]) selections[strIdx] = {};
    selections[strIdx].mpnfree = value;

    try {
        await apiCall('/api/match/override', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, mpnfree: value })
        });
        renderTables();
        restoreScroll(saved);
    } catch (e) {
        // toast shown
    }
}

// ========================================================================
// Select MPNfree (AI Assessment)
// ========================================================================

async function selectMpnfree() {
    const saved = captureScroll();  // before the async gap — true position
    // Toggle off if already showing
    if (Object.keys(mpnfreeResults).length > 0) {
        await apiCall('/api/match/mpnfree/clear', { method: 'POST' });
        mpnfreeResults = {};
        renderTables();
        restoreScroll(saved);
        return;
    }
    showLoading();
    try {
        const data = await apiCall('/api/match/mpnfree', {
            method: 'POST'
        });
        if (data.results) {
            mpnfreeResults = {};
            for (const r of data.results) {
                mpnfreeResults[String(r.index)] = r;
            }
        }
        renderTables();
        restoreScroll(saved);
        toast.success(`MPNfree assessment: ${data.mpnfree_count}/${data.total} parts marked as MPNfree`);
    } catch (e) {
        // toast shown
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Highlight Rendering
// ========================================================================

function renderHighlightedDescription(suggestion, match) {
    const desc = suggestion.Omschrijving || '';
    if (!desc) return '—';

    // For parameterized matches, highlight matched parameters
    const highlights = suggestion._param_highlights;
    if (highlights && highlights.length > 0) {
        return applyHighlights(desc, highlights);
    }

    return escapeHtml(desc);
}

function normMpn(s) {
    return String(s || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * How the ERP MPN relates to the customer's MPN: 'exact' when it is the same part number
 * (case and spaces aside, the rule Find IPN uses to assign automatically), 'partial' when one
 * contains the other or they share most of their start (packaging suffix, -TR), '' otherwise.
 */
function mpnMatchType(customerMpn, erpMpn) {
    const a = normMpn(customerMpn);
    const b = normMpn(erpMpn);
    if (!a || !b) return '';
    if (a === b) return 'exact';
    const sa = a.replace(/[^A-Z0-9]/g, '');
    const sb = b.replace(/[^A-Z0-9]/g, '');
    const shorter = Math.min(sa.length, sb.length);
    if (shorter < 4) return '';
    if (sa.includes(sb) || sb.includes(sa)) return 'partial';
    let common = 0;
    while (common < shorter && sa[common] === sb[common]) common++;
    return common >= Math.max(5, Math.ceil(shorter * 0.75)) ? 'partial' : '';
}

const MPN_MATCH_CLASS = { exact: 'hl-mpn-exact', partial: 'hl-mpn-partial' };
const MPN_MATCH_TIP = { exact: 'Same MPN as the customer BOM', partial: 'MPN differs from the customer BOM' };

/** An ERP MPN, green underlined when it equals the customer's MPN, amber when it only resembles it. */
function mpnHtml(erpMpn, customerMpn, extraClass) {
    const type = mpnMatchType(customerMpn, erpMpn);
    const cls = ['mpn-clickable', extraClass, MPN_MATCH_CLASS[type]].filter(Boolean).join(' ');
    const tip = (MPN_MATCH_TIP[type] ? MPN_MATCH_TIP[type] + ' · ' : '') + 'Ctrl+Click: Google | Alt+Click: DigiKey';
    return `<span class="${cls}" title="${escapeHtml(tip)}">${escapeHtml(erpMpn)}</span>`;
}

function renderMpnHighlights(suggestion, match, customerRow, mapping) {
    const erpMpn = suggestion.MPN || '';
    if (!erpMpn) return '';
    return mpnHtml(erpMpn, getMappedValue(customerRow, mapping.MPN));
}

function applyHighlights(text, highlights) {
    let parts = [];
    let lastEnd = 0;

    const ascSorted = [...highlights].sort((a, b) => a.start - b.start);
    for (const hl of ascSorted) {
        if (hl.start > lastEnd) {
            parts.push(escapeHtml(text.substring(lastEnd, hl.start)));
        }
        const hlText = text.substring(hl.start, hl.end);
        parts.push(`<span class="hl-${hl.color}">${escapeHtml(hlText)}</span>`);
        lastEnd = hl.end;
    }
    if (lastEnd < text.length) {
        parts.push(escapeHtml(text.substring(lastEnd)));
    }

    return parts.join('');
}

// ========================================================================
// Copy / Delete modes (toggles, at most one ON)
// ========================================================================

const MODE_HINTS = {
    copy: '<b>Copy mode</b> · click a cell to copy its text',
    'delete': '<b>Delete mode</b> · click a line to remove its ERP match',
};

function setMode(mode) {
    copyMode = mode === 'copy';
    deleteMode = mode === 'delete';

    const buttons = [['copyModeBtn', 'Copy', copyMode], ['deleteModeBtn', 'Delete', deleteMode]];
    for (const [id, name, on] of buttons) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const label = btn.querySelector('.tlabel');
        if (label) label.textContent = `${name}: ${on ? 'ON' : 'OFF'}`;
    }

    // In Copy / Delete mode a click does that action, so the row panel closes
    if (mode) closePanel();

    const page = document.querySelector('.match-page');
    if (page) {
        page.classList.toggle('mode-copy', copyMode);
        page.classList.toggle('mode-delete', deleteMode);
    }

    const hint = document.getElementById('modeHint');
    const hintText = document.getElementById('modeText');
    if (hint && hintText) {
        if (mode) {
            hintText.innerHTML = MODE_HINTS[mode];
            hint.classList.toggle('is-delete', mode === 'delete');
            hint.hidden = false;
        } else {
            hint.hidden = true;
        }
    }
}

function toggleCopyMode() {
    setMode(copyMode ? null : 'copy');
}

function toggleDeleteMode() {
    setMode(deleteMode ? null : 'delete');
}

// ========================================================================
// Storing one line: Remove match, Accept suggestion, Use, Undo
// ========================================================================

function cloneJson(v) {
    return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));
}

/** Everything needed to put a line back as it was (for Undo). */
function snapshotRow(rowIndex) {
    const s = String(rowIndex);
    return { match: cloneJson(matchResults[s]), sel: cloneJson(selections[s]), deleted: deletedRows.has(rowIndex) };
}

function applyRowLocal(rowIndex, match, sel, deleted) {
    const s = String(rowIndex);
    if (match) matchResults[s] = match; else delete matchResults[s];
    if (sel && Object.keys(sel).length) selections[s] = sel; else delete selections[s];
    if (deleted) deletedRows.add(rowIndex); else deletedRows.delete(rowIndex);
}

/** Set a line's match + selection here and on the server, then re-render. Returns true when stored. */
async function storeRow(rowIndex, match, sel, deleted) {
    const before = snapshotRow(rowIndex);
    const saved = captureScroll();
    applyRowLocal(rowIndex, match, sel, deleted);
    renderTables();
    restoreScroll(saved);
    const s = String(rowIndex);
    try {
        await apiCall('/api/match/set-row', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, match: matchResults[s] || null, selection: selections[s] || null })
        });
        return true;
    } catch (e) {
        // toast shown by apiCall; put the line back
        applyRowLocal(rowIndex, before.match, before.sel, before.deleted);
        renderTables();
        restoreScroll(saved);
        return false;
    }
}

// Only the latest action can be undone: an older Undo would overwrite what came after it
let undoToastId = null;

/** A success toast with an Undo button that restores the snapshot. */
function notifyWithUndo(message, rowIndex, snap) {
    if (undoToastId !== null) toast.dismiss(undoToastId);
    undoToastId = toast.show(message, 'success', 8000, {
        label: 'Undo',
        onClick: async () => {
            if (await storeRow(rowIndex, snap.match, snap.sel, snap.deleted)) {
                toast.info(`Row ${rowIndex + 1} is back as it was`);
            }
        }
    });
}

/** The ERP article of the line for the row panel: the assigned one or else the suggestion. */
function currentItem(state) {
    return state.status === 'deleted' ? null : (state.displayItem || state.suggestion);
}

/** Remove the ERP match of a line. The candidates stay, so another one can still be picked. */
async function deleteMatch(rowIndex) {
    const state = getRowState(rowIndex);
    const item = currentItem(state);
    if (!item && !state.fabernr) {
        toast.info(`Row ${rowIndex + 1} has no match to remove`);
        return;
    }
    const snap = snapshotRow(rowIndex);
    const nr = state.fabernr || (item && item.FaberNr) || '';
    const match = state.match
        ? Object.assign(cloneJson(state.match), { auto_selected: null, display_suggestion: null, confidence: 'none' })
        : null;
    const sel = Object.assign({}, state.sel);
    delete sel.fabernr;
    if (await storeRow(rowIndex, match, sel, true)) {
        notifyWithUndo(`Match removed for row ${rowIndex + 1}${nr ? ` (${nr})` : ''}`, rowIndex, snap);
    }
}

/** Assign an ERP article to a line; it is added to the line's candidates when it came from a search. */
async function useItem(rowIndex, item, how) {
    if (!item || isBlank(item.FaberNr)) return;
    const state = getRowState(rowIndex);
    const snap = snapshotRow(rowIndex);
    const match = cloneJson(state.match) ||
        { row_index: rowIndex, search_method: 'manual', suggestions: [], auto_selected: null, confidence: 'none' };
    const list = Array.isArray(match.suggestions) ? match.suggestions : [];
    if (!list.some(s => s.FaberNr === item.FaberNr)) list.unshift(cloneJson(item));
    match.suggestions = list;
    const sel = Object.assign({}, state.sel, { fabernr: item.FaberNr });
    if (await storeRow(rowIndex, match, sel, false)) {
        notifyWithUndo(`Row ${rowIndex + 1} now uses ${item.FaberNr}${how ? ` · ${how}` : ''}`, rowIndex, snap);
    }
}

// ========================================================================
// Row selection and the row panel: click a line, a panel opens directly under it
// ========================================================================

// The open panel: { row, view: 'cands' | 'results', results, shown, q, qmode, busy, failed, smode, input }
let panel = null;

const PANEL_ICON_PATHS = {
    check: '<path d="M3 8.5l3 3 7-7"/>',
    trash: '<path d="M2.5 4h11"/><path d="M6 4V2.5h4V4"/><path d="M3.75 4l.75 9.5h7l.75-9.5"/>',
    close: '<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>',
    back: '<path d="M13 8H3"/><path d="M7 4L3 8l4 4"/>',
    search: '<circle cx="7" cy="7" r="4.75"/><path d="M10.5 10.5L14 14"/>',
};

function panelIcon(name) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
        `stroke-linejoin="round" aria-hidden="true">${PANEL_ICON_PATHS[name]}</svg>`;
}

const SEARCH_MODES = [['mpn', 'MPN'], ['ipn', 'IPN'], ['description', 'Description']];
const SEARCH_MODE_LABELS = { mpn: 'MPN', ipn: 'IPN', description: 'Description' };

function rowEl(rowIndex) {
    return document.querySelector(`#matchTableBody tr[data-row="${rowIndex}"]`);
}

function panelRowEl() {
    return document.querySelector('#matchTableBody tr.xrow');
}

function selectRow(rowIndex) {
    selectedRow = rowIndex;
    document.querySelectorAll('#matchTableBody tr[aria-selected="true"]').forEach(tr => tr.removeAttribute('aria-selected'));
    const tr = rowEl(rowIndex);
    if (tr) tr.setAttribute('aria-selected', 'true');
    saveUiState();
}

/** Keep a line (and its open panel) in view inside the sheet, below the sticky header. */
function revealRow(rowIndex) {
    const sheet = document.getElementById('matchSheet');
    const tr = rowEl(rowIndex);
    if (!sheet || !tr) return;
    const below = (panel && panel.row === rowIndex && panelRowEl()) || tr;
    const box = sheet.getBoundingClientRect();
    const headH = document.getElementById('matchTableHead').getBoundingClientRect().height;
    const top = tr.getBoundingClientRect().top;
    const bottom = below.getBoundingClientRect().bottom;
    const minTop = box.top + sheet.clientTop + headH;
    const maxBottom = box.top + sheet.clientTop + sheet.clientHeight;
    if (top < minTop) sheet.scrollTop -= (minTop - top);
    else if (bottom > maxBottom) sheet.scrollTop += Math.min(bottom - maxBottom + 6, top - minTop);
}

function scrollSelectedRowIntoView() {
    if (selectedRow !== null) revealRow(selectedRow);
}

function togglePanel(rowIndex) {
    if (panel && panel.row === rowIndex) closePanel();
    else openPanel(rowIndex);
}

function openPanel(rowIndex) {
    const tr = rowEl(rowIndex);
    if (!tr || tr.hidden) return;
    selectRow(rowIndex);
    panel = {
        row: rowIndex, view: 'cands', results: [], shown: [],
        q: '', qmode: '', busy: false, failed: false, smode: null, input: null,
    };
    mountPanel();
    fitMatchTable();
    revealRow(rowIndex);
}

function closePanel(silent) {
    if (!panel) return;
    unmountPanel();
    panel = null;
    if (!silent) fitMatchTable();
}

function unmountPanel() {
    document.querySelectorAll('#matchTableBody tr.xrow').forEach(x => x.remove());
    document.querySelectorAll('#matchTableBody tr.is-open').forEach(tr => {
        tr.classList.remove('is-open');
        tr.removeAttribute('aria-expanded');
    });
}

/** Insert the panel row under its line (also after every renderTables) and fill it. */
function mountPanel() {
    unmountPanel();
    if (!panel) return;
    const tr = rowEl(panel.row);
    if (!tr || tr.hidden) { panel = null; return; }
    const x = document.createElement('tr');
    x.className = 'xrow';
    x.innerHTML = `<td colspan="${tr.children.length}"><div class="xwrap">` +
        `<div class="xpanel" role="region" aria-label="Row ${panel.row + 1}: current match, candidates and search">` +
        '<section class="xcur" aria-label="Current match"></section>' +
        '<section class="xright"><div class="xhead"></div>' +
        '<div class="xmini"><div class="xmini-scroll"></div></div>' +
        '<div class="xsearch"></div></section>' +
        '</div></div></td>';
    tr.after(x);
    tr.classList.add('is-open');
    tr.setAttribute('aria-expanded', 'true');
    renderPanel();
}

function renderPanel() {
    const x = panelRowEl();
    if (!x || !panel) return;
    x.querySelector('.xcur').innerHTML = panelCurrentHtml(panel.row);
    x.querySelector('.xhead').innerHTML = panelHeadHtml(panel.row);
    x.querySelector('.xmini-scroll').innerHTML = panelListHtml(panel.row);
    x.querySelector('.xsearch').innerHTML = panelSearchHtml(panel.row);
}

// ------------------------------------------------------------------------
// Word underlines in the row panel (as BOM Compare): the customer description (A) and the ERP
// Omschrijving (B) are split into words and normalised (case, decimal comma, 20K0 = 20k,
// µ = u, SMD0402 = 0402, RES = Resistor...). A word in both lines gets the same colour on both
// sides; similar part numbers a dashed amber line; parameter words without an exact partner
// their category colour (voltage, tolerance, package, power); other words without a partner red.
// ------------------------------------------------------------------------

const TOKEN_MATCH_COLORS = ['#22c55e', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6', '#0ea5e9', '#f97316'];
const TOKEN_CATEGORY_COLORS = { voltage: '#f59e0b', tolerance: '#a855f7', package: '#06b6d4', power: '#84cc16' };
const TOKEN_SYNONYMS = {
    resistor: 'res', resistors: 'res', weerstand: 'res', weerst: 'res',
    capacitor: 'cap', capacitors: 'cap', condensator: 'cap', cond: 'cap',
    inductor: 'ind', inductors: 'ind', spoel: 'ind', coil: 'ind',
    mosfet: 'fet', pmosfet: 'fet', nmosfet: 'fet',
};
const TOKEN_PACKAGES = /^(01005|0201|0402|0603|0805|1206|1210|1608|1616|1812|2010|2012|2220|2512|2520|sot-?\d+|sod-?\d+|qfn-?\d+|soic-?\d+|tssop-?\d+)$/;

function descTokens(str) {
    const out = [];
    String(str || '').split(/[\s;]+/).forEach(part => {
        if (/^[±+\-/]*\d+,\d+\w*%?$/.test(part)) out.push(part);
        else part.split(',').forEach(t => { if (t.trim()) out.push(t.trim()); });
    });
    return out.map(t => ({ text: t, norm: normalizeDescToken(t) }));
}

function normalizeDescToken(token) {
    let t = token.toLowerCase().replace(/[.,:;()]+$/, '').replace(/^[(]+/, '').replace(/µ/g, 'u').replace(/[Ωω]/g, '');
    t = t.replace(/(\d),(\d)/g, '$1.$2');
    t = t.replace(/^(?:smd|case)(\d{4})$/, '$1');
    t = t.replace(/^(\d+)k0+$/, '$1k').replace(/^(\d+)\.0+k$/, '$1k').replace(/^(\d+)k(\d+)$/, '$1.$2k');
    t = t.replace(/^(\d+)m0+$/, '$1m').replace(/^(\d+)m(\d+)$/, '$1.$2m');
    t = t.replace(/^(\d+)[er]$/, '$1').replace(/^(\d+)[er](\d+)$/, '$1.$2');
    return TOKEN_SYNONYMS[t] || t;
}

function descTokenCategory(norm) {
    if (/^[+-]?\d+(\.\d+)?k?v(dc|ac)?$/.test(norm) || /^[+-]?\d+(\.\d+)?mv$/.test(norm)) return 'voltage';
    if (/%$/.test(norm) || /^±/.test(norm)) return 'tolerance';
    if (TOKEN_PACKAGES.test(norm)) return 'package';
    if (/^\d+(\.\d+)?m?w$/.test(norm) || /^\d+\/\d+w$/.test(norm)) return 'power';
    return null;
}

/** Both descriptions as HTML with the word underlines: { a, b }. */
function compareDescriptions(a, b) {
    const ta = descTokens(a);
    const tb = descTokens(b);
    const shared = new Map();
    let next = 0;
    ta.forEach(t => {
        if (!shared.has(t.norm) && tb.some(u => u.norm === t.norm)) {
            shared.set(t.norm, TOKEN_MATCH_COLORS[next++ % TOKEN_MATCH_COLORS.length]);
        }
    });
    const near = (t, other) => t.norm.length >= 5 && other.some(u => u.norm !== t.norm && u.norm.length >= 5 &&
        (u.norm.startsWith(t.norm) || t.norm.startsWith(u.norm)));
    const render = (tokens, other) => tokens.map(t => {
        const text = escapeHtml(t.text);
        const color = shared.get(t.norm);
        if (color) return `<span class="tk" style="border-bottom-color:${color};background:${color}1f">${text}</span>`;
        if (near(t, other)) return `<span class="tk tk-near">${text}</span>`;
        const cat = descTokenCategory(t.norm);
        if (cat) return `<span class="tk" style="border-bottom-color:${TOKEN_CATEGORY_COLORS[cat]}">${text}</span>`;
        return `<span class="tk tk-miss">${text}</span>`;
    }).join(' ');
    return { a: render(ta, tb), b: render(tb, ta) };
}

const FACT_LABELS = {
    resistor: 'Resistance', capacitor: 'Capacitance', inductor: 'Inductance', bead: 'Impedance',
};
const FACT_SIGNS = {
    match: ['✓', 'is-ok', 'Same'], acceptable: ['↑', 'is-warn', 'Acceptable'], diff: ['≠', 'is-bad', 'Different'],
    missing: ['–', 'is-muted', 'Not in both'],
};

/** The A | B facts table of a line against an ERP article (same comparison as the dots). */
function panelFactsHtml(rowIndex, item) {
    const row = (bomData.rows || [])[rowIndex] || {};
    const mapping = bomData.column_mapping || {};
    const customerDesc = getMappedValue(row, mapping.Description).replace(/<[^>]*>/g, '');
    const erpDesc = String(item.Omschrijving || '').replace(/<[^>]*>/g, '');
    const groupHint = bomData.row_types ? bomData.row_types[rowIndex] : undefined;
    const p = extractParametersFromDescription(customerDesc, erpDesc, 1, groupHint);
    const isCap = (p.value1 && /[pnuµ]F/i.test(p.value1)) || (p.value2 && /[pnuµ]F/i.test(p.value2));
    const valueLabel = FACT_LABELS[p.kind] || (isCap ? FACT_LABELS.capacitor : (groupHint === 'resistor' ? FACT_LABELS.resistor : 'Value'));
    const facts = [
        [valueLabel, p.value1, p.value2, p.valueStatus],
        ['Tolerance', p.tolerance1, p.tolerance2, p.toleranceStatus],
        ['Voltage', p.voltage1, p.voltage2, p.voltageStatus],
        ['Power', p.power1, p.power2, p.powerStatus],
        ['Package', p.package1, p.package2, p.packageStatus],
    ]
        // Other parts (IC, transistor, diode...): only the package; their "35mR" is no resistance
        .filter(([label]) => !(groupHint === 'other' && !p.kind) || label === 'Package')
        .filter(([, a, b, status]) => status !== 'na' && (a || b));
    if (!facts.length) return '<div class="xnote">No parameters to compare for this part</div>';
    const rows = facts.map(([label, a, b, status]) => {
        const [sign, cls, tip] = FACT_SIGNS[status] || FACT_SIGNS.missing;
        return `<tr><td class="xf-label">${label}</td><td class="fx-mono">${a ? escapeHtml(a) : NIL}</td>` +
            `<td class="fx-mono">${b ? escapeHtml(b) : NIL}</td><td class="xf-sign ${cls}" title="${tip}">${sign}</td></tr>`;
    }).join('');
    return '<table class="xfacts-tab"><thead><tr><th></th><th><span class="xab xab-a">A</span>BOM</th>' +
        `<th><span class="xab xab-b">B</span>ERP</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Left card of the row panel: the customer line (A) against the linked article or suggestion (B). */
function panelCurrentHtml(rowIndex) {
    const state = getRowState(rowIndex);
    const item = currentItem(state);
    const n = rowIndex + 1;
    const row = (bomData.rows || [])[rowIndex] || {};
    const mapping = bomData.column_mapping || {};
    const customerDesc = getMappedValue(row, mapping.Description);
    const customerMpn = getMappedValue(row, mapping.MPN).trim();
    const isSugg = !!item && !state.fabernr;
    const nr = state.fabernr || (item && item.FaberNr) || '';

    let head = `<span class="xlabel">Row ${n}</span>`;
    if (nr) {
        head += isSugg
            ? ` <span class="sugg">${escapeHtml(nr)}</span>`
            : ` <span class="fnr">${escapeHtml(nr)}</span>${renderPreviousBomCheck(nr)}`;
    }
    let h = `<div class="xcur-top"><span class="xcur-id">${head}</span>` +
        `${isSugg ? '<span class="fx-badge fx-badge-steel">Suggestion</span>' : statusBadge(state)}</div>`;

    const lines = compareDescriptions(customerDesc, item ? item.Omschrijving : '');
    h += `<div class="xab-line"><span class="xab xab-a" title="Customer BOM">A</span><span class="xab-text">${customerDesc ? lines.a : NIL}</span></div>`;
    if (item) {
        h += `<div class="xab-line"><span class="xab xab-b" title="ERP">B</span><span class="xab-text">${item.Omschrijving ? lines.b : NIL}</span></div>` +
            '<div class="xab-mpn">' +
            `<span><span class="xab xab-a xab-sm">A</span><span class="fx-mono">${customerMpn ? escapeHtml(customerMpn) : NIL}</span></span>` +
            `<span><span class="xab xab-b xab-sm">B</span>${isBlank(item.MPN) ? NIL : mpnHtml(item.MPN, customerMpn)}</span>` +
            (isBlank(item.Mounting) ? '' : mountingBadge(item.Mounting)) + '</div>' +
            panelFactsHtml(rowIndex, item);
    } else if (state.fabernr) {
        h += '<div class="xnone-text">Assigned by hand; the article details are not loaded.</div>';
    } else {
        let text = 'Not matched yet. Run Find IPN, or search the ERP by MPN, IPN or description.';
        if (state.status === 'deleted') text = 'Match removed. Use a candidate or search the ERP by MPN, IPN or description.';
        else if (state.match) text = 'No ERP article linked. Use a candidate or search the ERP by MPN, IPN or description.';
        h += `<div class="xnone-text">${text}</div>`;
    }

    const qty = getMappedValue(row, mapping.Quantity).trim();
    const refdes = getMappedValue(row, mapping.Refdes).trim();
    const facts = [];
    if (item) facts.push(`<span>Kostprijs<b>${priceHtml(item.Kostprijs)}</b></span>`, `<span>Voorraad<b>${stockHtml(item.Voorraad)}</b></span>`);
    if (qty) facts.push(`<span>Qty<b>${escapeHtml(qty)}</b></span>`);
    if (refdes) facts.push(`<span class="xfacts-refdes" title="${escapeHtml(refdes)}">Refdes<b>${escapeHtml(refdes)}</b></span>`);
    if (facts.length) h += `<div class="xfacts">${facts.join('')}</div>`;

    const canRemove = !!(item || state.fabernr);
    // A suggestion, or a partial match Find IPN assigned itself, can be confirmed (it becomes Matched)
    let acceptLabel = '';
    if (item && !state.fabernr) acceptLabel = 'Accept suggestion';
    else if (item && !state.sel.fabernr && state.status === 'partial') acceptLabel = 'Accept match';
    h += '<div class="xcur-act">' +
        (acceptLabel ? `<button type="button" class="btn btn-primary" data-act="accept">${panelIcon('check')}${acceptLabel}</button>` : '') +
        `<button type="button" class="btn btn-danger" data-act="remove"${canRemove ? '' : ' disabled title="This line has no match"'}>${panelIcon('trash')}Remove match</button>` +
        '</div>';
    return h;
}

/** The line's candidates in Find IPN order, with the shown article first when it is not among them. */
function panelCandidates(rowIndex) {
    const state = getRowState(rowIndex);
    const list = (state.match && Array.isArray(state.match.suggestions)) ? state.match.suggestions.slice() : [];
    const item = currentItem(state);
    if (item && !isBlank(item.FaberNr) && !list.some(s => s.FaberNr === item.FaberNr)) list.unshift(item);
    return list;
}

function panelHeadHtml(rowIndex) {
    let h;
    if (panel.view === 'results') {
        h = `<span class="xtitle">${panel.busy ? 'Searching...' : 'Search results'}</span>` +
            (panel.busy ? '' : `<span class="fx-badge fx-badge-neutral fx-badge-mono">${panel.results.length}</span>`) +
            `<span class="xrule">${escapeHtml(SEARCH_MODE_LABELS[panel.qmode] || '')} · “${escapeHtml(panel.q)}”</span><span class="xgrow"></span>` +
            `<button type="button" class="btn btn-ghost xsmall" data-act="back">${panelIcon('back')}Back to candidates</button>`;
    } else {
        const count = panelCandidates(rowIndex).length;
        h = `<span class="xtitle">Candidates for row ${rowIndex + 1}</span><span class="fx-badge fx-badge-neutral fx-badge-mono">${count}</span>` +
            '<span class="xgrow"></span>';
    }
    h += `<button type="button" class="btn btn-ghost xsmall xclose" data-act="close" title="Close (Esc)">${panelIcon('close')}Close</button>`;
    return h;
}

/**
 * The customer an ERP article belongs to (KlantNaam + KlantNr). Klant 0 is general stock (grey);
 * the customer of this BOM gets a green line, another customer an amber one.
 */
function klantCellHtml(item) {
    const nr = String(item.KlantNr === undefined || item.KlantNr === null ? '' : item.KlantNr).trim();
    const name = String(item.KlantNaam || '').trim();
    if (!nr && !name) return `<td>${NIL}</td>`;
    if (nr === '0' || !nr) {
        return `<td class="xklant" title="General stock"><span class="xklant-general">Algemeen</span> <span class="xknr">${escapeHtml(nr || '0')}</span></td>`;
    }
    const bomKlant = String((bomData && bomData.klant_nr) || '').trim();
    const same = bomKlant && nr === bomKlant;
    const cls = bomKlant ? (same ? ' is-same' : ' is-other') : '';
    const tip = `${name} · ${nr}${bomKlant ? (same ? ' · customer of this BOM' : ' · another customer') : ''}`;
    return `<td class="xklant${cls}" title="${escapeHtml(tip)}"><span class="xclip xclip-m">${escapeHtml(name || '—')}</span> <span class="xknr">${escapeHtml(nr)}</span></td>`;
}

// The candidates in Find IPN's order, each with the parameter dots against the customer line
// (as in the main table: value, tolerance, voltage, power, package)
const PANEL_LIST_HEAD = '<thead><tr><th>FaberNr</th><th>Omschrijving</th><th>Manufacturer</th><th>MPN</th><th>Mounting</th>' +
    '<th>Status</th><th class="fx-num">Kostprijs</th><th class="fx-num">Voorraad</th><th>Klant</th>' +
    '<th class="xparam" title="Value (Ω resistor, -||- capacitor, L coil)">Value</th><th class="xparam" title="Tolerance">%</th>' +
    '<th class="xparam" title="Voltage">V</th><th class="xparam" title="Power">P</th><th class="xparam" title="Package">Package</th>' +
    '<th class="xact"><span class="xsr">Action</span></th></tr></thead>';
const PANEL_LIST_COLS = 15;

function panelListHtml(rowIndex) {
    const message = (text) => `<table>${PANEL_LIST_HEAD}<tbody><tr class="xmsg"><td colspan="${PANEL_LIST_COLS}">${text}</td></tr></tbody></table>`;
    if (panel.view === 'results' && panel.busy) {
        return message(`Searching the ERP by ${escapeHtml(SEARCH_MODE_LABELS[panel.qmode] || '')} for “${escapeHtml(panel.q)}”...`);
    }
    const state = getRowState(rowIndex);
    const list = panel.view === 'results' ? panel.results : panelCandidates(rowIndex);
    panel.shown = list;
    if (!list.length) {
        if (panel.view === 'results') {
            return message(panel.failed ? 'The search failed. Try again.' : 'No ERP articles found. Try another MPN, IPN or description.');
        }
        return message('No candidates for this line. Search the ERP below by MPN, IPN or description.');
    }

    const item = currentItem(state);
    const curNr = state.fabernr || (item && item.FaberNr) || '';
    const curIsSugg = !state.fabernr;
    const customerMpn = customerSearchValue(rowIndex, 'mpn');
    let body = '';
    list.forEach((s, k) => {
        const isCur = !!curNr && s.FaberNr === curNr;
        const act = !isCur
            ? `<button type="button" class="btn xuse" data-act="use" data-k="${k}">Use</button>`
            : (curIsSugg ? '<span class="fx-badge fx-badge-steel">Suggestion</span>' : '<span class="fx-badge fx-badge-success">✓ In use</span>');
        const oms = s.Omschrijving || '';
        const omsHtml = s._param_highlights && s._param_highlights.length ? applyHighlights(oms, s._param_highlights) : escapeHtml(oms);
        const cls = isCur ? ` class="is-cur${curIsSugg ? ' is-sugg' : ''}"` : '';
        const stockN = toNumber(s.Voorraad);
        body += `<tr${cls}>` +
            `<td><span class="fnr">${escapeHtml(s.FaberNr || '')}</span>${renderPreviousBomCheck(s.FaberNr || '')}</td>` +
            `<td>${oms ? `<span class="xclip" title="${escapeHtml(oms)}">${omsHtml}</span>` : NIL}</td>` +
            `<td>${isBlank(s.Manufacturer) ? NIL : `<span class="xclip xclip-m" title="${escapeHtml(s.Manufacturer)}">${escapeHtml(s.Manufacturer)}</span>`}</td>` +
            `<td class="fx-mono">${isBlank(s.MPN) ? NIL : mpnHtml(s.MPN, customerMpn, 'xclip xclip-l')}</td>` +
            `<td>${mountingBadge(s.Mounting)}</td>` +
            `<td>${erpStatusBadge(s.Status)}</td>` +
            `<td class="fx-num fx-mono">${priceHtml(s.Kostprijs)}</td>` +
            `<td class="fx-num${stockN !== null && stockN > 0 ? ' fx-mono' : ''}">${stockHtml(s.Voorraad)}</td>` +
            klantCellHtml(s) +
            buildParamCellsFor(rowIndex, s) +
            `<td class="xact">${act}</td></tr>`;
    });
    return `<table>${PANEL_LIST_HEAD}<tbody>${body}</tbody></table>`;
}

/** The customer's value to search on: MPN, Description, or the line's current FaberNr for IPN. */
function customerSearchValue(rowIndex, mode) {
    const row = (bomData && bomData.rows && bomData.rows[rowIndex]) || {};
    const mapping = (bomData && bomData.column_mapping) || {};
    if (mode === 'mpn') return getMappedValue(row, mapping.MPN).trim();
    if (mode === 'ipn') {
        const state = getRowState(rowIndex);
        const item = currentItem(state);
        return state.fabernr || (item && item.FaberNr) || '';
    }
    return getMappedValue(row, mapping.Description).trim();
}

function panelSearchHtml(rowIndex) {
    if (!panel.smode) panel.smode = customerSearchValue(rowIndex, 'mpn') ? 'mpn' : 'description';
    if (panel.input === null) panel.input = customerSearchValue(rowIndex, panel.smode);
    const seg = SEARCH_MODES.map(([key, label]) =>
        `<button type="button" data-act="smode" data-mode="${key}" aria-pressed="${panel.smode === key}">${label}</button>`
    ).join('');
    return '<span class="xlabel">Search ERP</span>' +
        `<div class="xseg" role="group" aria-label="Search by">${seg}</div>` +
        `<label class="xfield">${panelIcon('search')}` +
        `<input type="text" class="xq" value="${escapeHtml(panel.input)}" aria-label="Search the ERP" autocomplete="off" spellcheck="false"></label>` +
        `<button type="button" class="btn xgo" data-act="search"${panel.busy ? ' disabled' : ''}>${panelIcon('search')}${panel.busy ? 'Searching...' : 'Search'}</button>`;
}

/** Manual ERP search from the panel. A preview only: the line changes once a result is used. */
async function runPanelSearch() {
    if (!panel || panel.busy) return;
    const p = panel;
    const query = String(p.input || '').trim();
    if (!query) {
        toast.warning('Type an MPN, IPN or description first');
        const input = panelRowEl() && panelRowEl().querySelector('.xq');
        if (input) input.focus();
        return;
    }
    Object.assign(p, { view: 'results', q: query, qmode: p.smode, results: [], busy: true, failed: false });
    renderPanel();
    try {
        const data = await apiCall('/api/match/manual-search', {
            method: 'POST',
            body: JSON.stringify({ row_index: p.row, search_type: p.smode, query: query, preview: true })
        });
        p.results = data.suggestions || [];
    } catch (e) {
        p.results = [];
        p.failed = true;
    }
    p.busy = false;
    if (panel === p) renderPanel();  // the panel may have closed or moved meanwhile
}

function copyText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    navigator.clipboard.writeText(t)
        .then(() => toast.success(`Copied: ${t.substring(0, 50)}`))
        .catch(() => {});
}

/** Clicks inside the open panel (buttons carry data-act). */
function onPanelClick(e) {
    if (!panel) return;
    const btn = e.target.closest('[data-act]');
    if (!btn) {
        const mpn = e.target.closest('.mpn-clickable');
        if (mpn) copyText(mpn.textContent);
        return;
    }
    if (btn.disabled) return;
    const rowIndex = panel.row;
    switch (btn.dataset.act) {
        case 'close':
            closePanel();
            break;
        case 'remove':
            deleteMatch(rowIndex);
            break;
        case 'accept':
            useItem(rowIndex, currentItem(getRowState(rowIndex)), getRowState(rowIndex).fabernr ? 'match accepted' : 'suggestion accepted');
            break;
        case 'use': {
            const item = (panel.shown || [])[parseInt(btn.dataset.k, 10)];
            const how = panel.view === 'results'
                ? `from the ${SEARCH_MODE_LABELS[panel.qmode] || ''} search`
                : 'from the candidates';
            // Back to the candidates: the chosen article is now among them, marked as in use
            panel.view = 'cands';
            useItem(rowIndex, item, how);
            break;
        }
        case 'smode': {
            panel.smode = btn.dataset.mode;
            panel.input = customerSearchValue(rowIndex, panel.smode);
            renderPanel();
            const input = panelRowEl().querySelector('.xq');
            input.focus();
            input.select();
            break;
        }
        case 'search':
            runPanelSearch();
            break;
        case 'back':
            panel.view = 'cands';
            renderPanel();
            break;
    }
}

// ========================================================================
// Filter/Search
// ========================================================================

function rowMatchesStatus(status) {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'matched') return status === 'matched';
    if (statusFilter === 'partial') return status === 'partial';
    // No match: also lines without a match yet and removed matches (as before: confidence 'none')
    if (statusFilter === 'nomatch') return status !== 'matched' && status !== 'partial';
    return true;
}

function filterTable() {
    const input = document.getElementById('searchInput');
    const searchText = ((input && input.value) || '').trim().toLowerCase();
    const tbody = document.getElementById('matchTableBody');
    if (!tbody) return;

    let any = false;
    let total = 0;
    const shownPerGroup = {};
    tbody.querySelectorAll('tr[data-row]').forEach(tr => {
        total++;
        let show = rowMatchesStatus(tr.dataset.status === 'none' ? '' : tr.dataset.status);
        if (show && searchText) {
            show = tr.textContent.toLowerCase().includes(searchText);
        }
        tr.hidden = !show;
        if (show) {
            any = true;
            shownPerGroup[tr.dataset.group] = (shownPerGroup[tr.dataset.group] || 0) + 1;
        }
    });
    // Group dividers: the number of lines shown, hidden when none of the group is shown
    tbody.querySelectorAll('tr.type-divider').forEach(div => {
        const shown = shownPerGroup[div.dataset.group] || 0;
        div.hidden = shown === 0;
        const count = div.querySelector('.type-divider-count');
        if (count) count.textContent = shown;
    });
    // A filtered-out line takes its open panel with it
    if (panel) {
        const open = rowEl(panel.row);
        if (!open || open.hidden) closePanel(true);
    }
    const empty = tbody.querySelector('.empty-row');
    if (empty) empty.hidden = any || total === 0;

    fitMatchTable();
}

function setStatusFilter(filter) {
    statusFilter = filter || 'all';
    document.querySelectorAll('#statusChips .fx-chip').forEach(chip => {
        chip.setAttribute('aria-pressed', chip.dataset.filter === statusFilter ? 'true' : 'false');
    });
    filterTable();
}

document.querySelectorAll('#statusChips .fx-chip').forEach(chip => {
    chip.addEventListener('click', () => setStatusFilter(chip.dataset.filter));
});

// ========================================================================
// Find IPN (Batch)
// ========================================================================

async function findIpn() {
    const saved = captureScroll();
    showLoading();
    try {
        const data = await apiCall('/api/match/find-ipn', {
            method: 'POST',
            body: JSON.stringify({})
        });
        if (data.results) {
            matchResults = {};
            for (const r of data.results) {
                matchResults[String(r.row_index)] = r;
            }
            // Find IPN starts over: no line is marked as removed, the parts picked by hand
            // are forgotten (the server cleared them; the MPNfree choices stay)
            deletedRows.clear();
            if (data.selections) selections = data.selections;
        }
        renderTables();
        restoreScroll(saved);

        let msg = `Found matches: ${data.matched}/${data.total} rows`;
        if (data.parameterized > 0) {
            msg += ` (${data.parameterized} parameterized)`;
        }
        toast.success(msg);
    } catch (e) {
        // toast shown
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Export
// ========================================================================

async function exportBom() {
    showLoading();
    try {
        const csrfToken = getCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRFToken'] = csrfToken;

        const response = await fetch('/api/export', {
            method: 'POST',
            headers
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Export failed');
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = response.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'bom_matched.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        toast.success('BOM exported successfully');
    } catch (e) {
        toast.error(e.message);
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Keyboard: arrows move the selection (the open panel moves along), Enter opens or closes, Esc closes
// ========================================================================

/** The next (step 1) or previous (step -1) shown line in display order; start -1 = the first. */
function visibleRowAfter(start, step) {
    const shown = Array.from(document.querySelectorAll('#matchTableBody tr[data-row]')).filter(tr => !tr.hidden);
    if (!shown.length) return null;
    const pos = shown.findIndex(tr => parseInt(tr.dataset.row, 10) === start);
    const next = pos < 0 ? (step > 0 ? shown[0] : null) : shown[pos + step];
    return next ? parseInt(next.dataset.row, 10) : null;
}

document.addEventListener('keydown', (e) => {
    // Escape: first switch Copy / Delete mode off, then close the panel
    if (e.key === 'Escape') {
        if (copyMode || deleteMode) setMode(null);
        else if (panel) closePanel();
        return;
    }

    if (!bomData || !bomData.rows || bomData.rows.length === 0) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Leave typing in the search fields and the MPNfree dropdowns alone
    const target = e.target && e.target.closest ? e.target : null;
    if (target && target.closest('input, select, textarea')) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = selectedRow === null ? (step > 0 ? visibleRowAfter(-1, 1) : null) : visibleRowAfter(selectedRow, step);
        if (next === null) return;
        if (panel) openPanel(next);
        else { selectRow(next); scrollSelectedRowIntoView(); }
    } else if (e.key === 'Enter') {
        // Enter on a button or link keeps its own meaning
        if (target && target.closest('button, a')) return;
        if (selectedRow === null) return;
        const tr = rowEl(selectedRow);
        if (!tr || tr.hidden) return;
        e.preventDefault();
        if (deleteMode) deleteMatch(selectedRow);
        else if (!copyMode) togglePanel(selectedRow);
    }
});

// ========================================================================
// Delegated handlers on the sheet: row panel, Delete mode, Copy mode, MPN shortcuts
// ========================================================================

const _matchSheet = document.getElementById('matchSheet');

_matchSheet.addEventListener('click', function(e) {
    const inPanel = e.target.closest('#matchTableBody tr.xrow');
    const tr = inPanel ? null : e.target.closest('#matchTableBody tr[data-row]');

    // Copy mode: copy any cell's text to clipboard
    if (copyMode && !inPanel) {
        const td = e.target.closest('#matchTableBody td');
        if (td && !td.closest('tr.type-divider')) {
            e.stopPropagation();
            e.preventDefault();
            const text = (td.dataset.copy || td.textContent).trim();
            if (text && text !== '—') {
                navigator.clipboard.writeText(text).then(() => {
                    td.classList.add('cell-copied');
                    setTimeout(() => { td.classList.remove('cell-copied'); }, 300);
                    toast.success(`Copied: ${text.substring(0, 50)}`);
                }).catch(() => {});
            }
            if (tr) selectRow(parseInt(tr.dataset.row, 10));
            return;
        }
    }

    // MPN click shortcuts: Ctrl+Click=Google, Alt+Click=DigiKey (in the table and in the panel)
    const mpnEl = e.target.closest('.mpn-clickable');
    if (mpnEl && (e.ctrlKey || e.metaKey || e.altKey)) {
        const mpn = mpnEl.innerText.trim();
        if (!mpn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            window.open(`https://www.google.com/search?q=${encodeURIComponent(mpn)}`, '_blank', 'noopener,noreferrer');
        } else if (e.altKey) {
            window.open(`https://www.digikey.nl/en/products/result?keywords=${encodeURIComponent(mpn)}`, '_blank', 'noopener,noreferrer');
        }
        return;
    }

    if (inPanel) {
        onPanelClick(e);
        return;
    }

    if (!tr) return;
    if (e.target.closest('a, button, select, input')) return;
    const rowIndex = parseInt(tr.dataset.row, 10);
    if (deleteMode) {
        selectRow(rowIndex);
        deleteMatch(rowIndex);
        return;
    }
    // The second click of a double click keeps the panel open
    if (e.detail > 1) return;
    // Dragging to select text in a line does not toggle its panel
    const textSel = window.getSelection ? window.getSelection() : null;
    if (textSel && !textSel.isCollapsed && tr.contains(textSel.anchorNode)) return;
    togglePanel(rowIndex);
});

// Typing and Enter in the panel's search field
_matchSheet.addEventListener('input', function(e) {
    if (panel && e.target.classList && e.target.classList.contains('xq')) panel.input = e.target.value;
});

_matchSheet.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('xq')) {
        e.preventDefault();
        e.stopPropagation();
        runPanelSearch();
    }
});

// ========================================================================
// Init
// ========================================================================

loadBomData();
