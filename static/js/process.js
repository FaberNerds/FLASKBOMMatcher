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
    let syncing = false;

    leftScroll.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        rightScroll.scrollTop = leftScroll.scrollTop;
        syncing = false;
    });

    rightScroll.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        leftScroll.scrollTop = rightScroll.scrollTop;
        syncing = false;
    });
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
        lhHtml += `<th>${escapeHtml(col.std)}</th>`;
    }
    if (hasMpnfree) {
        lhHtml += '<th style="width: 80px;">MPNfree</th>';
    }
    lhHtml += '</tr>';
    leftHead.innerHTML = lhHtml;

    // --- Right Table Header ---
    const rightHead = document.getElementById('rightTableHead');
    rightHead.innerHTML = '<tr><th>Faber IPN</th><th>Description</th><th>Manufacturer</th><th>MPN</th><th>Score</th></tr>';

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
        if (confidence === 'high') {
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
            leftHtml += `<td title="${escapeHtml(row[col.actual] || '')}">${escapeHtml(row[col.actual] || '')}</td>`;
        }
        if (hasMpnfree) {
            leftHtml += `<td>${renderMpnfreeDropdown(i)}</td>`;
        }
        leftHtml += '</tr>';

        // --- Right row ---
        rightHtml += `<tr class="${rowClass}${selClass}" data-row="${i}" onclick="selectRow(${i})">`;

        if (match && match.auto_selected) {
            const auto = match.auto_selected;
            const descHtml = renderHighlightedDescription(auto, match);

            rightHtml += `<td style="font-family: var(--font-family-mono); font-size: 11px;">${escapeHtml(fabernr)}</td>`;
            rightHtml += `<td title="${escapeHtml(auto.Omschrijving || '')}">${descHtml}</td>`;
            rightHtml += `<td>${escapeHtml(auto.Manufacturer || '')}</td>`;
            rightHtml += `<td>${renderMpnHighlights(auto, match, row, mapping)}</td>`;
            rightHtml += `<td>${renderScore(auto, match)}</td>`;
        } else {
            rightHtml += '<td>\u2014</td><td>\u2014</td><td></td><td></td><td></td>';
        }

        rightHtml += '</tr>';
    }

    document.getElementById('leftTableBody').innerHTML = leftHtml;
    document.getElementById('rightTableBody').innerHTML = rightHtml;

    // Update summary badges
    updateSummaryBadges(matchedCount, partialCount, noMatchCount, paramCount);
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
    const mpnCol = mapping.MPN || '';
    const customerMpn = customerRow[mpnCol] || '';
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

function selectRow(rowIndex) {
    selectedRow = rowIndex;
    renderTables();
    showRowDetailModal(rowIndex);
}

function showRowDetailModal(rowIndex) {
    if (!bomData) return;

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
        const val = row[col.actual] || '';
        leftHtml += `<div class="row-detail-field">
            <div class="row-detail-field-label">${escapeHtml(col.std)}</div>
            <div class="row-detail-field-value">${escapeHtml(val)}</div>
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
                    <option value="description">Description</option>
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

function buildAlternativesTable(suggestions, rowIndex) {
    if (!suggestions || suggestions.length === 0) {
        return '<div style="padding: 24px; text-align: center; color: var(--text-muted);">No matches found. Use manual search below.</div>';
    }

    let html = '<table class="data-table"><thead><tr>';
    html += '<th>FaberNr</th><th>Description</th><th>Manufacturer</th><th>MPN</th><th>Status</th><th>Stock</th><th>Score</th><th></th>';
    html += '</tr></thead><tbody>';

    for (const s of suggestions) {
        const score = s._similarity_score;
        const scoreHtml = score !== undefined ? `${Math.round(score)}%` : '';
        const descHtml = s._param_highlights && s._param_highlights.length > 0
            ? applyHighlights(s.Omschrijving || '', s._param_highlights)
            : escapeHtml(s.Omschrijving || '');
        const fabernr = escapeHtml(s.FaberNr || '');

        html += `<tr>
            <td><strong>${fabernr}</strong></td>
            <td title="${escapeHtml(s.Omschrijving || '')}">${descHtml}</td>
            <td>${escapeHtml(s.Manufacturer || '')}</td>
            <td>${escapeHtml(s.MPN || '')}</td>
            <td>${escapeHtml(s.Status || '')}</td>
            <td>${s.Voorraad || 0}</td>
            <td>${scoreHtml}</td>
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
// Init
// ========================================================================

loadBomData();
