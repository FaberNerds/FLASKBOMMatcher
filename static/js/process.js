/**
 * BOM Matcher - Process Page JavaScript
 * Handles BOM table rendering, IPN search, MPNfree assessment, suggestions, overrides, and export.
 */

let bomData = null;
let matchResults = {};
let mpnfreeResults = {};
let selections = {};

// Column order for display
const displayColumns = ['Manufacturer', 'MPN', 'Description', 'Quantity', 'Refdes'];

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
        renderBomTable();
    } catch (e) {
        toast.error('Failed to load BOM data. Go back and upload a file.');
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Render BOM Table
// ========================================================================

function renderBomTable() {
    if (!bomData) return;

    const mapping = bomData.column_mapping || {};
    const rows = bomData.rows || [];

    // Build header
    const mappedCols = [];
    for (const stdCol of displayColumns) {
        const actualCol = mapping[stdCol];
        if (actualCol) {
            mappedCols.push({ std: stdCol, actual: actualCol });
        }
    }

    const thead = document.getElementById('bomTableHead');
    let headerHtml = '<tr>';
    headerHtml += '<th style="width: 40px;">#</th>';
    for (const col of mappedCols) {
        headerHtml += `<th>${escapeHtml(col.std)}</th>`;
    }
    headerHtml += '<th style="min-width: 90px;">MPNfree?</th>';
    headerHtml += '<th style="min-width: 120px;">FaberNr (IPN)</th>';
    headerHtml += '<th style="width: 80px;">Actions</th>';
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;

    // Build body
    const tbody = document.getElementById('bomTableBody');
    let bodyHtml = '';

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const strIdx = String(i);
        const match = matchResults[strIdx];
        const mpnfree = mpnfreeResults[strIdx];
        const sel = selections[strIdx] || {};

        // Determine FaberNr
        let fabernr = '';
        let confidence = 'none';
        if (sel.fabernr) {
            fabernr = sel.fabernr;
            confidence = 'high';
        } else if (match && match.auto_selected) {
            fabernr = match.auto_selected.FaberNr || '';
            confidence = match.confidence || 'none';
        }

        // Determine MPNfree
        let isMpnfree = null;
        if (sel.mpnfree !== undefined && sel.mpnfree !== null) {
            isMpnfree = sel.mpnfree;
        } else if (mpnfree) {
            isMpnfree = mpnfree.mpnfree || false;
        }

        // Row class for color coding
        let rowClass = '';
        if (isMpnfree === true) {
            rowClass = 'row-mpnfree';
        } else if (confidence === 'high') {
            rowClass = 'row-matched';
        } else if (confidence === 'medium' || confidence === 'low') {
            rowClass = 'row-suggestion';
        } else if (match && match.confidence === 'none') {
            rowClass = 'row-nomatch';
        }

        bodyHtml += `<tr class="${rowClass}" data-row="${i}">`;
        bodyHtml += `<td style="color: var(--text-muted);">${i + 1}</td>`;

        for (const col of mappedCols) {
            bodyHtml += `<td>${escapeHtml(row[col.actual] || '')}</td>`;
        }

        // MPNfree cell
        const mpnfreeValue = isMpnfree === true ? 'Yes' : (isMpnfree === false ? 'No' : '');
        const mpnfreeTitle = mpnfree && mpnfree.reason ? mpnfree.reason : '';
        bodyHtml += `<td>
            <select class="mpnfree-select" data-row="${i}" title="${escapeHtml(mpnfreeTitle)}"
                    onchange="overrideMpnfree(${i}, this.value)">
                <option value=""${mpnfreeValue === '' ? ' selected' : ''}></option>
                <option value="yes"${mpnfreeValue === 'Yes' ? ' selected' : ''}>Yes</option>
                <option value="no"${mpnfreeValue === 'No' ? ' selected' : ''}>No</option>
            </select>
        </td>`;

        // FaberNr cell
        const suggestionCount = match ? (match.suggestions || []).length : 0;
        bodyHtml += `<td>
            <div style="display: flex; align-items: center; gap: 4px;">
                <input type="text" class="fabernr-input" value="${escapeHtml(fabernr)}"
                       data-row="${i}" placeholder="—"
                       onchange="overrideFabernr(${i}, this.value)"
                       style="width: 90px; padding: 2px 6px; font-size: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                ${suggestionCount > 0 ? `<button class="btn-icon" onclick="showSuggestions(${i})" title="${suggestionCount} suggestions">▼</button>` : ''}
            </div>
        </td>`;

        // Actions
        bodyHtml += `<td>
            <button class="btn-icon" onclick="researchRow(${i})" title="Re-search">🔍</button>
        </td>`;

        bodyHtml += '</tr>';
    }

    tbody.innerHTML = bodyHtml;
}

// ========================================================================
// Find IPN (Batch)
// ========================================================================

async function findIpn() {
    showLoading();
    try {
        const data = await apiCall('/api/match/find-ipn', { method: 'POST' });
        // Convert results array to dict keyed by row_index
        if (data.results) {
            matchResults = {};
            for (const r of data.results) {
                matchResults[String(r.row_index)] = r;
            }
        }
        renderBomTable();
        toast.success(`Found matches: ${data.matched}/${data.total} rows`);
    } catch (e) {
        // toast shown
    } finally {
        hideLoading();
    }
}

// ========================================================================
// MPNfree Assessment
// ========================================================================

async function assessMpnfree() {
    showLoading();
    try {
        const data = await apiCall('/api/match/mpnfree', { method: 'POST' });
        if (data.results) {
            mpnfreeResults = {};
            for (const r of data.results) {
                mpnfreeResults[String(r.index)] = r;
            }
        }
        renderBomTable();
        toast.success(`MPNfree: ${data.mpnfree_count}/${data.total} rows`);
    } catch (e) {
        // toast shown
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Single Row Re-search
// ========================================================================

async function researchRow(rowIndex) {
    try {
        const data = await apiCall('/api/match/find-ipn-single', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex })
        });
        if (data.result) {
            matchResults[String(rowIndex)] = data.result;
            renderBomTable();
            if (data.result.suggestions && data.result.suggestions.length > 0) {
                showSuggestions(rowIndex);
            }
        }
    } catch (e) {
        // toast shown
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
        renderBomTable();
    } catch (e) {
        // toast shown
    }
}

async function overrideMpnfree(rowIndex, value) {
    const strIdx = String(rowIndex);
    if (!selections[strIdx]) selections[strIdx] = {};

    let mpnfree = null;
    if (value === 'yes') mpnfree = true;
    else if (value === 'no') mpnfree = false;
    selections[strIdx].mpnfree = mpnfree;

    try {
        await apiCall('/api/match/override', {
            method: 'POST',
            body: JSON.stringify({ row_index: rowIndex, mpnfree: mpnfree })
        });
        renderBomTable();
    } catch (e) {
        // toast shown
    }
}

// ========================================================================
// Suggestion Panel
// ========================================================================

function showSuggestions(rowIndex) {
    const strIdx = String(rowIndex);
    const match = matchResults[strIdx];
    if (!match || !match.suggestions || match.suggestions.length === 0) {
        toast.info('No suggestions available');
        return;
    }

    document.getElementById('suggestionRowIdx').textContent = String(rowIndex + 1);

    const tbody = document.getElementById('suggestionBody');
    tbody.innerHTML = match.suggestions.map(s => `
        <tr>
            <td><strong>${escapeHtml(s.FaberNr || '')}</strong></td>
            <td>${escapeHtml(s.Omschrijving || '')}</td>
            <td>${escapeHtml(s.Manufacturer || '')}</td>
            <td>${escapeHtml(s.MPN || '')}</td>
            <td>${escapeHtml(s.Status || '')}</td>
            <td>${s.Voorraad || 0}</td>
            <td><button class="btn btn-primary btn-sm" onclick="selectSuggestion(${rowIndex}, '${escapeHtml(s.FaberNr || '')}')">Select</button></td>
        </tr>
    `).join('');

    document.getElementById('suggestionPanel').style.display = 'block';
}

function closeSuggestionPanel() {
    document.getElementById('suggestionPanel').style.display = 'none';
}

function selectSuggestion(rowIndex, fabernr) {
    overrideFabernr(rowIndex, fabernr);
    closeSuggestionPanel();
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

        // Download the file
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
