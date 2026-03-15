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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No history entries yet. Process a BOM to see it here.</td></tr>';
        return;
    }

    tbody.innerHTML = entries.map(e => {
        const date = new Date(e.saved_at);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const badges = [];
        if (e.has_matches) badges.push('<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; background:var(--color-success-light); color:var(--color-success);">Matched</span>');
        if (e.has_mpnfree) badges.push('<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; background:var(--color-info-light, #e0f2fe); color:var(--color-info, #0284c7);">MPNfree</span>');
        if (e.has_selections) badges.push('<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; background:var(--color-warning-light, #fef3c7); color:var(--color-warning, #d97706);">Selections</span>');

        const sessionId = escapeHtml(e.session_id);
        return `<tr>
            <td><strong>${escapeHtml(e.bom_name)}</strong></td>
            <td>${escapeHtml(e.klant_nr || '-')}</td>
            <td>${e.row_count || '-'}</td>
            <td>${badges.join(' ') || '<span style="color:var(--text-muted);">New</span>'}</td>
            <td>${dateStr}</td>
            <td>
                <button class="btn btn-primary" style="padding:4px 12px; font-size:12px;" onclick="loadEntry('${sessionId}')">Load</button>
                <button class="btn btn-outline" style="padding:4px 12px; font-size:12px; margin-left:4px;" onclick="deleteEntry('${sessionId}')">Delete</button>
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
        toast.success('History entry deleted');
        loadHistory();
    } catch (e) {
        // toast shown by apiCall
    }
}

loadHistory();
