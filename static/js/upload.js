/**
 * BOM Matcher - Upload Page JavaScript
 * Handles file upload, sheet/header selection, row range, column mapping, and navigation.
 */

const standardColumns = ['Manufacturer', 'MPN', 'Description', 'Quantity', 'Refdes'];
let currentHeaders = [];
let currentRows = [];

// Customer selection state
let allKlanten = [];
let selectedKlantNr = '';

// Row selection state
let selectedHeaderRow = 0;    // 0-indexed row used as header
let rowRange = { start: null, end: null };  // 0-indexed data row range (after header)

// Context menu state
let contextMenuRowIndex = null;

// ========================================================================
// Drop Zone
// ========================================================================

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
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

        // Reset row selection state
        selectedHeaderRow = 0;
        rowRange = { start: null, end: null };

        // Show file info
        document.getElementById('fileName').textContent = data.filename;
        document.getElementById('fileRowCount').textContent = `(${data.total_rows} rows)`;
        document.getElementById('fileInfo').style.display = 'block';

        // Show sheet selector if multiple sheets
        if (data.sheets && data.sheets.length > 1) {
            const select = document.getElementById('sheetSelect');
            select.innerHTML = data.sheets.map(s =>
                `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
            ).join('');
            document.getElementById('sheetSelector').style.display = 'block';
        } else {
            document.getElementById('sheetSelector').style.display = 'none';
        }

        // Show row range controls and generic RC checkbox
        const rowRangeSection = document.getElementById('rowRangeSection');
        if (rowRangeSection) rowRangeSection.style.display = 'block';
        clearRowRangeInputs();

        // Check if we have previous settings to restore
        const prev = data.previous_settings;
        if (prev && prev.header_row != null && prev.header_row !== 0) {
            // Restore header row, sheet, and row range before rendering
            selectedHeaderRow = prev.header_row;
            if (prev.sheet_name) {
                const sheetSelect = document.getElementById('sheetSelect');
                if (sheetSelect) sheetSelect.value = prev.sheet_name;
            }
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
            if (prev.sheet_name) {
                const sheetSelect = document.getElementById('sheetSelect');
                if (sheetSelect) sheetSelect.value = prev.sheet_name;
            }
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

        document.getElementById('previewSection').style.display = 'block';
        document.getElementById('mappingSection').style.display = 'block';
        const customerSection = document.getElementById('customerSection');
        if (customerSection) customerSection.style.display = 'block';
        document.getElementById('processSection').style.display = 'flex';

        // Restore customer selection if previous settings exist
        if (prev && prev.klant_nr) {
            await restoreCustomer(prev.klant_nr);
        }

        // Show clear button if process data exists from a previous session
        showClearProcessDataBtn(!!data.has_process_data);

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

document.getElementById('sheetSelect')?.addEventListener('change', reloadFile);

async function reloadFile() {
    const headerRow = selectedHeaderRow;
    const sheetSelect = document.getElementById('sheetSelect');
    const sheetName = sheetSelect ? sheetSelect.value : null;

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
        document.getElementById('fileRowCount').textContent = `(${data.total_rows} rows)`;

        renderPreview();
        renderMapping();
    } catch (e) {
        // toast shown by apiCall
    } finally {
        hideLoading();
    }
}

// ========================================================================
// Preview Table (with row numbers and highlighting)
// ========================================================================

function renderPreview() {
    const thead = document.getElementById('previewHead');
    const tbody = document.getElementById('previewBody');

    // Header: row number column + data columns
    thead.innerHTML = '<tr><th class="preview-row-number">#</th>' + currentHeaders.map(h =>
        `<th>${escapeHtml(h)}</th>`
    ).join('') + '</tr>';

    // Body: each row gets a row number and right-click handler
    tbody.innerHTML = currentRows.map((row, idx) => {
        const rowClasses = getRowClasses(idx);
        return `<tr class="${rowClasses}" oncontextmenu="showRowContextMenu(event, ${idx})">` +
            `<td class="preview-row-number">${idx + 1}</td>` +
            currentHeaders.map(h =>
                `<td>${escapeHtml(row[h] || '')}</td>`
            ).join('') + '</tr>';
    }).join('');
}

function getRowClasses(rowIndex) {
    const classes = [];

    // Check if row is out of range
    if (rowRange.start !== null || rowRange.end !== null) {
        const start = rowRange.start !== null ? rowRange.start : 0;
        const end = rowRange.end !== null ? rowRange.end : Infinity;

        if (rowIndex < start || rowIndex > end) {
            classes.push('row-out-of-range');
        } else {
            classes.push('row-in-range');
        }
        if (rowIndex === rowRange.start) classes.push('row-start');
        if (rowIndex === rowRange.end) classes.push('row-end');
    }

    return classes.join(' ');
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

// ========================================================================
// Context Menu Actions
// ========================================================================

async function setAsHeaderRow() {
    if (contextMenuRowIndex === null) {
        hideRowContextMenu();
        return;
    }

    // The clicked row index is relative to the current data rows.
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

    rowRange.start = contextMenuRowIndex;

    // If end is before start, clear end
    if (rowRange.end !== null && rowRange.end < contextMenuRowIndex) {
        rowRange.end = null;
    }

    hideRowContextMenu();
    updateRowRangeInputs();
    renderPreview();
    toast.info(`Start row set to ${contextMenuRowIndex + 1}`);
}

function setAsEndRow() {
    if (contextMenuRowIndex === null) {
        hideRowContextMenu();
        return;
    }

    rowRange.end = contextMenuRowIndex;

    // If start is after end, clear start
    if (rowRange.start !== null && rowRange.start > contextMenuRowIndex) {
        rowRange.start = null;
    }

    hideRowContextMenu();
    updateRowRangeInputs();
    renderPreview();
    toast.info(`End row set to ${contextMenuRowIndex + 1}`);
}

function clearRowRangeMenu() {
    hideRowContextMenu();
    clearRowRange();
}

// ========================================================================
// Row Range Controls (input fields)
// ========================================================================

function applyRowRange() {
    const startInput = document.getElementById('startRowInput');
    const endInput = document.getElementById('endRowInput');

    const startVal = startInput.value ? parseInt(startInput.value) : null;
    const endVal = endInput.value ? parseInt(endInput.value) : null;

    // Convert from 1-indexed (display) to 0-indexed (internal)
    rowRange.start = startVal !== null ? startVal - 1 : null;
    rowRange.end = endVal !== null ? endVal - 1 : null;

    // Validate
    if (rowRange.start !== null && rowRange.end !== null && rowRange.start > rowRange.end) {
        toast.warning('Start row must be before end row');
        rowRange.start = null;
        rowRange.end = null;
        clearRowRangeInputs();
        return;
    }

    renderPreview();

    const rangeDesc = [];
    if (rowRange.start !== null) rangeDesc.push(`from row ${rowRange.start + 1}`);
    if (rowRange.end !== null) rangeDesc.push(`to row ${rowRange.end + 1}`);
    if (rangeDesc.length > 0) {
        toast.info(`Row range set: ${rangeDesc.join(' ')}`);
    }
}

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
    // Display as 1-indexed
    if (startInput) startInput.value = rowRange.start !== null ? rowRange.start + 1 : '';
    if (endInput) endInput.value = rowRange.end !== null ? rowRange.end + 1 : '';
}

// ========================================================================
// Column Mapping
// ========================================================================

function renderMapping() {
    const grid = document.getElementById('mappingGrid');

    grid.innerHTML = standardColumns.map(stdCol => {
        const required = stdCol === 'Description' ? ' *' : '';

        // Build the multi-select dropdown
        const checkboxes = currentHeaders.map(h => {
            const checked = autoMatch(stdCol, h) ? ' checked' : '';
            return `<label class="mapping-checkbox-item">
                <input type="checkbox" value="${escapeHtml(h)}"${checked}>
                <span>${escapeHtml(h)}</span>
            </label>`;
        }).join('');

        return `
            <div class="mapping-row">
                <label class="mapping-label">${escapeHtml(stdCol)}${required}</label>
                <div class="mapping-multiselect" data-standard="${escapeHtml(stdCol)}">
                    <div class="mapping-multiselect-display" onclick="toggleMappingDropdown(this)">
                        <span class="mapping-multiselect-text">-- not mapped --</span>
                        <span class="mapping-multiselect-arrow">&#9662;</span>
                    </div>
                    <div class="mapping-multiselect-dropdown" style="display: none;">
                        ${checkboxes}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Update display text for auto-matched selections
    document.querySelectorAll('.mapping-multiselect').forEach(ms => {
        updateMappingDisplay(ms);
    });

    // Add change listeners to checkboxes
    document.querySelectorAll('.mapping-multiselect input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            updateMappingDisplay(cb.closest('.mapping-multiselect'));
        });
    });
}

function toggleMappingDropdown(displayEl) {
    const dropdown = displayEl.nextElementSibling;
    const isOpen = dropdown.style.display !== 'none';

    // Close all other dropdowns first
    document.querySelectorAll('.mapping-multiselect-dropdown').forEach(d => {
        d.style.display = 'none';
    });

    if (!isOpen) {
        dropdown.style.display = 'block';
        // Close on outside click
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && !displayEl.contains(e.target)) {
                dropdown.style.display = 'none';
                document.removeEventListener('mousedown', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
    }
}

function updateMappingDisplay(multiselect) {
    const checked = multiselect.querySelectorAll('input[type="checkbox"]:checked');
    const textEl = multiselect.querySelector('.mapping-multiselect-text');
    if (checked.length === 0) {
        textEl.textContent = '-- not mapped --';
        textEl.style.color = 'var(--text-muted)';
    } else {
        const names = Array.from(checked).map(cb => cb.value);
        textEl.textContent = names.join(' + ');
        textEl.style.color = 'var(--text-main)';
    }
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
        updateMappingDisplay(ms);
    });
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

function selectCustomer(klantNr, klantNaam) {
    selectedKlantNr = klantNr;
    const searchInput = document.getElementById('customerSearch');
    const dropdown = document.getElementById('customerDropdown');
    const selectedDiv = document.getElementById('selectedCustomer');
    const selectedText = document.getElementById('selectedCustomerText');

    if (searchInput) searchInput.value = '';
    if (dropdown) dropdown.style.display = 'none';
    if (selectedText) selectedText.textContent = `${klantNr} — ${klantNaam}`;
    if (selectedDiv) selectedDiv.style.display = 'inline-flex';

    toast.success(`Customer selected: ${klantNaam}`);
}

function clearCustomerSelection() {
    selectedKlantNr = '';
    const selectedDiv = document.getElementById('selectedCustomer');
    if (selectedDiv) selectedDiv.style.display = 'none';
    toast.info('Customer selection cleared');
}

// Load customer list on page load
const klantenReady = loadKlanten().then(() => initCustomerSelector());

// ========================================================================
// Process BOM
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

        // Show file info
        document.getElementById('fileName').textContent = data.filename;
        document.getElementById('fileRowCount').textContent = `(${data.total_rows} rows)`;
        document.getElementById('fileInfo').style.display = 'block';

        // Sheet selector
        if (data.sheets && data.sheets.length > 1) {
            const select = document.getElementById('sheetSelect');
            select.innerHTML = data.sheets.map(s =>
                `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
            ).join('');
            document.getElementById('sheetSelector').style.display = 'block';
            if (data.sheet_name) select.value = data.sheet_name;
        }

        // Row range inputs
        updateRowRangeInputs();
        document.getElementById('rowRangeSection').style.display = 'block';

        // Render preview and mapping
        renderPreview();
        renderMapping();

        // Apply stored column mapping
        if (data.column_mapping && Object.keys(data.column_mapping).length > 0) {
            applyStoredMapping(data.column_mapping);
        }

        // Show all sections
        document.getElementById('previewSection').style.display = 'block';
        document.getElementById('mappingSection').style.display = 'block';
        const customerSection = document.getElementById('customerSection');
        if (customerSection) customerSection.style.display = 'block';
        document.getElementById('processSection').style.display = 'flex';

        // Restore customer selection
        if (data.klant_nr) {
            await restoreCustomer(data.klant_nr);
        }

        // Show clear button if process data exists
        showClearProcessDataBtn(!!data.has_process_data);

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
