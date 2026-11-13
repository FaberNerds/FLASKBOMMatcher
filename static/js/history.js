/**
 * BOM Matcher - History Page JavaScript
 * Lists previously processed BOMs and allows loading or deleting them.
 */

async function loadHistory() {
    showLoading();
    try {
        const data = await apiCall('/api/history', { method: 'GET' });
        renderHistory(data.entries || []);
    } catch (e) {
        // toast shown by apiCall
    } finally {
        hideLoading();
    }
}

function renderHistory(entries) {
    const tbody = document.getElementById('historyBody');
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No history entries yet. Process a BOM to see it here.</td></tr>';
        return;
    }

    tbody.innerHTML = entries.map(e => {
        const date = new Date(e.saved_at);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const badges = [];
        if (e.has_matches) badges.push('<span class="badge badge-success">Matched</span>');
        if (e.has_mpnfree) badges.push('<span class="badge badge-info">MPNfree</span>');
        if (e.has_selections) badges.push('<span class="badge badge-warning">Selections</span>');

        const sessionId = escapeHtml(e.session_id);
        return `<tr>
            <td class="cell-name">${escapeHtml(e.bom_name)}</td>
            <td class="fx-mono">${escapeHtml(e.klant_nr || '-')}</td>
            <td class="num">${e.row_count || '-'}</td>
            <td><span class="badge-row">${badges.join(' ') || '<span class="badge badge-gray">New</span>'}</span></td>
            <td class="fx-mono cell-date">${dateStr}</td>
            <td class="col-actions">
                <button class="btn btn-primary btn-small" onclick="loadEntry('${sessionId}')">Load</button>
                <button class="btn btn-danger btn-small" onclick="deleteEntry('${sessionId}')">Delete</button>
            </td>
        </tr>`;
    }).join('');
}

async function loadEntry(sessionId) {
    showLoading();
    try {
        await apiCall('/api/history/load', {
            method: 'POST',
            body: JSON.stringify({ session_id: sessionId })
        });
        window.location.href = '/process';
    } catch (e) {
        hideLoading();
    }
}

async function deleteEntry(sessionId) {
    if (!confirm('Delete this history entry? This cannot be undone.')) return;
    try {
        await apiCall('/api/history/delete', {
            method: 'POST',
            body: JSON.stringify({ session_id: sessionId })
        });
        // Clear cached process-page client state so it can't resurrect old UI after a delete.
        sessionStorage.removeItem('processUiState');
        sessionStorage.removeItem('processBomName');
        toast.success('History entry deleted');
        loadHistory();
    } catch (e) {
        // toast shown by apiCall
    }
}

loadHistory();
