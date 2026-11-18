/**
 * BOM Matcher - Process Page JavaScript
 * One table per BOM line: customer BOM columns, the ERP match and the parameter indicators,
 * with auto-fit zoom, MPN/parameter highlights, full-screen row detail modal,
 * MPNfree selection, Copy/Delete modes and manual search.
 */

let bomData = null;
let matchResults = {};
let mpnfreeResults = {};
let selections = {};
let selectedRow = null;
let activeModal = null;
let copyMode = false;
let deleteMode = false;
let deletedRows = new Set();
let modalSortColumn = null;
let modalSortAsc = true;
let modalSuggestions = [];
let modalRowIndex = null;
let descColumnWidth = null;
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
            descColumnWidth: descColumnWidth,
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
        if (state.descColumnWidth) descColumnWidth = state.descColumnWidth;
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
// Auto-fit zoom: measure at 100%, zoom = available / needed, never below 60%
// ========================================================================

const MIN_TABLE_ZOOM = 0.6;
let currentTableZoom = 1;

function fitMatchTable() {
    const sheet = document.getElementById('matchSheet');
    const table = document.getElementById('matchTable');
    if (!sheet || !table) return;
    const keepTop = sheet.scrollTop;
    const keepLeft = sheet.scrollLeft;

    table.style.zoom = 1;
    table.style.width = 'auto';
    const needed = table.offsetWidth;
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
    sheet.scrollTop = keepTop;
    sheet.scrollLeft = keepLeft;
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
    return `<td>${v}</td>`;
}

function monoCell(value) {
    if (isBlank(value)) return `<td>${NIL}</td>`;
    return `<td class="fx-mono">${escapeHtml(value)}</td>`;
}

function numCell(value) {
    const n = toNumber(value);
    if (n === null) return `<td class="fx-num">${NIL}</td>`;
    return `<td class="fx-num fx-mono">${fmtQty(n)}</td>`;
}

function priceCell(value) {
    const n = toNumber(value);
    // Kostprijs comes in as 0 when Exact has no cost price: show it as missing
    if (n === null || n === 0) return `<td class="fx-num">${NIL}</td>`;
    return `<td class="fx-num fx-mono">€ ${_nlPrice.format(n)}</td>`;
}

function stockCell(value) {
    const n = toNumber(value);
    if (n === null) return `<td class="fx-num">${NIL}</td>`;
    if (n <= 0) return `<td class="fx-num"><span class="fx-badge fx-badge-danger fx-badge-mono" title="Out of stock">✖ ${fmtQty(n)}</span></td>`;
    return `<td class="fx-num fx-mono">${fmtQty(n)}</td>`;
}

const MOUNTING_TONES = { SMD: 'sky', HAND: 'gold', PHM: 'slate', PCB: 'steel' };

function mountingCell(value) {
    if (isBlank(value)) return `<td>${NIL}</td>`;
    const tone = MOUNTING_TONES[String(value).trim().toUpperCase()] || 'neutral';
    return `<td><span class="fx-badge fx-badge-${tone}">${escapeHtml(value)}</span></td>`;
}

function erpStatusCell(value) {
    if (isBlank(value)) return `<td>${NIL}</td>`;
    const s = String(value).trim();
    const lower = s.toLowerCase();
    if (lower === 'actief') return `<td><span class="fx-badge fx-badge-success">✓ ${escapeHtml(s)}</span></td>`;
    if (lower === 'vervallen' || lower === 'geblokkeerd' || lower === 'blocked') {
        return `<td><span class="fx-badge fx-badge-danger">✖ ${escapeHtml(s)}</span></td>`;
    }
    return `<td><span class="fx-badge fx-badge-neutral">${escapeHtml(s)}</span></td>`;
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

/** The Status badge per line: ✓ Matched / ⚠ Partial / ✖ No match, Deleted, or — when not matched yet. */
function rowStatusCell(state) {
    const parts = [];
    if (state.sel.fabernr) {
        parts.push('Selected by hand');
    } else if (state.match) {
        parts.push(SEARCH_METHOD_LABELS[state.match.search_method] || state.match.search_method || 'No search');
        const score = state.displayItem ? state.displayItem._similarity_score : undefined;
        if (score !== undefined && score !== null) parts.push(`${Math.round(score)}%`);
    }
    const tip = escapeHtml(parts.join(' · '));
    switch (state.status) {
        case 'deleted':
            return `<td class="pin2"><span class="fx-badge fx-badge-slate row-status" title="Match removed">✕ Deleted</span></td>`;
        case 'matched':
            return `<td class="pin2"><span class="fx-badge fx-badge-success row-status" title="${tip}">✓ Matched</span></td>`;
        case 'partial':
            return `<td class="pin2"><span class="fx-badge fx-badge-warning row-status" title="${tip}">⚠ Partial</span></td>`;
        case 'nomatch':
            return `<td class="pin2"><span class="fx-badge fx-badge-danger row-status" title="${tip}">✖ No match</span></td>`;
        default:
            return `<td class="pin2" title="Not matched yet">${NIL}</td>`;
    }
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

    // Which item to display: manually selected suggestion, auto_selected, or display_suggestion
    let displayItem = null;
    if (sel.fabernr && match && match.suggestions) {
        displayItem = match.suggestions.find(s => s.FaberNr === sel.fabernr) || null;
    }
    if (!displayItem && match && match.auto_selected) {
        displayItem = match.auto_selected;
    }
    if (!displayItem && match && match.display_suggestion) {
        displayItem = match.display_suggestion;
    }

    let status = '';
    if (deletedRows.has(rowIndex)) {
        status = 'deleted';
    } else if (confidence === 'high') {
        status = 'matched';
    } else if (confidence === 'medium' || confidence === 'low') {
        status = 'partial';
    } else if (match && match.confidence === 'none') {
        status = 'nomatch';
    }

    return { match, sel, fabernr, confidence, searchMethod, displayItem, status };
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

function renderTableHead(mappedCols, hasMpnfree) {
    const customerCount = mappedCols.length + (hasMpnfree ? 1 : 0);

    let grp = '<tr class="grp"><th class="pin1"></th><th class="pin2"></th>';
    if (customerCount > 0) grp += `<th colspan="${customerCount}">Customer BOM</th>`;
    grp += `<th colspan="${ERP_COLUMN_COUNT}" class="g-start">ERP match</th>`;
    grp += `<th colspan="${PARAM_COLUMN_COUNT}" class="g-start">Params</th></tr>`;

    let cols = '<tr class="cols"><th class="pin1 fx-num">#</th><th class="pin2">Status</th>';
    for (const col of mappedCols) {
        const label = escapeHtml(leftColumnLabels[col.std] || col.std);
        if (col.std === 'Description') {
            cols += `<th class="resizable-th desc-th">${label}<div class="col-resize-handle" data-col="desc" title="Drag to resize the description columns"></div></th>`;
        } else if (col.std === 'Quantity') {
            cols += `<th class="fx-num" title="Quantity">${label}</th>`;
        } else {
            cols += `<th>${label}</th>`;
        }
    }
    if (hasMpnfree) cols += '<th>MPNfree</th>';
    cols += '<th class="g-start">FaberNr</th><th>Omschrijving</th><th>Manufacturer</th><th>MPN</th><th>KlantNaam</th>' +
        '<th>Mounting</th><th>Status</th><th class="fx-num">Kostprijs</th><th class="fx-num">Voorraad</th>' +
        '<th class="fx-num">Verbruik</th><th class="fx-num">InBestelling</th><th>KlantNr</th><th>Type</th>';
    cols += '<th class="param-col g-start" title="Value (Ω resistor, -||- capacitor)">Value</th>' +
        '<th class="param-col" title="Tolerance">%</th>' +
        '<th class="param-col" title="Voltage">V</th>' +
        '<th class="param-col" title="Power">P</th>' +
        '<th class="param-col" title="Package">Package</th></tr>';

    document.getElementById('matchTableHead').innerHTML = grp + cols;
}

/** Customer BOM cells of one line (plus the MPNfree dropdown at the end when that mode is on). */
function renderCustomerCells(rowIndex, row, mappedCols, hasMpnfree, state) {
    let html = '';
    const hlItem = state.match && (state.match.auto_selected || state.match.display_suggestion);
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

    // FaberNr: assigned (steel, with the previous-BOM check) or only a suggestion (italic, muted)
    if (state.fabernr) {
        html += `<td class="g-start" data-copy="${escapeHtml(state.fabernr)}"><span class="fnr">${escapeHtml(state.fabernr)}</span>${renderPreviousBomCheck(state.fabernr)}</td>`;
    } else if (!isBlank(auto.FaberNr)) {
        html += `<td class="g-start" data-copy="${escapeHtml(auto.FaberNr)}" title="Suggestion, not assigned"><span class="sugg">${escapeHtml(auto.FaberNr)}</span><span class="sugg-note">(suggestion)</span></td>`;
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

function renderTables() {
    if (!bomData) return;

    // Preserve the scroll position before rebuilding the DOM
    const saved = captureScroll();

    const rows = bomData.rows || [];
    const mappedCols = getMappedColumns();
    const hasMpnfree = previousBomMode() || Object.keys(mpnfreeResults).length > 0;
    const paramsReady = typeof paramSettingsLoaded === 'function' && paramSettingsLoaded();

    renderTableHead(mappedCols, hasMpnfree);

    let html = '';
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const state = getRowState(i);
        const classes = [];
        if (state.status === 'deleted') classes.push('row-deleted');
        const selAttr = selectedRow === i ? ' aria-selected="true"' : '';

        html += `<tr class="${classes.join(' ')}" data-row="${i}" data-status="${state.status || 'none'}"${selAttr}>`;
        html += `<td class="pin1 fx-num fx-mono rownum">${i + 1}</td>`;
        html += rowStatusCell(state);
        html += renderCustomerCells(i, row, mappedCols, hasMpnfree, state);
        html += renderErpCells(i, row, state);
        html += paramsReady ? buildMatcherParamCells(i) : '<td class="pc g-start"></td><td class="pc"></td><td class="pc"></td><td class="pc"></td><td class="pc"></td>';
        html += '</tr>';
    }
    const colCount = 2 + mappedCols.length + (hasMpnfree ? 1 : 0) + ERP_COLUMN_COUNT + PARAM_COLUMN_COUNT;
    html += `<tr class="empty-row" hidden><td colspan="${colCount}" class="table-empty">No lines match the search or the status filter.</td></tr>`;

    document.getElementById('matchTableBody').innerHTML = html;

    // Parameter indicators: inline above; fill them in once the package settings have loaded
    if (!paramsReady && typeof populateMatcherParamsTable === 'function') {
        populateMatcherParamsTable();
    }
    if (typeof initParamIndicatorTooltips === 'function') initParamIndicatorTooltips();

    // Setup the description column resize handle
    setupColumnResize();
    applyDescColumnWidth(descColumnWidth);

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
// Column Resize (both description columns share one width)
// ========================================================================

function applyDescColumnWidth(w) {
    const table = document.getElementById('matchTable');
    if (!table) return;
    if (w) table.style.setProperty('--desc-w', w + 'px');
    else table.style.removeProperty('--desc-w');
}

function setupColumnResize() {
    const handles = document.querySelectorAll('#matchTableHead .col-resize-handle');
    handles.forEach(handle => {
        handle.addEventListener('click', (e) => e.stopPropagation());
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const clip = document.querySelector('#matchTableBody .clip-desc');
            const startX = e.clientX;
            const zoom = currentTableZoom || 1;
            const startWidth = descColumnWidth || (clip ? clip.offsetWidth : 220);

            handle.classList.add('active');

            function onMouseMove(ev) {
                // The table is zoomed: a screen pixel is 1/zoom table pixels
                const newWidth = Math.round(Math.max(60, startWidth + (ev.clientX - startX) / zoom));
                descColumnWidth = newWidth;
                applyDescColumnWidth(newWidth);
            }

            function onMouseUp() {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                saveUiState();
                fitMatchTable();
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

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

function renderMpnHighlights(suggestion, match, customerRow, mapping) {
    const customerMpn = getMappedValue(customerRow, mapping.MPN);
    const erpMpn = suggestion.MPN || '';

    if (!erpMpn) return '';

    // Check for MPN highlights
    const highlights = suggestion._mpn_highlights;
    if (highlights && highlights.length > 0) {
        const hl = highlights[0];
        const hlClass = hl.match_type === 'exact' ? 'hl-mpn-exact' : 'hl-mpn-partial';
        return `<span class="mpn-clickable ${hlClass}" title="Ctrl+Click: Google | Alt+Click: DigiKey">${escapeHtml(erpMpn)}</span>`;
    }

    return `<span class="mpn-clickable" title="Ctrl+Click: Google | Alt+Click: DigiKey">${escapeHtml(erpMpn)}</span>`;
}

function renderScore(suggestion, match) {
    const score = suggestion._similarity_score;
    if (score !== undefined && score !== null) {
        const pct = Math.round(score);
        const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--amber)' : 'var(--danger)';
        return `<span class="score-bar">
            <span class="score-bar-fill">
                <span class="score-bar-fill-inner" style="width: ${pct}%; background: ${color};"></span>
            </span>
            ${pct}%
        </span>`;
    }

    // For MPN matches, show confidence indicator
    if (match && match.search_method === 'mpn') {
        const conf = match.confidence;
        if (conf === 'high') return '<span style="color: var(--success); font-weight: 600;">Exact</span>';
        if (conf === 'medium') return '<span style="color: var(--warning);">Partial</span>';
    }

    return '';
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

async function deleteMatch(rowIndex) {
    const saved = captureScroll();
    const strIdx = String(rowIndex);
    delete matchResults[strIdx];
    delete selections[strIdx];
    deletedRows.add(rowIndex);

    try {
        await apiCall('/api/match/delete', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex })
        });
        toast.success(`Match removed for row ${rowIndex + 1}`);
    } catch (e) {
        // toast shown by apiCall
    }
    renderTables();
    restoreScroll(saved);
}

// ========================================================================
// Row Selection — Full-Screen Modal
// ========================================================================

function selectRow(rowIndex) {
    selectedRow = rowIndex;
    document.querySelectorAll('#matchTableBody tr[aria-selected="true"]').forEach(tr => tr.removeAttribute('aria-selected'));
    const tr = document.querySelector(`#matchTableBody tr[data-row="${rowIndex}"]`);
    if (tr) tr.setAttribute('aria-selected', 'true');
    saveUiState();
}

function openSelectedRowModal() {
    if (selectedRow !== null) {
        showRowDetailModal(selectedRow);
    }
}

function scrollSelectedRowIntoView() {
    if (selectedRow === null) return;
    const tr = document.querySelector(`#matchTableBody tr[data-row="${selectedRow}"]`);
    if (tr) {
        tr.scrollIntoView({ block: 'nearest' });
    }
}

function showRowDetailModal(rowIndex) {
    if (!bomData) return;
    modalSortColumn = null;
    modalSortAsc = true;

    const mapping = bomData.column_mapping || {};
    const rows = bomData.rows || [];
    const row = rows[rowIndex];
    if (!row) return;

    const strIdx = String(rowIndex);
    const match = matchResults[strIdx];
    const suggestions = (match && match.suggestions) ? match.suggestions : [];
    const hasMpnfree = previousBomMode() || Object.keys(mpnfreeResults).length > 0;

    // Build left side: customer BOM details
    const mappedCols = getMappedColumns();

    let leftHtml = '';
    for (const col of mappedCols) {
        const val = getMappedValue(row, col.actual);
        const isClickable = col.std === 'Description' || col.std === 'MPN';
        const extraClass = isClickable ? ' left-field-clickable' : '';
        const clickAttr = isClickable
            ? ` data-field-type="${col.std === 'MPN' ? 'mpn' : 'description'}" style="cursor:pointer; text-decoration:underline dotted; text-underline-offset:3px;" title="Click to copy to search box${col.std === 'MPN' ? ' | Ctrl+click: Google | Alt+click: DigiKey' : ''}"`
            : '';
        leftHtml += `<div class="row-detail-field">
            <div class="row-detail-field-label">${escapeHtml(col.std)}</div>
            <div class="row-detail-field-value${extraClass}"${clickAttr}>${escapeHtml(val)}</div>
        </div>`;
    }

    // MPNfree dropdown in modal
    if (hasMpnfree) {
        const mpnfreeVal = getMpnfreeValue(rowIndex);
        leftHtml += `<div class="row-detail-field">
            <div class="row-detail-field-label">MPNfree</div>
            <div class="row-detail-field-value">
                <select class="mpnfree-dropdown ${mpnfreeVal ? 'mpnfree-yes' : 'mpnfree-no'}"
                        onchange="overrideMpnfreeFromModal(${rowIndex}, this.value === 'yes')">
                    <option value="no" ${!mpnfreeVal ? 'selected' : ''}>No</option>
                    <option value="yes" ${mpnfreeVal ? 'selected' : ''}>Yes</option>
                </select>
            </div>
        </div>`;
    }

    // Match info
    if (match) {
        const sel = selections[strIdx] || {};
        const fabernr = sel.fabernr || (match.auto_selected ? match.auto_selected.FaberNr : '');
        if (fabernr) {
            leftHtml += `<div class="row-detail-field">
                <div class="row-detail-field-label">Assigned IPN</div>
                <div class="row-detail-field-value" style="font-family: var(--font-family-mono); color: var(--color-primary); font-weight: 600;">${escapeHtml(fabernr)}</div>
            </div>`;
        }
        leftHtml += `<div class="row-detail-field">
            <div class="row-detail-field-label">Search Method</div>
            <div class="row-detail-field-value">${escapeHtml(match.search_method || 'none')} (${escapeHtml(match.confidence || 'none')})</div>
        </div>`;
    }

    // Build right side: alternatives table
    const altTableHtml = buildAlternativesTable(suggestions, rowIndex);

    // Build modal content
    const bodyHtml = `
        <div class="row-detail-left">${leftHtml}</div>
        <div class="row-detail-right">
            <div class="row-detail-header">ERP Matches (${suggestions.length} results)</div>
            <div class="row-detail-alternatives" id="modalAltBody">
                ${altTableHtml}
            </div>
            <div class="row-detail-search">
                <select class="form-select" id="modalSearchType">
                    <option value="mpn">MPN</option>
                    <option value="ipn">IPN</option>
                    <option value="description" selected>Description</option>
                </select>
                <input type="text" class="form-input" id="modalSearchQuery" placeholder="Search query..."
                       onkeydown="if(event.key==='Enter') manualSearch(${rowIndex})">
                <button class="btn btn-primary btn-sm" onclick="manualSearch(${rowIndex})">Search</button>
            </div>
        </div>
    `;

    // Create modal using ModalManager pattern but with fullscreen size
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modalEl = document.createElement('div');
    modalEl.className = 'modal modal-fullscreen';

    modalEl.innerHTML = `
        <div class="modal-header" style="display: flex; align-items: center; gap: 12px;">
            <button class="btn btn-outline btn-sm" onclick="closeRowDetailModal()">Close</button>
            <h3 class="modal-title">Row ${rowIndex + 1} Details</h3>
        </div>
        <div class="modal-body">${bodyHtml}</div>
    `;

    // MPN click handler: Click=Copy, Ctrl+Click=Google, Alt+Click=DigiKey
    modalEl.addEventListener('click', function(e) {
        if (e.target.classList.contains('mpn-clickable')) {
            const mpn = e.target.innerText.trim();
            if (!mpn) return;

            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                window.open(`https://www.google.com/search?q=${encodeURIComponent(mpn)}`, '_blank', 'noopener,noreferrer');
            } else if (e.altKey) {
                e.preventDefault();
                window.open(`https://www.digikey.nl/en/products/result?keywords=${encodeURIComponent(mpn)}`, '_blank', 'noopener,noreferrer');
            } else {
                navigator.clipboard.writeText(mpn).catch(() => {});
            }
        }
        // Left panel field click handler
        if (e.target.classList.contains('left-field-clickable')) {
            const val = e.target.textContent.trim();
            if (!val) return;
            const fieldType = e.target.dataset.fieldType;

            if (fieldType === 'mpn' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                window.open(`https://www.google.com/search?q=${encodeURIComponent(val)}`, '_blank', 'noopener,noreferrer');
            } else if (fieldType === 'mpn' && e.altKey) {
                e.preventDefault();
                window.open(`https://www.digikey.nl/en/products/result?keywords=${encodeURIComponent(val)}`, '_blank', 'noopener,noreferrer');
            } else {
                document.getElementById('modalSearchQuery').value = val;
                document.getElementById('modalSearchType').value = fieldType;
            }
        }
    });

    overlay.appendChild(modalEl);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeRowDetailModal();
    });

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Show with animation
    requestAnimationFrame(() => overlay.classList.add('show'));

    activeModal = overlay;

    // Escape key handler
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeRowDetailModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // Focus search input
    setTimeout(() => {
        const input = document.getElementById('modalSearchQuery');
        if (input) input.focus();
    }, 200);
}

const modalColumns = [
    { key: 'FaberNr', label: 'FaberNr' },
    { key: 'Omschrijving', label: 'Omschrijving' },
    { key: 'Manufacturer', label: 'Manufacturer' },
    { key: 'MPN', label: 'MPN' },
    { key: 'KlantNaam', label: 'KlantNaam' },
    { key: 'Mounting', label: 'Mounting' },
    { key: 'Status', label: 'Status' },
    { key: 'Kostprijs', label: 'Kostprijs', numeric: true },
    { key: 'Voorraad', label: 'Voorraad', numeric: true },
    { key: 'Verbruik', label: 'Verbruik', numeric: true },
    { key: 'InBestelling', label: 'InBestelling', numeric: true },
    { key: 'KlantNr', label: 'KlantNr' },
    { key: 'Type', label: 'Type' },
];

function sortModalTable(columnKey) {
    if (modalSortColumn === columnKey) {
        modalSortAsc = !modalSortAsc;
    } else {
        modalSortColumn = columnKey;
        modalSortAsc = true;
    }
    const altBody = document.getElementById('modalAltBody');
    if (altBody) {
        altBody.innerHTML = buildAlternativesTable(modalSuggestions, modalRowIndex);
    }
}

function buildAlternativesTable(suggestions, rowIndex) {
    if (!suggestions || suggestions.length === 0) {
        return '<div style="padding: 24px; text-align: center; color: var(--text-muted);">No matches found. Use manual search below.</div>';
    }

    // Store for sorting
    modalSuggestions = suggestions;
    modalRowIndex = rowIndex;

    // Sort if a column is selected
    let sorted = [...suggestions];
    if (modalSortColumn) {
        const colDef = modalColumns.find(c => c.key === modalSortColumn);
        const isNumeric = colDef && colDef.numeric;
        sorted.sort((a, b) => {
            let va = a[modalSortColumn] || '';
            let vb = b[modalSortColumn] || '';
            if (isNumeric) {
                va = parseFloat(va) || 0;
                vb = parseFloat(vb) || 0;
                return modalSortAsc ? va - vb : vb - va;
            }
            va = String(va).toLowerCase();
            vb = String(vb).toLowerCase();
            if (va < vb) return modalSortAsc ? -1 : 1;
            if (va > vb) return modalSortAsc ? 1 : -1;
            return 0;
        });
    }

    let html = '<table class="data-table"><thead><tr>';
    for (const col of modalColumns) {
        const arrow = modalSortColumn === col.key ? (modalSortAsc ? ' ▲' : ' ▼') : '';
        html += `<th style="cursor:pointer; user-select:none;" onclick="sortModalTable('${col.key}')">${col.label}${arrow}</th>`;
    }
    html += '<th></th></tr></thead><tbody>';

    for (const s of sorted) {
        const descHtml = s._param_highlights && s._param_highlights.length > 0
            ? applyHighlights(s.Omschrijving || '', s._param_highlights)
            : escapeHtml(s.Omschrijving || '');
        const fabernr = escapeHtml(s.FaberNr || '');

        html += `<tr>
            <td><strong>${fabernr}</strong>${renderPreviousBomCheck(s.FaberNr || '')}</td>
            <td title="${escapeHtml(s.Omschrijving || '')}">${descHtml}</td>
            <td>${escapeHtml(s.Manufacturer || '')}</td>
            <td><span class="mpn-clickable" title="Click: Copy | Ctrl+Click: Google | Alt+Click: DigiKey">${escapeHtml(s.MPN || '')}</span></td>
            <td>${escapeHtml(s.KlantNaam || '')}</td>
            <td>${escapeHtml(s.Mounting || '')}</td>
            <td>${escapeHtml(s.Status || '')}</td>
            <td>${s.Kostprijs || 0}</td>
            <td>${s.Voorraad || 0}</td>
            <td>${s.Verbruik || 0}</td>
            <td>${s.InBestelling || 0}</td>
            <td>${escapeHtml(s.KlantNr || '')}</td>
            <td>${escapeHtml(s.Type || '')}</td>
            <td><button class="btn btn-primary btn-sm" onclick="selectFromModal(${rowIndex}, '${fabernr}')">Select</button></td>
        </tr>`;
    }

    html += '</tbody></table>';
    return html;
}

function closeRowDetailModal() {
    if (activeModal) {
        activeModal.classList.remove('show');
        setTimeout(() => {
            if (activeModal && activeModal.parentNode) {
                activeModal.parentNode.removeChild(activeModal);
            }
            activeModal = null;
            document.body.style.overflow = '';
        }, 200);
    }
}

function selectFromModal(rowIndex, fabernr) {
    overrideFabernr(rowIndex, fabernr);
    closeRowDetailModal();
}

async function overrideMpnfreeFromModal(rowIndex, value) {
    await overrideMpnfree(rowIndex, value);
}

// ========================================================================
// Manual Search
// ========================================================================

async function manualSearch(rowIndex) {
    const searchType = document.getElementById('modalSearchType').value;
    const query = document.getElementById('modalSearchQuery').value.trim();
    if (!query) {
        toast.warning('Please enter a search query');
        return;
    }

    const altBody = document.getElementById('modalAltBody');
    altBody.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Searching...</div>';

    try {
        const data = await apiCall('/api/match/manual-search', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, search_type: searchType, query: query })
        });

        const suggestions = data.suggestions || [];

        // Update stored match results
        if (data.result) {
            matchResults[String(rowIndex)] = data.result;
        }

        altBody.innerHTML = buildAlternativesTable(suggestions, rowIndex);

        if (suggestions.length === 0) {
            toast.info('No results found');
        } else {
            toast.success(`Found ${suggestions.length} results`);
        }
    } catch (e) {
        altBody.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--color-danger);">Search failed</div>';
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
    tbody.querySelectorAll('tr[data-row]').forEach(tr => {
        total++;
        let show = rowMatchesStatus(tr.dataset.status === 'none' ? '' : tr.dataset.status);
        if (show && searchText) {
            show = tr.textContent.toLowerCase().includes(searchText);
        }
        tr.hidden = !show;
        if (show) any = true;
    });
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
// Overrides
// ========================================================================

async function overrideFabernr(rowIndex, value) {
    const saved = captureScroll();
    const strIdx = String(rowIndex);
    if (!selections[strIdx]) selections[strIdx] = {};
    selections[strIdx].fabernr = value;
    // Choosing a match again un-marks a line whose match was removed
    deletedRows.delete(rowIndex);

    try {
        await apiCall('/api/match/override', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, fabernr: value })
        });
        renderTables();
        restoreScroll(saved);
    } catch (e) {
        // toast shown
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
// Keyboard Navigation
// ========================================================================

function visibleRowAfter(start, step) {
    const totalRows = bomData.rows.length;
    for (let i = start + step; i >= 0 && i < totalRows; i += step) {
        const tr = document.querySelector(`#matchTableBody tr[data-row="${i}"]`);
        if (tr && !tr.hidden) return i;
    }
    return null;
}

document.addEventListener('keydown', (e) => {
    // Only handle keys when no modal is open
    if (activeModal) return;

    // Escape switches Copy / Delete mode off
    if (e.key === 'Escape' && (copyMode || deleteMode)) {
        setMode(null);
        return;
    }

    if (!bomData || !bomData.rows) return;
    // Leave typing in the search field, the MPNfree dropdowns and buttons alone
    if (e.target && e.target.closest && e.target.closest('input, select, textarea, button, a')) return;

    const totalRows = bomData.rows.length;
    if (totalRows === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = selectedRow === null ? visibleRowAfter(-1, 1) : visibleRowAfter(selectedRow, 1);
        if (next === null) return;
        selectRow(next);
        scrollSelectedRowIntoView();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectedRow === null) return;
        const prev = visibleRowAfter(selectedRow, -1);
        if (prev === null) return;
        selectRow(prev);
        scrollSelectedRowIntoView();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        openSelectedRowModal();
    }
});

// ========================================================================
// Delegated handlers on the sheet: row select / delete, Copy mode, MPN shortcuts, details
// ========================================================================

const _matchSheet = document.getElementById('matchSheet');

_matchSheet.addEventListener('click', function(e) {
    const tr = e.target.closest('#matchTableBody tr[data-row]');

    // Copy mode: copy any cell's text to clipboard
    if (copyMode) {
        const td = e.target.closest('#matchTableBody td');
        if (td) {
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

    // MPN click shortcuts: Ctrl+Click=Google, Alt+Click=DigiKey
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

    if (!tr) return;
    const rowIndex = parseInt(tr.dataset.row, 10);
    if (deleteMode) {
        deleteMatch(rowIndex);
    } else {
        selectRow(rowIndex);
    }
});

_matchSheet.addEventListener('dblclick', function(e) {
    if (copyMode || deleteMode) return;
    const tr = e.target.closest('#matchTableBody tr[data-row]');
    if (!tr) return;
    showRowDetailModal(parseInt(tr.dataset.row, 10));
});

// ========================================================================
// Init
// ========================================================================

loadBomData();
