/**
 * BOM Matcher - Upload Page JavaScript
 * The page is a stepper in three steps: 1 Load file, 2 Rows, 3 Map and match.
 * Handles file upload, sheet/header selection, row range, column mapping, customer,
 * the previous version from Exact, and navigation to the Process page.
 */

const standardColumns = ['Manufacturer', 'MPN', 'Description', 'Quantity', 'Refdes'];
let currentHeaders = [];
let currentRows = [];

// Customer selection state
let allKlanten = [];
let selectedKlantNr = '';
let selectedKlantNaam = '';

// Row selection state
let selectedHeaderRow = 0;    // 0-indexed row used as header
let rowRange = { start: null, end: null };  // 0-indexed data row range (after header)
// The server returns rows[start_row:] when a range was sent: the first loaded row is data row
// loadedRowOffset. Display index + loadedRowOffset = data row index (the one rowRange uses).
let loadedRowOffset = 0;

// Context menu state
let contextMenuRowIndex = null;

// Stepper state
let fileLoaded = false;
let openStep = 1;
let currentFileName = '';
let totalRows = 0;
let sheetList = [];
let currentSheet = null;      // null: the sheet the server reads by default (the active sheet)
let previousBom = null;       // { article_id, description, count } when a previous version is loaded

const MAP_PREVIEW_ROWS = 12;
const CHEVRON_SVG = '<svg class="fx-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

// ========================================================================
// Stepper
// ========================================================================

/** Row number as in the sheet (1-indexed) for a 0-indexed data row. */
function sheetRowOf(dataIndex) {
    return selectedHeaderRow + 2 + dataIndex;
}

function isDescriptionMapped() {
    return !!document.querySelector('.mapping-multiselect[data-standard="Description"] input[type="checkbox"]:checked');
}

function mappedFieldCount() {
    return Array.from(document.querySelectorAll('.mapping-multiselect'))
        .filter(ms => ms.querySelector('input[type="checkbox"]:checked')).length;
}

/** 'todo', 'ready' or 'warn' for step n. */
function stepStatus(n) {
    if (!fileLoaded) return 'todo';
    if (n === 3 && !isDescriptionMapped()) return 'warn';
    return 'ready';
}

const STATUS_BADGE = {
    todo: { cls: 'badge badge-gray', text: 'To do' },
    ready: { cls: 'badge badge-success', text: '✓ Ready' },
    warn: { cls: 'badge badge-warning', text: '⚠ Description not mapped' },
};

function rangeText() {
    if (rowRange.start === null && rowRange.end === null) return 'All';
    const s = rowRange.start !== null ? sheetRowOf(rowRange.start) : sheetRowOf(0);
    const e = rowRange.end !== null ? sheetRowOf(rowRange.end) : 'end';
    return `${s}–${e}`;
}

function showStep(n) {
    if (n > 1 && !fileLoaded) return;
    openStep = n;
    document.querySelectorAll('.up-step').forEach(s => {
        s.classList.toggle('is-open', s.id === 'step' + n);
    });
    hideRowContextMenu();
    refreshUploadUi();
    const section = document.getElementById('step' + n);
    if (section && section.getBoundingClientRect().top < 0) {
        section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
}

document.querySelectorAll('.up-stepbtn').forEach(b => {
    b.addEventListener('click', () => showStep(+b.dataset.step));
});
document.querySelectorAll('[data-go]').forEach(b => {
    b.addEventListener('click', () => showStep(+b.dataset.go));
});

/** Redraw everything that depends on the state: stepper, status, summaries, mapped preview. */
function refreshUploadUi() {
    const page = document.getElementById('uploadPage');
    if (page) page.dataset.fileLoaded = fileLoaded ? 'true' : 'false';

    const mapped = mappedFieldCount();

    for (let n = 1; n <= 3; n++) {
        const status = stepStatus(n);
        const section = document.getElementById('step' + n);
        if (section) section.classList.toggle('is-todo', status === 'todo');

        document.querySelectorAll(`[data-status="${n}"]`).forEach(b => {
            b.className = STATUS_BADGE[status].cls;
            b.textContent = STATUS_BADGE[status].text;
        });

        const btn = document.getElementById('stepBtn' + n);
        if (btn) {
            btn.disabled = n > 1 && !fileLoaded;
            if (n === openStep) btn.setAttribute('aria-current', 'step');
            else btn.removeAttribute('aria-current');
        }
        const numCls = status === 'ready' ? 'is-done' : (status === 'warn' ? 'is-warn' : 'is-todo');
        const num = document.querySelector(`[data-num="${n}"]`);
        if (num) num.className = 'up-num ' + (n === openStep ? 'is-current' : numCls);
        const sumNum = document.querySelector(`[data-num-sum="${n}"]`);
        if (sumNum) sumNum.className = 'up-num ' + numCls;
        const sr = document.querySelector(`[data-sr-state="${n}"]`);
        if (sr) sr.textContent = status === 'ready' ? ', ready' : (status === 'warn' ? ', needs attention' : ', to do');
    }
    setText('stepNow', openStep);

    // Step 1: file
    setText('stepSub1', fileLoaded ? currentFileName : 'No file loaded');
    setText('sumFileName', currentFileName);
    setText('sumSheet', currentSheet || (sheetList.length > 1 ? 'Active sheet' : (sheetList[0] || '—')));
    setText('sumRows', fileLoaded ? totalRows : '—');
    setText('sumSheets', sheetList.length || 1);
    const sheetsFact = document.getElementById('sumSheetsFact');
    if (sheetsFact) sheetsFact.hidden = sheetList.length <= 1;
    const sheetFact = document.getElementById('sumSheetFact');
    if (sheetFact) sheetFact.hidden = fileLoaded && sheetList.length === 0;   // CSV: no sheets
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
        dropZone.classList.toggle('has-file', fileLoaded);
        dropZone.setAttribute('aria-label', fileLoaded ? 'Choose another BOM file' : 'Choose a BOM file');
    }
    const step1Actions = document.getElementById('step1Actions');
    if (step1Actions) step1Actions.hidden = !fileLoaded;

    // Step 2: rows
    const headText = selectedHeaderRow + 1;
    const range = rangeText();
    setText('stepSub2', fileLoaded
        ? `Header row ${headText} · ${range === 'All' ? 'all rows' : 'rows ' + range}`
        : 'To do');
    setText('sumHead', fileLoaded ? headText : '—');
    setText('sumRange', fileLoaded ? range : '—');
    const headerInput = document.getElementById('headerRowInput');
    if (headerInput && document.activeElement !== headerInput) headerInput.value = fileLoaded ? headText : '';

    // Step 3: map and match
    let sub3 = 'To do';
    if (fileLoaded) {
        sub3 = `${mapped} of ${standardColumns.length} fields`;
        if (!isDescriptionMapped()) sub3 = '⚠ Description not mapped · ' + sub3;
        if (selectedKlantNr) sub3 += ` · Klant ${selectedKlantNr}`;
        if (previousBom) sub3 += ` · vs ${previousBom.article_id}`;
    }
    setText('stepSub3', sub3);
    setText('sumFields', fileLoaded ? `${mapped} of ${standardColumns.length}` : '—');
    setText('sumKlant', selectedKlantNr || '—');
    const against = document.getElementById('sumAgainst');
    if (against) {
        against.textContent = previousBom ? previousBom.article_id : 'Live ERP catalog';
        against.classList.toggle('is-text', !previousBom);
    }

    renderMapPreview();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/** Show the loaded file (upload, re-upload or back navigation) and open the right step. */
function setFileLoaded(data, step) {
    fileLoaded = true;
    currentFileName = data.filename || '';
    totalRows = data.total_rows || 0;
    sheetList = Array.isArray(data.sheets) ? data.sheets : [];

    document.getElementById('fileName').textContent = currentFileName;
    updateRowCountText();
    renderSheetSelector();

    if (step) {
        showStep(step);
    } else {
        refreshUploadUi();
    }
}

function updateRowCountText() {
    setText('fileRowCount', `${totalRows} rows`);
    setText('fileSheetCount', sheetList.length > 1 ? ` · ${sheetList.length} sheets` : '');
}

// ========================================================================
// Drop Zone
// ========================================================================

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        uploadFile(e.dataTransfer.files[0]);
    }
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        uploadFile(e.target.files[0]);
    }
    // Allow choosing the same file again
    fileInput.value = '';
});

// ========================================================================
// File Upload
// ========================================================================

async function uploadFile(file) {
    showLoading();
    const formData = new FormData();
    formData.append('file', file);

    try {
        const csrfToken = getCsrfToken();
        const headers = {};
        if (csrfToken) headers['X-CSRFToken'] = csrfToken;

        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
            headers
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');

        currentHeaders = data.headers;
        currentRows = data.preview_rows;
        loadedRowOffset = 0;

        // Reset row selection state
        selectedHeaderRow = 0;
        rowRange = { start: null, end: null };
        currentSheet = null;

        // Show file info and the sheet choice
        setFileLoaded(data);
        clearRowRangeInputs();

        // Check if we have previous settings to restore
        const prev = data.previous_settings;
        if (prev && prev.header_row != null && prev.header_row !== 0) {
            // Restore header row, sheet, and row range before rendering
            selectedHeaderRow = prev.header_row;
            if (prev.sheet_name) setSheet(prev.sheet_name);
            rowRange = {
                start: prev.start_row != null ? prev.start_row : null,
                end: prev.end_row != null ? prev.end_row : null,
            };
            updateRowRangeInputs();

            // Reload with restored header/sheet/range, then apply mapping
            await reloadFile();
            renderMapping();
            if (prev.column_mapping) applyStoredMapping(prev.column_mapping);
        } else if (prev) {
            // Header row is 0 (default) - restore sheet and range
            if (prev.sheet_name) setSheet(prev.sheet_name);
            rowRange = {
                start: prev.start_row != null ? prev.start_row : null,
                end: prev.end_row != null ? prev.end_row : null,
            };
            updateRowRangeInputs();

            // Reload if sheet or range changed from defaults
            if (prev.sheet_name || prev.start_row != null || prev.end_row != null) {
                await reloadFile();
            } else {
                renderPreview();
            }
            renderMapping();
            if (prev.column_mapping) applyStoredMapping(prev.column_mapping);
        } else {
            renderPreview();
            renderMapping();
        }

        // Restore a previously fetched previous-version BOM (if any)
        restorePreviousBom();

        // Restore customer selection if previous settings exist
        if (prev && prev.klant_nr) {
            await restoreCustomer(prev.klant_nr);
        }

        // Show clear button if process data exists from a previous session
        showClearProcessDataBtn(!!data.has_process_data);

        // Restored settings: straight to mapping. A workbook with several sheets: choose the sheet first.
        showStep(prev ? 3 : (sheetList.length > 1 ? 1 : 2));

        if (prev) {
            toast.success(`Restored previous settings for ${data.filename}`);
        } else {
            toast.success(`Uploaded ${data.filename}`);
        }
    } catch (error) {
        toast.error(error.message);
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Sheet & Header Row Changes
// ========================================================================

function renderSheetSelector() {
    const wrap = document.getElementById('sheetSelector');
    const seg = document.getElementById('sheetSeg');
    if (!wrap || !seg) return;
    if (sheetList.length <= 1) {
        wrap.hidden = true;
        seg.innerHTML = '';
        return;
    }
    wrap.hidden = false;
    seg.innerHTML = sheetList.map(s => {
        const on = s === currentSheet;
        return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on || (!currentSheet && s === sheetList[0]) ? 0 : -1}" data-sheet="${escapeHtml(s)}">${escapeHtml(s)}</button>`;
    }).join('');
    setText('sheetHint', currentSheet
        ? 'Changing the sheet reads the file again.'
        : 'Showing the sheet that was open when the file was saved. Pick a sheet to switch.');
}

/** Set the chosen sheet without reloading (used when restoring settings). */
function setSheet(name) {
    currentSheet = sheetList.includes(name) ? name : currentSheet;
    renderSheetSelector();
}

document.getElementById('sheetSeg')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sheet]');
    if (!btn || btn.dataset.sheet === currentSheet) return;
    currentSheet = btn.dataset.sheet;
    renderSheetSelector();
    document.querySelector(`#sheetSeg [data-sheet="${CSS.escape(currentSheet)}"]`)?.focus();
    reloadFile();
});

document.getElementById('sheetSeg')?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const buttons = Array.from(document.querySelectorAll('#sheetSeg [data-sheet]'));
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const step = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
    buttons[(i + step + buttons.length) % buttons.length].click();
});

async function reloadFile() {
    const headerRow = selectedHeaderRow;
    const sheetName = currentSheet;

    // Get start/end row from state (not inputs - those are display values)
    const startRow = rowRange.start;
    const endRow = rowRange.end;

    showLoading();
    try {
        const body = { header_row: headerRow, sheet_name: sheetName };
        if (startRow !== null) body.start_row = startRow;
        if (endRow !== null) body.end_row = endRow;

        const data = await apiCall('/api/reload', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        currentHeaders = data.headers;
        currentRows = data.preview_rows;
        loadedRowOffset = startRow !== null ? startRow : 0;
        totalRows = data.total_rows;
        updateRowCountText();

        renderPreview();
        renderMapping();
    } catch (e) {
        // toast shown by apiCall
    } finally {
        hideLoading();
    }
}

async function setHeaderRowFromInput() {
    const input = document.getElementById('headerRowInput');
    const val = input && input.value ? parseInt(input.value, 10) : NaN;
    if (!fileLoaded || isNaN(val)) {
        refreshUploadUi();
        return;
    }
    if (val < 1) {
        toast.warning('The header row is row 1 or lower in the sheet');
        refreshUploadUi();
        return;
    }
    const newHeaderRow = val - 1;
    if (newHeaderRow === selectedHeaderRow) return;

    selectedHeaderRow = newHeaderRow;
    // Reset row range when header changes
    rowRange = { start: null, end: null };
    clearRowRangeInputs();
    await reloadFile();
    toast.success(`Row ${newHeaderRow + 1} set as header row`);
}

document.getElementById('headerRowInput')?.addEventListener('change', setHeaderRowFromInput);

// ========================================================================
// Preview Table, step 2 (row numbers, range status, right-click menu)
// ========================================================================

function renderPreview() {
    const thead = document.getElementById('previewHead');
    const tbody = document.getElementById('previewBody');

    // Header: the header row itself, then the column names
    thead.innerHTML = '<tr class="is-head">' +
        `<th class="up-rn">${selectedHeaderRow + 1}</th>` +
        '<th class="up-use"><span class="badge badge-primary">Header</span></th>' +
        currentHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';

    // Body: each row gets its row number, its use, and a right-click handler
    tbody.innerHTML = currentRows.map((row, idx) => {
        const dataIdx = idx + loadedRowOffset;
        const rowClasses = getRowClasses(dataIdx);
        return `<tr class="${rowClasses}" oncontextmenu="showRowContextMenu(event, ${dataIdx})">` +
            `<td class="up-rn">${sheetRowOf(dataIdx)}</td>` +
            `<td class="up-use">${rowUseBadge(dataIdx)}</td>` +
            currentHeaders.map(h => {
                const v = row[h] || '';
                return `<td title="${escapeHtml(v)}">${escapeHtml(v)}</td>`;
            }).join('') + '</tr>';
    }).join('');

    if (!currentRows.length) {
        tbody.innerHTML = `<tr><td class="up-empty" colspan="${currentHeaders.length + 2}">No rows below the header row.</td></tr>`;
    }

    const shown = currentRows.length;
    let hint = '';
    if (shown) {
        hint = shown < totalRows
            ? `first ${shown} of ${totalRows} rows below the header`
            : `${shown} rows below the header`;
    }
    setText('rowsSheetHint', hint);

    refreshUploadUi();
}

function isInRange(rowIndex) {
    const start = rowRange.start !== null ? rowRange.start : 0;
    const end = rowRange.end !== null ? rowRange.end : Infinity;
    return rowIndex >= start && rowIndex <= end;
}

function getRowClasses(rowIndex) {
    const classes = [];

    // Check if row is out of range
    if (rowRange.start !== null || rowRange.end !== null) {
        if (!isInRange(rowIndex)) {
            classes.push('row-out-of-range');
        } else {
            classes.push('row-in-range');
        }
        if (rowIndex === rowRange.start) classes.push('row-start');
        if (rowIndex === rowRange.end) classes.push('row-end');
    }

    return classes.join(' ');
}

/** The use of a row in words: First / Last / Data / Skipped. */
function rowUseBadge(rowIndex) {
    if (!isInRange(rowIndex)) return '<span class="badge badge-gray">Skipped</span>';
    if (rowIndex === rowRange.start) return '<span class="badge badge-primary">First</span>';
    if (rowIndex === rowRange.end) return '<span class="badge badge-primary">Last</span>';
    return '<span class="badge up-badge-data">Data</span>';
}

// ========================================================================
// Mapped preview, step 3 (mapped column heads marked)
// ========================================================================

function getMappingByColumn() {
    const tags = {};
    document.querySelectorAll('.mapping-multiselect').forEach(ms => {
        const stdCol = ms.dataset.standard;
        ms.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            (tags[cb.value] = tags[cb.value] || []).push(stdCol);
        });
    });
    return tags;
}

function renderMapPreview() {
    const thead = document.getElementById('mapPreviewHead');
    const tbody = document.getElementById('mapPreviewBody');
    if (!thead || !tbody) return;
    if (!fileLoaded) {
        thead.innerHTML = '';
        tbody.innerHTML = '';
        setText('mapPreviewHint', '');
        return;
    }

    const tags = getMappingByColumn();
    const isNumCol = h => (tags[h] || []).includes('Quantity');
    const isMonoCol = h => (tags[h] || []).some(t => t === 'Quantity' || t === 'MPN');

    thead.innerHTML = '<tr><th class="up-rn">#</th>' + currentHeaders.map(h => {
        const t = tags[h];
        const cls = [t ? 'up-mapped' : '', isNumCol(h) ? 'up-num-col' : ''].join(' ').trim();
        return `<th class="${cls}"><span class="up-th-name">${escapeHtml(h)}</span>` +
            (t ? `<span class="up-th-tag">${escapeHtml(t.join(' · '))}</span>` : '') + '</th>';
    }).join('') + '</tr>';

    const rows = [];
    for (let idx = 0; idx < currentRows.length && rows.length < MAP_PREVIEW_ROWS; idx++) {
        const dataIdx = idx + loadedRowOffset;
        if (!isInRange(dataIdx)) continue;
        const row = currentRows[idx];
        rows.push(`<tr><td class="up-rn">${sheetRowOf(dataIdx)}</td>` + currentHeaders.map(h => {
            const v = row[h] || '';
            const cls = [isNumCol(h) ? 'up-num-col' : '', isMonoCol(h) ? 'fx-mono' : ''].join(' ').trim();
            const cell = v === '' ? '<span class="up-none">—</span>' : escapeHtml(v);
            return `<td class="${cls}" title="${escapeHtml(v)}">${cell}</td>`;
        }).join('') + '</tr>');
    }
    tbody.innerHTML = rows.length
        ? rows.join('')
        : `<tr><td class="up-empty" colspan="${currentHeaders.length + 1}">No data rows in the range.</td></tr>`;
    setText('mapPreviewHint', rows.length ? `first ${rows.length} data rows` : '');
}

// ========================================================================
// Right-Click Context Menu
// ========================================================================

function showRowContextMenu(event, rowIndex) {
    event.preventDefault();
    contextMenuRowIndex = rowIndex;

    const menu = document.getElementById('rowContextMenu');
    if (!menu) return;

    menu.style.display = 'block';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    // Ensure menu stays within viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    }
}

function hideRowContextMenu() {
    const menu = document.getElementById('rowContextMenu');
    if (menu) menu.style.display = 'none';
    contextMenuRowIndex = null;
}

// Hide context menu on click anywhere
document.addEventListener('click', hideRowContextMenu);
document.addEventListener('contextmenu', (e) => {
    // Only hide if clicking outside the preview table
    if (!e.target.closest('#previewBody')) {
        hideRowContextMenu();
    }
});
// Escape closes the context menu and the mapping dropdowns
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideRowContextMenu();
    document.querySelectorAll('.mapping-multiselect-dropdown').forEach(d => {
        if (d.style.display !== 'none') {
            d.style.display = 'none';
            const display = d.previousElementSibling;
            if (display) {
                display.setAttribute('aria-expanded', 'false');
                display.focus();
            }
        }
    });
});

// ========================================================================
// Context Menu Actions
// ========================================================================

async function setAsHeaderRow() {
    if (contextMenuRowIndex === null) {
        hideRowContextMenu();
        return;
    }

    // The clicked row index is a data row index (0 = first row under the header).
    // Current header_row + 1 (for the header itself) + contextMenuRowIndex = raw row
    const newHeaderRow = selectedHeaderRow + 1 + contextMenuRowIndex;

    hideRowContextMenu();

    selectedHeaderRow = newHeaderRow;

    // Reset row range when header changes
    rowRange = { start: null, end: null };
    clearRowRangeInputs();

    await reloadFile();
    toast.success(`Row ${newHeaderRow + 1} set as header row`);
}

function setAsStartRow() {
    if (contextMenuRowIndex === null) {
        hideRowContextMenu();
        return;
    }

    const rowIndex = contextMenuRowIndex;
    rowRange.start = rowIndex;

    // If end is before start, clear end
    if (rowRange.end !== null && rowRange.end < rowIndex) {
        rowRange.end = null;
    }

    hideRowContextMenu();
    updateRowRangeInputs();
    renderPreview();
    toast.info(`First data row set to ${sheetRowOf(rowIndex)}`);
}

function setAsEndRow() {
    if (contextMenuRowIndex === null) {
        hideRowContextMenu();
        return;
    }

    const rowIndex = contextMenuRowIndex;
    rowRange.end = rowIndex;

    // If start is after end, clear start
    if (rowRange.start !== null && rowRange.start > rowIndex) {
        rowRange.start = null;
    }

    hideRowContextMenu();
    updateRowRangeInputs();
    renderPreview();
    toast.info(`Last data row set to ${sheetRowOf(rowIndex)}`);
}

function clearRowRangeMenu() {
    hideRowContextMenu();
    clearRowRange();
}

// ========================================================================
// Row Range Controls (input fields, in sheet row numbers)
// ========================================================================

function applyRowRange() {
    const startInput = document.getElementById('startRowInput');
    const endInput = document.getElementById('endRowInput');

    const startVal = startInput.value ? parseInt(startInput.value, 10) : null;
    const endVal = endInput.value ? parseInt(endInput.value, 10) : null;

    // The inputs are sheet row numbers; the first data row is the row under the header
    const firstDataRow = sheetRowOf(0);
    if ((startVal !== null && startVal < firstDataRow) || (endVal !== null && endVal < firstDataRow)) {
        toast.warning(`Data rows start at row ${firstDataRow}, under the header row`);
        updateRowRangeInputs();
        return;
    }

    // Convert from sheet row numbers (display) to 0-indexed data rows (internal)
    rowRange.start = startVal !== null ? startVal - firstDataRow : null;
    rowRange.end = endVal !== null ? endVal - firstDataRow : null;

    // Validate
    if (rowRange.start !== null && rowRange.end !== null && rowRange.start > rowRange.end) {
        toast.warning('Start row must be before end row');
        rowRange.start = null;
        rowRange.end = null;
        clearRowRangeInputs();
        renderPreview();
        return;
    }

    renderPreview();

    const rangeDesc = [];
    if (rowRange.start !== null) rangeDesc.push(`from row ${sheetRowOf(rowRange.start)}`);
    if (rowRange.end !== null) rangeDesc.push(`to row ${sheetRowOf(rowRange.end)}`);
    if (rangeDesc.length > 0) {
        toast.info(`Row range set: ${rangeDesc.join(' ')}`);
    }
}

['startRowInput', 'endRowInput'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyRowRange();
        }
    });
});

function clearRowRange() {
    rowRange = { start: null, end: null };
    clearRowRangeInputs();
    renderPreview();
    toast.info('Row range cleared');
}

function clearRowRangeInputs() {
    const startInput = document.getElementById('startRowInput');
    const endInput = document.getElementById('endRowInput');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
}

function updateRowRangeInputs() {
    const startInput = document.getElementById('startRowInput');
    const endInput = document.getElementById('endRowInput');
    // Display as sheet row numbers
    if (startInput) startInput.value = rowRange.start !== null ? sheetRowOf(rowRange.start) : '';
    if (endInput) endInput.value = rowRange.end !== null ? sheetRowOf(rowRange.end) : '';
}

// ========================================================================
// Column Mapping
// ========================================================================

function renderMapping() {
    const grid = document.getElementById('mappingGrid');

    grid.innerHTML = standardColumns.map((stdCol, i) => {
        const required = stdCol === 'Description'
            ? ' <span class="badge badge-warning up-req">Required</span>' : '';
        const labelId = `mapLabel${i}`;

        // Build the multi-select dropdown
        const checkboxes = currentHeaders.map(h => {
            const checked = autoMatch(stdCol, h) ? ' checked' : '';
            return `<label class="mapping-checkbox-item">
                <input type="checkbox" value="${escapeHtml(h)}"${checked}>
                <span>${escapeHtml(h)}</span>
            </label>`;
        }).join('');

        return `
            <div class="up-group">
                <span class="up-label" id="${labelId}">${escapeHtml(stdCol)}${required}</span>
                <div class="mapping-multiselect" data-standard="${escapeHtml(stdCol)}">
                    <button type="button" class="mapping-multiselect-display" aria-haspopup="true" aria-expanded="false"
                            aria-labelledby="${labelId} ${labelId}v" onclick="toggleMappingDropdown(this)">
                        <span class="mapping-multiselect-text" id="${labelId}v">Not mapped</span>
                        <span class="mapping-multiselect-arrow">${CHEVRON_SVG}</span>
                    </button>
                    <div class="mapping-multiselect-dropdown" style="display: none;">
                        ${checkboxes || '<div class="up-menu-empty">No columns in this sheet.</div>'}
                        <div class="up-menu-foot">Pick more columns to combine them.</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Update display text for auto-matched selections
    document.querySelectorAll('.mapping-multiselect').forEach(ms => {
        updateMappingDisplay(ms, true);
    });

    // Add change listeners to checkboxes
    document.querySelectorAll('.mapping-multiselect input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            updateMappingDisplay(cb.closest('.mapping-multiselect'));
        });
    });

    refreshUploadUi();
}

function toggleMappingDropdown(displayEl) {
    const dropdown = displayEl.nextElementSibling;
    const isOpen = dropdown.style.display !== 'none';

    // Close all other dropdowns first
    document.querySelectorAll('.mapping-multiselect-dropdown').forEach(d => {
        d.style.display = 'none';
        if (d.previousElementSibling) d.previousElementSibling.setAttribute('aria-expanded', 'false');
    });

    if (!isOpen) {
        dropdown.style.display = 'block';
        displayEl.setAttribute('aria-expanded', 'true');
        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && !displayEl.contains(e.target)) {
                dropdown.style.display = 'none';
                displayEl.setAttribute('aria-expanded', 'false');
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
    }
}

function updateMappingDisplay(multiselect, skipRefresh) {
    const checked = multiselect.querySelectorAll('input[type="checkbox"]:checked');
    const textEl = multiselect.querySelector('.mapping-multiselect-text');
    const display = multiselect.querySelector('.mapping-multiselect-display');
    if (checked.length === 0) {
        textEl.textContent = 'Not mapped';
        if (display) display.classList.add('is-empty');
    } else {
        const names = Array.from(checked).map(cb => cb.value);
        textEl.textContent = names.join(' + ');
        if (display) display.classList.remove('is-empty');
    }
    if (!skipRefresh) refreshUploadUi();
}

function autoMatch(standardCol, headerCol) {
    const std = standardCol.toLowerCase();
    const hdr = headerCol.toLowerCase();

    const aliases = {
        'manufacturer': ['manufacturer', 'mfr', 'mfg', 'brand', 'fabrikant'],
        'mpn': ['mpn', 'part number', 'partnumber', 'part no', 'mfr part', 'manufacturer part'],
        'description': ['description', 'desc', 'omschrijving', 'component', 'part description'],
        'quantity': ['quantity', 'qty', 'aantal', 'count', 'amount'],
        'refdes': ['refdes', 'reference', 'ref des', 'designator', 'reference designator']
    };

    const aliasList = aliases[std] || [std];
    return aliasList.some(a => hdr.includes(a));
}

// ========================================================================
// Restore Previously Stored Settings
// ========================================================================

function applyStoredMapping(mapping) {
    document.querySelectorAll('.mapping-multiselect').forEach(ms => {
        const stdCol = ms.dataset.standard;
        const stored = mapping[stdCol];
        if (!stored) return;

        // Normalize to array
        const values = Array.isArray(stored) ? stored : [stored];

        // Uncheck all, then check matching
        ms.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.checked = values.includes(cb.value);
        });
        updateMappingDisplay(ms, true);
    });
    refreshUploadUi();
}

async function restoreCustomer(klantNr) {
    if (!klantNr) return;
    // Ensure customer list is loaded before trying to restore
    await klantenReady;
    const klant = allKlanten.find(k => k.klant_nr === klantNr);
    if (klant) {
        selectCustomer(klant.klant_nr, klant.klant_naam);
    }
}

// ========================================================================
// Customer Selector
// ========================================================================

async function loadKlanten() {
    try {
        const data = await apiCall('/api/klanten', { method: 'GET' });
        allKlanten = data.klanten || [];
    } catch (e) {
        allKlanten = [];
    }
}

function initCustomerSelector() {
    const searchInput = document.getElementById('customerSearch');
    const dropdown = document.getElementById('customerDropdown');
    if (!searchInput || !dropdown) return;

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query.length < 1) {
            dropdown.style.display = 'none';
            return;
        }
        const filtered = allKlanten.filter(k =>
            k.klant_nr.toLowerCase().includes(query) ||
            k.klant_naam.toLowerCase().includes(query)
        ).slice(0, 30);

        if (filtered.length === 0) {
            dropdown.style.display = 'none';
            return;
        }

        dropdown.innerHTML = filtered.map(k =>
            `<div class="customer-dropdown-item" data-klant-nr="${escapeHtml(k.klant_nr)}">` +
            `<span class="klant-nr">${escapeHtml(k.klant_nr)}</span>` +
            `<span class="klant-naam">${escapeHtml(k.klant_naam)}</span>` +
            `</div>`
        ).join('');
        dropdown.style.display = 'block';

        dropdown.querySelectorAll('.customer-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const nr = item.dataset.klantNr;
                const naam = allKlanten.find(k => k.klant_nr === nr)?.klant_naam || '';
                selectCustomer(nr, naam);
            });
        });
    });

    searchInput.addEventListener('blur', () => {
        // Delay to allow click on dropdown item
        setTimeout(() => { dropdown.style.display = 'none'; }, 200);
    });

    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length >= 1) {
            searchInput.dispatchEvent(new Event('input'));
        }
    });
}

function updateCustomerUi() {
    const searchInput = document.getElementById('customerSearch');
    const hint = document.getElementById('customerHint');
    if (searchInput) {
        searchInput.placeholder = selectedKlantNr ? 'Search another customer' : 'Search customer by name or number';
    }
    if (hint) {
        hint.textContent = selectedKlantNr
            ? `Customer-specific parts of Klant ${selectedKlantNr} are included in matching.`
            : 'Empty: generic matching without customer-specific parts.';
    }
    refreshUploadUi();
}

function selectCustomer(klantNr, klantNaam) {
    selectedKlantNr = klantNr;
    selectedKlantNaam = klantNaam;
    const searchInput = document.getElementById('customerSearch');
    const dropdown = document.getElementById('customerDropdown');
    const selectedDiv = document.getElementById('selectedCustomer');
    const selectedText = document.getElementById('selectedCustomerText');

    if (searchInput) searchInput.value = '';
    if (dropdown) dropdown.style.display = 'none';
    if (selectedText) {
        selectedText.innerHTML = `Klant <span class="fx-mono">${escapeHtml(klantNr)}</span>` +
            (klantNaam ? ` · ${escapeHtml(klantNaam)}` : '');
        selectedText.title = `${klantNr} — ${klantNaam}`;
    }
    if (selectedDiv) selectedDiv.style.display = 'inline-flex';
    updateCustomerUi();

    toast.success(`Customer selected: ${klantNaam}`);
}

function clearCustomerSelection() {
    selectedKlantNr = '';
    selectedKlantNaam = '';
    const selectedDiv = document.getElementById('selectedCustomer');
    if (selectedDiv) selectedDiv.style.display = 'none';
    updateCustomerUi();
    document.getElementById('customerSearch')?.focus();
    toast.info('Customer selection cleared');
}

// Load customer list on page load
const klantenReady = loadKlanten().then(() => initCustomerSelector());

// ========================================================================
// Back navigation (/?back=1 from the Process page)
// ========================================================================

async function checkBackNavigation() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('back')) return;

    // Remove query param from URL without reload
    window.history.replaceState({}, '', '/');

    showLoading();
    try {
        const data = await apiCall('/api/upload-state', { method: 'GET' });
        if (!data.has_state) return;

        // Restore state variables
        currentHeaders = data.headers;
        currentRows = data.preview_rows;
        selectedHeaderRow = data.header_row || 0;
        rowRange = {
            start: data.start_row != null ? data.start_row : null,
            end: data.end_row != null ? data.end_row : null,
        };
        // The stored rows were read with the range: they start at start_row
        loadedRowOffset = rowRange.start !== null ? rowRange.start : 0;
        sheetList = Array.isArray(data.sheets) ? data.sheets : [];
        currentSheet = data.sheet_name && sheetList.includes(data.sheet_name) ? data.sheet_name : null;

        // Show file info and sheet choice
        setFileLoaded(data);

        // Row range inputs
        updateRowRangeInputs();

        // Render preview and mapping
        renderPreview();
        renderMapping();

        // Apply stored column mapping
        if (data.column_mapping && Object.keys(data.column_mapping).length > 0) {
            applyStoredMapping(data.column_mapping);
        }

        // Restore a previously fetched previous-version BOM (if any)
        restorePreviousBom();

        // Restore customer selection
        if (data.klant_nr) {
            await restoreCustomer(data.klant_nr);
        }

        // Show clear button if process data exists
        showClearProcessDataBtn(!!data.has_process_data);

        showStep(3);
        toast.info('Restored previous session');
    } catch (e) {
        // Silently fail - user gets a fresh upload page
    } finally {
        hideLoading();
    }
}

// Check for back navigation after customer list is ready
klantenReady.then(() => checkBackNavigation());

// ========================================================================
// Clear stored process data
// ========================================================================

function showClearProcessDataBtn(hasData) {
    const btn = document.getElementById('clearProcessDataBtn');
    if (btn) btn.style.display = hasData ? '' : 'none';
}

async function clearProcessData() {
    try {
        await apiCall('/api/clear-process-data', { method: 'POST' });
        sessionStorage.removeItem('processUiState');
        sessionStorage.removeItem('processBomName');
        showClearProcessDataBtn(false);
        toast.success('Process data cleared — BOM will be processed fresh');
    } catch (e) {
        // toast shown by apiCall
    }
}

// ========================================================================
// Previous Version (Exact) BOM
// ========================================================================

function showPreviousBomInfo(articleId, description, count) {
    previousBom = { article_id: articleId || '', description: description || '', count: count || 0 };
    const info = document.getElementById('previousBomInfo');
    const txt = document.getElementById('previousBomInfoText');
    if (txt) {
        txt.innerHTML = `<span class="fx-mono">${escapeHtml(previousBom.article_id)}</span>` +
            (previousBom.description ? ` · ${escapeHtml(previousBom.description)}` : '') +
            ` · <span class="fx-mono">${previousBom.count}</span> components. Process BOM matches against this BOM.`;
    }
    if (info) info.style.display = 'flex';
    document.getElementById('previousBomSection')?.classList.add('is-loaded');
    refreshUploadUi();
}

async function fetchPreviousBom() {
    const input = document.getElementById('previousArticleId');
    const articleId = input ? input.value.trim() : '';
    if (!articleId) {
        toast.warning('Enter a previous article number first');
        return;
    }
    showLoading();
    try {
        const data = await apiCall('/api/exact/fetch-previous', {
            method: 'POST',
            body: JSON.stringify({ article_id: articleId })
        });
        showPreviousBomInfo(data.article_id, data.description, data.total_rows);
        toast.success(`Previous BOM ${data.article_id} loaded (${data.total_rows} components)`);
    } catch (e) {
        // toast shown by apiCall
    } finally {
        hideLoading();
    }
}

async function clearPreviousBom() {
    try {
        await apiCall('/api/exact/clear-previous', { method: 'POST' });
        const info = document.getElementById('previousBomInfo');
        if (info) info.style.display = 'none';
        document.getElementById('previousBomSection')?.classList.remove('is-loaded');
        const input = document.getElementById('previousArticleId');
        if (input) input.value = '';
        previousBom = null;
        refreshUploadUi();
        toast.info('Previous BOM cleared — normal ERP matching will be used');
    } catch (e) {
        // toast shown by apiCall
    }
}

async function restorePreviousBom() {
    try {
        const data = await apiCall('/api/exact/previous-bom', { method: 'GET' });
        const components = data.components || [];
        if (components.length > 0) {
            const input = document.getElementById('previousArticleId');
            if (input) input.value = data.article_id || '';
            showPreviousBomInfo(data.article_id || '', data.description, components.length);
        }
    } catch (e) {
        // No previous BOM — ignore
    }
}

// ========================================================================
// Process BOM
// ========================================================================

async function processBom() {
    // Collect mapping (supports multiple columns per standard field)
    const mapping = {};
    document.querySelectorAll('.mapping-multiselect').forEach(ms => {
        const stdCol = ms.dataset.standard;
        const checked = ms.querySelectorAll('input[type="checkbox"]:checked');
        const values = Array.from(checked).map(cb => cb.value);
        if (values.length === 1) {
            mapping[stdCol] = values[0];  // single value: keep as string for backwards compat
        } else if (values.length > 1) {
            mapping[stdCol] = values;     // multiple values: send as array
        }
    });

    // Validate: Description is required
    if (!mapping['Description']) {
        toast.warning('Please map the Description column (required)');
        if (openStep !== 3) showStep(3);
        return;
    }

    showLoading();
    try {
        // If row range is set, reload with the range first to filter data
        if (rowRange.start !== null || rowRange.end !== null) {
            await reloadFile();
        }

        await apiCall('/api/set-mapping', {
            method: 'POST',
            body: JSON.stringify({ mapping, klant_nr: selectedKlantNr })
        });
        window.location.href = '/process';
    } catch (e) {
        hideLoading();
    }
}

// First paint of the stepper (no file yet)
refreshUploadUi();
