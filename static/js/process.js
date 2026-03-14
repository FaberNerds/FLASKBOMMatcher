/**
 * BOM Matcher - Process Page JavaScript
 * Split-panel layout with synchronized scrolling, MPN/parameter highlights,
 * full-screen row detail modal, MPNfree selection, and manual search.
 */

let bomData = null;
let matchResults = {};
let mpnfreeResults = {};
let selections = {};
let selectedRow = null;
let activeModal = null;
let manualSearchMode = true;
let deleteMode = false;
let deletedRows = new Set();
let modalSortColumn = null;
let modalSortAsc = true;
let modalSuggestions = [];
let modalRowIndex = null;
let descColumnWidth = null;

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

// Column order for left table (customer BOM)
const leftColumns = ['Description', 'MPN', 'Manufacturer', 'Quantity', 'Refdes'];

// ========================================================================
// Page Init
// ========================================================================

async function loadBomData() {
    showLoading();
    try {
        const data = await apiCall('/api/bom-data');
        bomData = data;
        document.getElementById('bomName').textContent = data.name || 'Untitled';
        document.getElementById('bomStats').textContent = `${data.total_rows} rows`;
        renderTables();
        setupSyncScroll();
        window.addEventListener('resize', syncRowHeights);
    } catch (e) {
        toast.error('Failed to load BOM data. Go back and upload a file.');
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Synchronized Scrolling
// ========================================================================

function setupSyncScroll() {
    const leftScroll = document.getElementById('leftScroll');
    const rightScroll = document.getElementById('rightScroll');
    const paramsScroll = document.getElementById('paramsScroll');
    let syncing = false;

    function syncAll(source) {
        if (syncing) return;
        syncing = true;
        const top = source.scrollTop;
        if (source !== leftScroll) leftScroll.scrollTop = top;
        if (source !== rightScroll) rightScroll.scrollTop = top;
        if (paramsScroll && source !== paramsScroll) paramsScroll.scrollTop = top;
        syncing = false;
    }

    leftScroll.addEventListener('scroll', () => syncAll(leftScroll));
    rightScroll.addEventListener('scroll', () => syncAll(rightScroll));
    if (paramsScroll) {
        paramsScroll.addEventListener('scroll', () => syncAll(paramsScroll));
    }
}

// ========================================================================
// Render Tables
// ========================================================================

function renderTables() {
    if (!bomData) return;

    const mapping = bomData.column_mapping || {};
    const rows = bomData.rows || [];

    // Build mapped columns for left table
    const mappedCols = [];
    for (const stdCol of leftColumns) {
        const actualCol = mapping[stdCol];
        if (actualCol) {
            mappedCols.push({ std: stdCol, actual: actualCol });
        }
    }

    const hasMpnfree = Object.keys(mpnfreeResults).length > 0;

    // --- Left Table Header ---
    const leftHead = document.getElementById('leftTableHead');
    let lhHtml = '<tr><th style="width: 36px;">#</th>';
    for (const col of mappedCols) {
        if (col.std === 'Description') {
            lhHtml += `<th class="resizable-th desc-th">${escapeHtml(col.std)}<div class="col-resize-handle" data-col="desc"></div></th>`;
        } else {
            lhHtml += `<th>${escapeHtml(col.std)}</th>`;
        }
    }
    if (hasMpnfree) {
        lhHtml += '<th style="width: 80px;">MPNfree</th>';
    }
    lhHtml += '</tr>';
    leftHead.innerHTML = lhHtml;

    // --- Right Table Header ---
    const rightHead = document.getElementById('rightTableHead');
    rightHead.innerHTML = '<tr><th>FaberNr</th><th>Omschrijving</th><th>Manufacturer</th><th>MPN</th><th>KlantNr</th><th>KlantNaam</th><th>Magazijn</th><th>Mounting</th><th>Type</th><th>Status</th><th>Kostprijs</th><th>Voorraad</th><th>Verbruik</th><th>InBestelling</th></tr>';

    // --- Build body rows ---
    let leftHtml = '';
    let rightHtml = '';

    let matchedCount = 0, partialCount = 0, noMatchCount = 0, paramCount = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const strIdx = String(i);
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
        }

        // Row class for color coding
        let rowClass = '';
        if (deletedRows.has(i)) {
            rowClass = 'row-deleted';
        } else if (confidence === 'high') {
            rowClass = 'row-matched';
            matchedCount++;
        } else if (confidence === 'medium' || confidence === 'low') {
            rowClass = 'row-suggestion';
            partialCount++;
        } else if (match && match.confidence === 'none') {
            rowClass = 'row-nomatch';
            noMatchCount++;
        }

        if (searchMethod === 'parameterized') paramCount++;

        const selClass = selectedRow === i ? ' row-selected' : '';

        // --- Left row ---
        leftHtml += `<tr class="${rowClass}${selClass}" data-row="${i}" onclick="selectRow(${i})">`;
        leftHtml += `<td style="color: var(--text-muted); font-size: 11px;">${i + 1}</td>`;
        for (const col of mappedCols) {
            const cellValue = getMappedValue(row, col.actual);
            // Highlight BOM description for MPNfree rows with parameterized match results
            if (col.std === 'Description' && hasMpnfree && getMpnfreeValue(i) && match && match.auto_selected && match.auto_selected._bom_highlights && match.auto_selected._bom_highlights.length > 0) {
                leftHtml += `<td class="desc-col" title="${escapeHtml(cellValue)}">${applyHighlights(cellValue, match.auto_selected._bom_highlights)}</td>`;
            } else {
                leftHtml += `<td${col.std === 'Description' ? ' class="desc-col"' : ''} title="${escapeHtml(cellValue)}">${escapeHtml(cellValue)}</td>`;
            }
        }
        if (hasMpnfree) {
            leftHtml += `<td>${renderMpnfreeDropdown(i)}</td>`;
        }
        leftHtml += '</tr>';

        // --- Right row ---
        rightHtml += `<tr class="${rowClass}${selClass}" data-row="${i}" onclick="onRightRowClick(${i})">`;

        // Determine which item to display: manually selected suggestion or auto_selected
        let displayItem = null;
        if (sel.fabernr && match && match.suggestions) {
            displayItem = match.suggestions.find(s => s.FaberNr === sel.fabernr);
        }
        if (!displayItem && match && match.auto_selected) {
            displayItem = match.auto_selected;
        }

        if (displayItem) {
            const auto = displayItem;
            const descHtml = renderHighlightedDescription(auto, match);

            rightHtml += `<td style="font-family: var(--font-family-mono); font-size: 11px;">${escapeHtml(fabernr)}</td>`;
            rightHtml += `<td title="${escapeHtml(auto.Omschrijving || '')}">${descHtml}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Manufacturer || '')}</td>`;
            rightHtml += `<td>${renderMpnHighlights(auto, match, row, mapping)}</td>`;
            rightHtml += `<td>${escapeHtml(auto.KlantNr || '')}</td>`;
            rightHtml += `<td>${escapeHtml(auto.KlantNaam || '')}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Magazijn || '')}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Mounting || '')}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Type || '')}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Status || '')}</td>`;
            rightHtml += `<td>${auto.Kostprijs || 0}</td>`;
            rightHtml += `<td>${auto.Voorraad || 0}</td>`;
            rightHtml += `<td>${auto.Verbruik || 0}</td>`;
            rightHtml += `<td>${auto.InBestelling || 0}</td>`;
        } else {
            rightHtml += '<td>\u2014</td><td>\u2014</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>';
        }

        rightHtml += '</tr>';
    }

    document.getElementById('leftTableBody').innerHTML = leftHtml;
    document.getElementById('rightTableBody').innerHTML = rightHtml;

    // Update summary badges
    updateSummaryBadges(matchedCount, partialCount, noMatchCount, paramCount);

    // Sync row heights between left and right tables
    syncRowHeights();

    // Populate params comparison table
    if (typeof populateMatcherParamsTable === 'function') {
        populateMatcherParamsTable();
    }

    // Setup column resize handles
    setupColumnResize();

    // Restore description column width if previously resized
    if (descColumnWidth) {
        applyDescColumnWidth(descColumnWidth);
    }
}

function applyDescColumnWidth(w) {
    const px = w + 'px';
    const leftTh = document.querySelector('#leftTableHead .desc-th');
    if (leftTh) {
        leftTh.style.width = px;
        leftTh.style.minWidth = px;
        leftTh.style.maxWidth = px;
    }
    document.querySelectorAll('#leftTableBody .desc-col').forEach(td => {
        td.style.width = px;
        td.style.minWidth = px;
        td.style.maxWidth = px;
    });
    const rightTh = document.querySelector('#rightTableHead th:nth-child(2)');
    if (rightTh) {
        rightTh.style.width = px;
        rightTh.style.minWidth = px;
        rightTh.style.maxWidth = px;
    }
    document.querySelectorAll('#rightTableBody td:nth-child(2)').forEach(td => {
        td.style.width = px;
        td.style.minWidth = px;
        td.style.maxWidth = px;
    });
}

// ========================================================================
// Sync Row Heights Between Tables
// ========================================================================

function syncRowHeights() {
    const leftRows = document.querySelectorAll('#leftTableBody tr');
    const rightRows = document.querySelectorAll('#rightTableBody tr');
    const paramsRows = document.querySelectorAll('#paramsTableBody tr');
    const count = Math.min(leftRows.length, rightRows.length);

    // Reset heights so natural heights can be measured
    for (let i = 0; i < count; i++) {
        leftRows[i].style.height = '';
        rightRows[i].style.height = '';
        if (paramsRows[i]) paramsRows[i].style.height = '';
    }

    // Set each trio to the max of the three
    for (let i = 0; i < count; i++) {
        let maxH = Math.max(leftRows[i].offsetHeight, rightRows[i].offsetHeight);
        if (paramsRows[i]) maxH = Math.max(maxH, paramsRows[i].offsetHeight);
        leftRows[i].style.height = maxH + 'px';
        rightRows[i].style.height = maxH + 'px';
        if (paramsRows[i]) paramsRows[i].style.height = maxH + 'px';
    }

    // Also sync header rows
    const leftHeadRows = document.querySelectorAll('#leftTableHead tr');
    const rightHeadRows = document.querySelectorAll('#rightTableHead tr');
    const paramsHeadRows = document.querySelectorAll('#paramsTable thead tr');
    if (leftHeadRows.length > 0 && rightHeadRows.length > 0) {
        leftHeadRows[0].style.height = '';
        rightHeadRows[0].style.height = '';
        if (paramsHeadRows[0]) paramsHeadRows[0].style.height = '';
        let maxHeaderH = Math.max(leftHeadRows[0].offsetHeight, rightHeadRows[0].offsetHeight);
        if (paramsHeadRows[0]) maxHeaderH = Math.max(maxHeaderH, paramsHeadRows[0].offsetHeight);
        leftHeadRows[0].style.height = maxHeaderH + 'px';
        rightHeadRows[0].style.height = maxHeaderH + 'px';
        if (paramsHeadRows[0]) paramsHeadRows[0].style.height = maxHeaderH + 'px';
    }
}

// ========================================================================
// Column Resize
// ========================================================================

function setupColumnResize() {
    const handles = document.querySelectorAll('.col-resize-handle');
    handles.forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const th = handle.parentElement;
            const startX = e.pageX;
            const startWidth = th.offsetWidth;

            handle.classList.add('active');

            function onMouseMove(e) {
                const newWidth = Math.max(60, startWidth + (e.pageX - startX));
                descColumnWidth = newWidth;
                th.style.width = newWidth + 'px';
                th.style.minWidth = newWidth + 'px';
                th.style.maxWidth = newWidth + 'px';
                // Also update all desc-col cells in both tables
                document.querySelectorAll('#leftTableBody .desc-col').forEach(td => {
                    td.style.maxWidth = newWidth + 'px';
                    td.style.minWidth = newWidth + 'px';
                    td.style.width = newWidth + 'px';
                });
                // Sync right table Description column (2nd column)
                const rightDescTh = document.querySelector('#rightTableHead th:nth-child(2)');
                if (rightDescTh) {
                    rightDescTh.style.width = newWidth + 'px';
                    rightDescTh.style.minWidth = newWidth + 'px';
                    rightDescTh.style.maxWidth = newWidth + 'px';
                }
                document.querySelectorAll('#rightTableBody td:nth-child(2)').forEach(td => {
                    td.style.maxWidth = newWidth + 'px';
                    td.style.minWidth = newWidth + 'px';
                    td.style.width = newWidth + 'px';
                });
                syncRowHeights();
            }

            function onMouseUp() {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

// ========================================================================
// MPNfree Dropdown Rendering
// ========================================================================

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
    return `<select class="mpnfree-dropdown ${cssClass}" onchange="overrideMpnfree(${rowIndex}, this.value === 'yes')" onclick="event.stopPropagation()">
        <option value="no" ${noSelected}>No</option>
        <option value="yes" ${yesSelected}>Yes</option>
    </select>`;
}

async function overrideMpnfree(rowIndex, value) {
    const strIdx = String(rowIndex);
    if (!selections[strIdx]) selections[strIdx] = {};
    selections[strIdx].mpnfree = value;

    try {
        await apiCall('/api/match/override', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, mpnfree: value })
        });
        renderTables();
    } catch (e) {
        // toast shown
    }
}

// ========================================================================
// Select MPNfree (AI Assessment)
// ========================================================================

async function selectMpnfree() {
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
    if (!desc) return '\u2014';

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
        return `<span class="${hlClass}">${escapeHtml(erpMpn)}</span>`;
    }

    return escapeHtml(erpMpn);
}

function renderScore(suggestion, match) {
    const score = suggestion._similarity_score;
    if (score !== undefined && score !== null) {
        const pct = Math.round(score);
        const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
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
        if (conf === 'high') return '<span style="color: #10b981; font-weight: 600;">Exact</span>';
        if (conf === 'medium') return '<span style="color: #f59e0b;">Partial</span>';
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
// Summary Badges
// ========================================================================

function updateSummaryBadges(matched, partial, noMatch, param) {
    const hasResults = matched + partial + noMatch > 0;
    document.getElementById('summaryBadges').style.display = hasResults ? 'block' : 'none';
    document.getElementById('filterBar').style.display = hasResults ? 'block' : 'none';

    document.getElementById('matchedCount').textContent = matched;
    document.getElementById('partialCount').textContent = partial;
    document.getElementById('noMatchCount').textContent = noMatch;

    if (param > 0) {
        document.getElementById('paramBadge').style.display = 'inline-flex';
        document.getElementById('paramCount').textContent = param;
    }
}

// ========================================================================
// Row Selection — Full-Screen Modal
// ========================================================================

function toggleManualSearch() {
    manualSearchMode = !manualSearchMode;
    const btn = document.getElementById('manualSearchBtn');
    if (btn) {
        btn.textContent = manualSearchMode ? 'Manual search: ON' : 'Manual search: OFF';
        btn.className = manualSearchMode ? 'btn btn-primary' : 'btn btn-outline';
    }
}

function toggleDeleteMode() {
    deleteMode = !deleteMode;
    const btn = document.getElementById('deleteModeBtn');
    if (btn) {
        btn.textContent = deleteMode ? 'Delete: ON' : 'Delete: OFF';
        btn.className = deleteMode ? 'btn btn-danger' : 'btn btn-outline';
    }
}

function onRightRowClick(rowIndex) {
    if (deleteMode) {
        deleteMatch(rowIndex);
    } else {
        selectRow(rowIndex);
    }
}

async function deleteMatch(rowIndex) {
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
}

function selectRow(rowIndex) {
    selectedRow = rowIndex;
    renderTables();
    scrollSelectedRowIntoView();
    if (!manualSearchMode) {
        showRowDetailModal(rowIndex);
    }
}

function openSelectedRowModal() {
    if (selectedRow !== null) {
        showRowDetailModal(selectedRow);
    }
}

function scrollSelectedRowIntoView() {
    if (selectedRow === null) return;
    const leftRow = document.querySelector(`#leftTableBody tr[data-row="${selectedRow}"]`);
    if (leftRow) {
        leftRow.scrollIntoView({ block: 'nearest' });
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
    const hasMpnfree = Object.keys(mpnfreeResults).length > 0;

    // Build left side: customer BOM details
    const mappedCols = [];
    for (const stdCol of leftColumns) {
        const actualCol = mapping[stdCol];
        if (actualCol) {
            mappedCols.push({ std: stdCol, actual: actualCol });
        }
    }

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
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center;">
            <h3 class="modal-title">Row ${rowIndex + 1} Details</h3>
            <button class="btn btn-outline btn-sm" onclick="closeRowDetailModal()">Close</button>
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
    { key: 'KlantNr', label: 'KlantNr' },
    { key: 'KlantNaam', label: 'KlantNaam' },
    { key: 'Magazijn', label: 'Magazijn' },
    { key: 'Mounting', label: 'Mounting' },
    { key: 'Type', label: 'Type' },
    { key: 'Status', label: 'Status' },
    { key: 'Kostprijs', label: 'Kostprijs', numeric: true },
    { key: 'Voorraad', label: 'Voorraad', numeric: true },
    { key: 'Verbruik', label: 'Verbruik', numeric: true },
    { key: 'InBestelling', label: 'InBestelling', numeric: true },
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
        const arrow = modalSortColumn === col.key ? (modalSortAsc ? ' \u25B2' : ' \u25BC') : '';
        html += `<th style="cursor:pointer; user-select:none;" onclick="sortModalTable('${col.key}')">${col.label}${arrow}</th>`;
    }
    html += '<th></th></tr></thead><tbody>';

    for (const s of sorted) {
        const descHtml = s._param_highlights && s._param_highlights.length > 0
            ? applyHighlights(s.Omschrijving || '', s._param_highlights)
            : escapeHtml(s.Omschrijving || '');
        const fabernr = escapeHtml(s.FaberNr || '');

        html += `<tr>
            <td><strong>${fabernr}</strong></td>
            <td title="${escapeHtml(s.Omschrijving || '')}">${descHtml}</td>
            <td>${escapeHtml(s.Manufacturer || '')}</td>
            <td><span class="mpn-clickable" title="Click: Copy | Ctrl+Click: Google | Alt+Click: DigiKey">${escapeHtml(s.MPN || '')}</span></td>
            <td>${escapeHtml(s.KlantNr || '')}</td>
            <td>${escapeHtml(s.KlantNaam || '')}</td>
            <td>${escapeHtml(s.Magazijn || '')}</td>
            <td>${escapeHtml(s.Mounting || '')}</td>
            <td>${escapeHtml(s.Type || '')}</td>
            <td>${escapeHtml(s.Status || '')}</td>
            <td>${s.Kostprijs || 0}</td>
            <td>${s.Voorraad || 0}</td>
            <td>${s.Verbruik || 0}</td>
            <td>${s.InBestelling || 0}</td>
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
        }, 300);
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

function filterTable() {
    const searchText = (document.getElementById('searchInput').value || '').toLowerCase();
    const statusFilter = document.getElementById('statusFilter').value;

    const leftRows = document.querySelectorAll('#leftTableBody tr');
    const rightRows = document.querySelectorAll('#rightTableBody tr');
    const paramsRows = document.querySelectorAll('#paramsTableBody tr');

    for (let i = 0; i < leftRows.length; i++) {
        const leftRow = leftRows[i];
        const rightRow = rightRows[i];
        const rowIdx = leftRow.dataset.row;

        let show = true;

        // Text search
        if (searchText) {
            const leftText = leftRow.textContent.toLowerCase();
            const rightText = rightRow.textContent.toLowerCase();
            show = leftText.includes(searchText) || rightText.includes(searchText);
        }

        // Status filter
        if (show && statusFilter !== 'all') {
            const match = matchResults[rowIdx];
            const confidence = match ? match.confidence : 'none';
            if (statusFilter === 'matched' && confidence !== 'high') show = false;
            if (statusFilter === 'partial' && confidence !== 'medium' && confidence !== 'low') show = false;
            if (statusFilter === 'nomatch' && confidence !== 'none') show = false;
        }

        leftRow.style.display = show ? '' : 'none';
        rightRow.style.display = show ? '' : 'none';
        if (paramsRows[i]) paramsRows[i].style.display = show ? '' : 'none';
    }
}

// ========================================================================
// Find IPN (Batch)
// ========================================================================

async function findIpn() {
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
    const strIdx = String(rowIndex);
    if (!selections[strIdx]) selections[strIdx] = {};
    selections[strIdx].fabernr = value;

    try {
        await apiCall('/api/match/override', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, fabernr: value })
        });
        renderTables();
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

document.addEventListener('keydown', (e) => {
    // Only handle arrow keys when no modal is open and manual search is on
    if (activeModal) return;
    if (!manualSearchMode) return;
    if (!bomData || !bomData.rows) return;

    const totalRows = bomData.rows.length;
    if (totalRows === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectedRow === null) {
            selectedRow = 0;
        } else {
            // Find next visible row
            const leftRows = document.querySelectorAll('#leftTableBody tr');
            let found = false;
            for (let i = selectedRow + 1; i < totalRows; i++) {
                const tr = leftRows[i];
                if (tr && tr.style.display !== 'none') {
                    selectedRow = i;
                    found = true;
                    break;
                }
            }
            if (!found) return;
        }
        renderTables();
        scrollSelectedRowIntoView();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectedRow === null) return;
        const leftRows = document.querySelectorAll('#leftTableBody tr');
        for (let i = selectedRow - 1; i >= 0; i--) {
            const tr = leftRows[i];
            if (tr && tr.style.display !== 'none') {
                selectedRow = i;
                renderTables();
                scrollSelectedRowIntoView();
                break;
            }
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        openSelectedRowModal();
    }
});

// ========================================================================
// Init
// ========================================================================

loadBomData();
