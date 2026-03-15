/**
 * process-params.js
 * Parameter extraction and comparison for R/C components on the process page.
 * Compares Customer BOM Description (left) vs ERP Omschrijving (right).
 * Extracted from BOM Compare's results-params.js (regex-only, no AI).
 */

// Package alias cache (loaded from settings)
let _packageAliases = null;

async function loadPackageAliases() {
    try {
        const data = await apiCall('/api/settings/package-aliases');
        _packageAliases = data.success ? data.aliases : [];
    } catch (e) {
        _packageAliases = [];
    }
}

// Default component detection tags
const DEFAULT_RESISTOR_TAGS = ['RES', 'RESISTOR', 'OHM', 'Ω'];
const DEFAULT_CAPACITOR_TAGS = [
    'CAP', 'CAPACITOR', 'X5R', 'X7R', 'X8R', 'C0G', 'NP0', 'COG', 'NPO', 'Y5V', 'Z5U',
    'ELCO', 'MLCC', 'CERAMIC', 'TANTALUM', 'µF', 'UF', 'PF', 'NF', 'FF'
];

/**
 * Detect component type based on description tags
 */
function detectComponentType(text) {
    if (!text) return null;
    const textUpper = text.toUpperCase();
    for (const tag of DEFAULT_RESISTOR_TAGS) {
        if (textUpper.includes(tag.toUpperCase())) return 'resistor';
    }
    for (const tag of DEFAULT_CAPACITOR_TAGS) {
        if (textUpper.includes(tag.toUpperCase())) return 'capacitor';
    }
    return null;
}

// ============================================================
// REGEX-BASED PARAMETER EXTRACTION
// ============================================================

function extractVoltageFromDescription(text) {
    if (!text) return null;
    const euroPattern = /(?:^|[\s,;])(\d+)V(\d+)(?![A-Za-z0-9])/gi;
    const euroMatches = [...text.matchAll(euroPattern)];
    if (euroMatches.length > 0) {
        return euroMatches[0][1] + '.' + euroMatches[0][2] + 'V';
    }
    const voltagePattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*V(?:DC|AC)?(?![A-Za-z0-9])/gi;
    const matches = [...text.matchAll(voltagePattern)];
    if (matches.length === 0) return null;
    let voltage = matches[0][1].replace(',', '.');
    return voltage + 'V';
}

function extractPowerFromDescription(text) {
    if (!text) return null;
    const mwPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*mW(?![A-Za-z0-9])/gi;
    const mwMatches = [...text.matchAll(mwPattern)];
    if (mwMatches.length > 0) {
        let value = parseFloat(mwMatches[0][1].replace(',', '.'));
        return (value / 1000) + 'W';
    }
    const wPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*W(?![A-Za-z0-9])/gi;
    const wMatches = [...text.matchAll(wPattern)];
    if (wMatches.length > 0) {
        return wMatches[0][1].replace(',', '.') + 'W';
    }
    return null;
}

function extractToleranceFromDescription(text) {
    if (!text) return null;
    const percentPattern = /[±+\/-]*\s*(\d+(?:[.,]\d+)?)\s*%/gi;
    const percentMatches = [...text.matchAll(percentPattern)];
    if (percentMatches.length > 0) {
        return percentMatches[0][1].replace(',', '.') + '%';
    }
    const reversedPercentPattern = /%\s*(\d+(?:[.,]\d+)?)\b/gi;
    const reversedMatches = [...text.matchAll(reversedPercentPattern)];
    if (reversedMatches.length > 0) {
        return reversedMatches[0][1].replace(',', '.') + '%';
    }
    const absPattern = /[±]|[+]\s*[\/\-]\s*[\-]?\s*(\d+(?:[.,]\d+)?)\s*(pF|nF|uF|µF|fF)/gi;
    const absMatches = [...text.matchAll(absPattern)];
    if (absMatches.length > 0 && absMatches[0][1]) {
        return absMatches[0][1].replace(',', '.') + absMatches[0][2].replace('µ', 'u');
    }
    const ffPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*(fF)\b/gi;
    const ffMatches = [...text.matchAll(ffPattern)];
    if (ffMatches.length > 0) {
        return ffMatches[0][1].replace(',', '.') + 'fF';
    }
    return null;
}

function extractValueFromDescription(text) {
    if (!text) return null;
    const componentType = detectComponentType(text);
    if (componentType === 'capacitor') return extractCapacitorValue(text);
    if (componentType === 'resistor') {
        const resistorVal = extractResistorValue(text);
        if (resistorVal) return resistorVal;
    }
    const capVal = extractCapacitorValue(text);
    if (capVal) return capVal;
    return extractResistorValue(text);
}

function extractCapacitorValue(text) {
    const capPattern = /(?:^|[\s,;(])(\d+(?:[.,]\d+)?)\s*(pF|nF|uF|µF|fF)\b/gi;
    const capMatches = [...text.matchAll(capPattern)];
    if (capMatches.length > 0) {
        return capMatches[0][1].replace(',', '.') + capMatches[0][2].replace('µ', 'u');
    }
    const euroCapPattern = /\b(\d+)([pPnNuUµ])(\d+)?(?![fF])\b/gi;
    const euroCapMatches = [...text.matchAll(euroCapPattern)];
    if (euroCapMatches.length > 0) {
        const whole = euroCapMatches[0][1];
        let unit = euroCapMatches[0][2].toLowerCase();
        const decimal = euroCapMatches[0][3] || '';
        if (unit === 'p') unit = 'pF';
        else if (unit === 'n') unit = 'nF';
        else if (unit === 'u' || unit === 'µ') unit = 'uF';
        return decimal ? whole + '.' + decimal + unit : whole + unit;
    }
    return null;
}

function extractResistorValue(text) {
    const euroOhmPattern = /\b(\d+)([kKmM])(\d+)\s*ohm[s]?\b/gi;
    const euroOhmMatches = [...text.matchAll(euroOhmPattern)];
    if (euroOhmMatches.length > 0) {
        return euroOhmMatches[0][1] + '.' + euroOhmMatches[0][3] + euroOhmMatches[0][2].toUpperCase();
    }
    const decimalOhmPattern = /\b(\d+(?:[.,]\d+)?)\s*([kKM])\s*[Oo][Hh][Mm][Ss]?\b/g;
    const decimalOhmMatches = [...text.matchAll(decimalOhmPattern)];
    if (decimalOhmMatches.length > 0) {
        return decimalOhmMatches[0][1].replace(',', '.') + decimalOhmMatches[0][2].toUpperCase();
    }
    const plainOhmPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*ohm[s]?\b/gi;
    const plainOhmMatches = [...text.matchAll(plainOhmPattern)];
    if (plainOhmMatches.length > 0) {
        return plainOhmMatches[0][1].replace(',', '.') + 'Ω';
    }
    const mOhmPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*m\s*ohm[s]?\b/gi;
    const mOhmMatches = [...text.matchAll(mOhmPattern)];
    if (mOhmMatches.length > 0) {
        return mOhmMatches[0][1].replace(',', '.') + 'mΩ';
    }
    const euroResPattern = /\b(\d+)([kKmM])(\d+)\b/gi;
    const euroResMatches = [...text.matchAll(euroResPattern)];
    if (euroResMatches.length > 0) {
        return euroResMatches[0][1] + '.' + euroResMatches[0][3] + euroResMatches[0][2].toUpperCase();
    }
    const trailingRPattern = /\b(\d+(?:[.,]\d+)?)\s*([kKmM])R\b/gi;
    const trailingRMatches = [...text.matchAll(trailingRPattern)];
    if (trailingRMatches.length > 0) {
        return trailingRMatches[0][1].replace(',', '.') + trailingRMatches[0][2].toUpperCase();
    }
    const packageCodes = ['0201', '0402', '0603', '0805', '1005', '1206', '1210', '1608', '1812', '2010', '2012', '2512'];
    const resPattern = /\b(\d+(?:[.,]\d+)?)\s*([kKmM])(?!\s*ohm)\b/gi;
    const resMatches = [...text.matchAll(resPattern)];
    for (const match of resMatches) {
        let value = match[1].replace(',', '.');
        let unit = match[2].toUpperCase();
        if (unit === 'M' && packageCodes.includes(match[1])) continue;
        return value + unit;
    }
    const milliOhmPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*m[eE]?(?![A-Za-z0-9wW])/g;
    const milliOhmMatches = [...text.matchAll(milliOhmPattern)];
    for (const match of milliOhmMatches) {
        if (packageCodes.includes(match[1])) continue;
        return match[1].replace(',', '.') + 'mΩ';
    }
    const ohmsEuroPattern = /(?:^|[\s,;])(\d+)([rReE])(\d+)(?![A-Za-z0-9])/gi;
    const ohmsEuroMatches = [...text.matchAll(ohmsEuroPattern)];
    if (ohmsEuroMatches.length > 0) {
        const whole = ohmsEuroMatches[0][1];
        const decimal = ohmsEuroMatches[0][3];
        const ohms = parseFloat(whole + '.' + decimal);
        if (ohms < 1) return Math.round(ohms * 1000) + 'mΩ';
        return whole + '.' + decimal + 'Ω';
    }
    const ohmsPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*([rReEΩ])(?![A-Za-z0-9])/gi;
    const ohmsMatches = [...text.matchAll(ohmsPattern)];
    if (ohmsMatches.length > 0) {
        return ohmsMatches[0][1].replace(',', '.') + 'Ω';
    }
    const isResistor = /\bresistor\b|\bres\b/i.test(text);
    if (isResistor) {
        const standalonePattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)(?=[\s,;]|$)(?!\s*[%vV])/gi;
        const standaloneMatches = [...text.matchAll(standalonePattern)];
        for (const match of standaloneMatches) {
            const num = match[1];
            if (/^\d{4}$/.test(num)) continue;
            if (/^0[.,]\d+$/.test(num)) continue;
            if (parseFloat(num.replace(',', '.')) > 0 && parseFloat(num.replace(',', '.')) < 1) continue;
            return num.replace(',', '.') + 'Ω';
        }
    }
    return null;
}

function extractPackageFromDescription(text) {
    if (!text) return null;
    // Check user-defined package aliases first
    if (_packageAliases && _packageAliases.length > 0) {
        const textUpper = text.toUpperCase();
        for (const alias of _packageAliases) {
            if (textUpper.includes(alias.pattern.toUpperCase())) {
                return alias.package;
            }
        }
    }
    const smdPattern = /(?:SMD|CASE)?(\b|(?<=[A-Za-z]))(0402|0603|0805|1206|1210|2512|0201|01005|2220)\b/gi;
    const smdMatches = [...text.matchAll(smdPattern)];
    if (smdMatches.length > 0) return smdMatches[0][2];
    const pkgPattern = /\b(SOT[-]?\d+|QFP[-]?\d+|SOIC[-]?\d+|DIP[-]?\d+|BGA[-]?\d+|TSSOP[-]?\d+)/gi;
    const pkgMatches = [...text.matchAll(pkgPattern)];
    if (pkgMatches.length > 0) return pkgMatches[0][1];
    return null;
}

/**
 * Extract parameters from both descriptions and compare
 * @param {string} desc1 - Customer BOM description (main)
 * @param {string} desc2 - ERP description
 * @param {number} mainBomNum - Which is the main reference (always 1)
 */
function extractParametersFromDescription(desc1, desc2, mainBomNum) {
    const value1 = extractValueFromDescription(desc1);
    const value2 = extractValueFromDescription(desc2);
    const tolerance1 = extractToleranceFromDescription(desc1);
    const tolerance2 = extractToleranceFromDescription(desc2);
    const voltage1 = extractVoltageFromDescription(desc1);
    const voltage2 = extractVoltageFromDescription(desc2);
    const power1 = extractPowerFromDescription(desc1);
    const power2 = extractPowerFromDescription(desc2);
    const package1 = extractPackageFromDescription(desc1);
    const package2 = extractPackageFromDescription(desc2);

    const mainValue = mainBomNum === 1 ? value1 : value2;
    const otherValue = mainBomNum === 1 ? value2 : value1;
    const mainTolerance = mainBomNum === 1 ? tolerance1 : tolerance2;
    const otherTolerance = mainBomNum === 1 ? tolerance2 : tolerance1;
    const mainVoltage = mainBomNum === 1 ? voltage1 : voltage2;
    const otherVoltage = mainBomNum === 1 ? voltage2 : voltage1;
    const mainPower = mainBomNum === 1 ? power1 : power2;
    const otherPower = mainBomNum === 1 ? power2 : power1;
    const mainPackage = mainBomNum === 1 ? package1 : package2;
    const otherPackage = mainBomNum === 1 ? package2 : package1;

    return {
        value1, value2,
        tolerance1, tolerance2,
        voltage1, voltage2,
        power1, power2,
        package1, package2,
        valueStatus: compareRegexValue(mainValue, otherValue),
        toleranceStatus: compareRegexTolerance(mainTolerance, otherTolerance),
        voltageStatus: compareRegexVoltage(mainVoltage, otherVoltage),
        powerStatus: compareRegexPower(mainPower, otherPower),
        packageStatus: compareRegexPackage(mainPackage, otherPackage)
    };
}

// ============================================================
// COMPARISON FUNCTIONS
// ============================================================

function compareRegexValue(mainVal, otherVal) {
    if (!mainVal && !otherVal) return 'missing';
    if (!mainVal || !otherVal) return 'missing';
    return normalizeValue(mainVal) === normalizeValue(otherVal) ? 'match' : 'diff';
}

function compareRegexPackage(mainVal, otherVal) {
    if (!mainVal && !otherVal) return 'missing';
    if (!mainVal || !otherVal) return 'missing';
    return mainVal.toLowerCase() === otherVal.toLowerCase() ? 'match' : 'diff';
}

function compareRegexVoltage(mainVal, otherVal) {
    if (!mainVal && !otherVal) return 'missing';
    if (!mainVal || !otherVal) return 'missing';
    const numMain = parseFloat(mainVal.replace(/[^0-9.]/g, ''));
    const numOther = parseFloat(otherVal.replace(/[^0-9.]/g, ''));
    if (isNaN(numMain) || isNaN(numOther)) return 'diff';
    if (numMain === numOther) return 'match';
    // ERP (other) >= BOM requirement (main) is acceptable (higher rating is fine)
    if (numOther >= numMain) return 'acceptable';
    return 'diff';
}

function compareRegexPower(mainVal, otherVal) {
    if (!mainVal && !otherVal) return 'missing';
    if (!mainVal || !otherVal) return 'missing';
    const numMain = parseFloat(mainVal.replace(/[^0-9.]/g, ''));
    const numOther = parseFloat(otherVal.replace(/[^0-9.]/g, ''));
    if (isNaN(numMain) || isNaN(numOther)) return 'diff';
    if (numMain === numOther) return 'match';
    // ERP (other) >= BOM requirement (main) is acceptable (higher capacity is fine)
    if (numOther >= numMain) return 'acceptable';
    return 'diff';
}

function compareRegexTolerance(mainVal, otherVal) {
    if (!mainVal && !otherVal) return 'missing';
    if (!mainVal || !otherVal) return 'missing';
    const parsedMain = parseTolerance(mainVal);
    const parsedOther = parseTolerance(otherVal);
    if (!parsedMain || !parsedOther) return 'diff';
    if (parsedMain.type !== parsedOther.type) return 'diff';
    if (parsedMain.value === parsedOther.value) return 'match';
    // ERP (other) <= BOM requirement (main) is acceptable (tighter tolerance is fine)
    if (parsedOther.value <= parsedMain.value) return 'acceptable';
    return 'diff';
}

// ============================================================
// HELPERS
// ============================================================

function normalizeValue(value) {
    if (!value) return null;
    let val = String(value).trim().toLowerCase();
    if (!val.includes('.') && val.includes(',')) val = val.replace(',', '.');

    // Milliohms first
    const mOhmMatch = val.match(/^(\d+(?:\.\d+)?)\s*m[ωΩ]$/i);
    if (mOhmMatch) return (parseFloat(mOhmMatch[1]) / 1000).toString();

    val = val.replace(/ω|ohm|ohms/g, '');
    val = val.replace(/µ/g, 'u');

    // Capacitor values - normalize to nanofarads
    const capMatch = val.match(/^([\d.]+)\s*(f|uf|nf|pf|ff)$/i);
    if (capMatch) {
        const num = parseFloat(capMatch[1]);
        const unit = capMatch[2].toLowerCase();
        let nfValue;
        if (unit === 'f') nfValue = num * 1e9;
        else if (unit === 'uf') nfValue = num * 1000;
        else if (unit === 'nf') nfValue = num;
        else if (unit === 'pf') nfValue = num / 1000;
        else nfValue = num / 1e6;
        return parseFloat(nfValue.toPrecision(10)).toString() + 'nf';
    }

    // Resistor R notation
    const rMatch = val.match(/^(\d+)r(\d*)$/i);
    if (rMatch) {
        const ohms = rMatch[2] ? parseFloat(`${rMatch[1]}.${rMatch[2]}`) : parseFloat(rMatch[1]);
        return ohms.toString();
    }

    // E notation
    const eMatch = val.match(/^(\d+)e(\d*)$/i);
    if (eMatch) {
        const ohms = eMatch[2] ? parseFloat(`${eMatch[1]}.${eMatch[2]}`) : parseFloat(eMatch[1]);
        return ohms.toString();
    }

    // Kilohm
    const kMatch = val.match(/^(\d+)k(\d*)$/i);
    if (kMatch) {
        const kOhms = kMatch[2] ? parseFloat(`${kMatch[1]}.${kMatch[2]}`) : parseFloat(kMatch[1]);
        return (kOhms * 1000).toString();
    }
    const decimalKMatch = val.match(/^(\d+\.\d+)\s*k$/i);
    if (decimalKMatch) return (parseFloat(decimalKMatch[1]) * 1000).toString();

    // Megaohm
    const packageCodes = ['0201', '0402', '0603', '0805', '1005', '1206', '1210', '1608', '1812', '2010', '2012', '2512'];
    const mMatch = val.match(/^(\d+)m(\d*)$/i);
    if (mMatch && !val.includes('f')) {
        if (!packageCodes.includes(mMatch[1])) {
            const mOhms = mMatch[2] ? parseFloat(`${mMatch[1]}.${mMatch[2]}`) : parseFloat(mMatch[1]);
            return (mOhms * 1000000).toString();
        }
    }
    const decimalMMatch = val.match(/^(\d+\.\d+)\s*m$/i);
    if (decimalMMatch && !val.includes('f')) return (parseFloat(decimalMMatch[1]) * 1000000).toString();

    // Plain number
    const plainMatch = val.match(/^(\d+(?:\.\d+)?)$/);
    if (plainMatch) return parseFloat(plainMatch[1]).toString();

    return val.replace(/\.0+$/, '');
}

function parseTolerance(toleranceStr) {
    if (!toleranceStr) return null;
    let val = String(toleranceStr).toLowerCase().trim();
    val = val.replace(/±|\+\/-|\+-|\+|-/g, '');
    val = val.replace(/(\d)\s+(\d)/g, '$1.$2');
    val = val.replace(/\s/g, '');
    if (!val.includes('.') && val.includes(',')) val = val.replace(',', '.');

    const capMatch = val.match(/^([\d.]+)(uf|nf|pf|ff)$/);
    if (capMatch) {
        const num = parseFloat(capMatch[1]);
        const unit = capMatch[2];
        let ffValue;
        if (unit === 'uf') ffValue = num * 1e9;
        else if (unit === 'nf') ffValue = num * 1e6;
        else if (unit === 'pf') ffValue = num * 1000;
        else ffValue = num;
        return { type: 'absolute', value: ffValue };
    }

    const percentMatch = val.match(/([\d.]+)%?/);
    if (percentMatch) return { type: 'percent', value: parseFloat(percentMatch[1]) };
    return null;
}

function getIndicatorClass(status) {
    switch (status) {
        case 'match': return 'param-match';
        case 'acceptable': return 'param-acceptable';
        case 'diff': return 'param-diff';
        case 'missing': return 'param-missing';
        default: return 'param-na';
    }
}

// ============================================================
// POPULATE PARAMS TABLE
// ============================================================

/**
 * Populate the params comparison table on the process page.
 * Reads bomData, matchResults, and selections globals from process.js.
 */
async function populateMatcherParamsTable() {
    const tbody = document.getElementById('paramsTableBody');
    if (!tbody || !bomData) return;

    // Ensure aliases are loaded before extraction
    if (_packageAliases === null) await loadPackageAliases();

    tbody.innerHTML = '';
    const mapping = bomData.column_mapping || {};
    const rows = bomData.rows || [];
    let extractedCount = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const strIdx = String(i);
        const match = matchResults[strIdx];
        const sel = selections[strIdx] || {};

        // Get customer BOM description (left side, supports multi-column mapping)
        const descMapping = mapping['Description'];
        let customerDesc = '';
        if (Array.isArray(descMapping)) {
            customerDesc = descMapping.map(c => String(row[c] || '').trim()).filter(v => v).join(' ');
        } else if (descMapping) {
            customerDesc = String(row[descMapping] || '');
        }

        // Get ERP match description (right side)
        let erpDesc = '';
        let displayItem = null;
        if (sel.fabernr && match && match.suggestions) {
            displayItem = match.suggestions.find(s => s.FaberNr === sel.fabernr);
        }
        if (!displayItem && match && match.auto_selected) {
            displayItem = match.auto_selected;
        }
        if (!displayItem && match && match.display_suggestion) {
            displayItem = match.display_suggestion;
        }
        if (displayItem) {
            erpDesc = String(displayItem.Omschrijving || '');
        }

        // Strip HTML tags from descriptions (they may contain highlight spans)
        const cleanCustomerDesc = customerDesc.replace(/<[^>]*>/g, '');
        const cleanErpDesc = erpDesc.replace(/<[^>]*>/g, '');

        // Extract and compare parameters (customer BOM = main = 1)
        const params = extractParametersFromDescription(cleanCustomerDesc, cleanErpDesc, 1);

        const tr = document.createElement('tr');
        tr.dataset.row = i;
        tr.addEventListener('click', () => selectRow(i));

        // Highlight selected row
        if (selectedRow === i) {
            tr.classList.add('row-selected');
        }

        const hasAnyParam = params.value1 || params.value2 ||
            params.tolerance1 || params.tolerance2 ||
            params.voltage1 || params.voltage2 ||
            params.package1 || params.package2;

        if (hasAnyParam) {
            extractedCount++;
            const isCapacitor = (params.value1 && /[pnuµ]F/i.test(params.value1)) ||
                (params.value2 && /[pnuµ]F/i.test(params.value2));
            const valueSymbol = isCapacitor ? '-||-' : 'Ω';

            const fmt = (bom, erp) => `BOM: ${bom || '\u2014'} | ERP: ${erp || '\u2014'}`;

            tr.innerHTML = `
                <td><span class="param-indicator ${getIndicatorClass(params.valueStatus)}" data-tip="${fmt(params.value1, params.value2)}">${valueSymbol}</span></td>
                <td><span class="param-indicator ${getIndicatorClass(params.toleranceStatus)}" data-tip="${fmt(params.tolerance1, params.tolerance2)}">%</span></td>
                <td><span class="param-indicator ${getIndicatorClass(params.voltageStatus)}" data-tip="${fmt(params.voltage1, params.voltage2)}">V</span></td>
                <td><span class="param-indicator ${getIndicatorClass(params.powerStatus)}" data-tip="${fmt(params.power1, params.power2)}">P</span></td>
                <td><span class="param-indicator ${getIndicatorClass(params.packageStatus)}" data-tip="${fmt(params.package1, params.package2)}">📦</span></td>
            `;
        } else {
            tr.innerHTML = `
                <td><span class="param-indicator param-na">-</span></td>
                <td><span class="param-indicator param-na">-</span></td>
                <td><span class="param-indicator param-na">-</span></td>
                <td><span class="param-indicator param-na">-</span></td>
                <td><span class="param-indicator param-na">-</span></td>
            `;
        }

        tbody.appendChild(tr);
    }

    // Update stats
    const stats = document.getElementById('paramsStats');
    if (stats) stats.textContent = extractedCount;

    // Init custom tooltips
    initParamIndicatorTooltips();

    // Re-sync row heights after params table is populated
    requestAnimationFrame(() => {
        if (typeof syncRowHeights === 'function') syncRowHeights();
    });
}

// ============================================================
// CUSTOM TOOLTIP FOR PARAM INDICATORS
// ============================================================

function initParamIndicatorTooltips() {
    // Create tooltip element if it doesn't exist
    let tooltip = document.getElementById('paramIndicatorTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'paramIndicatorTooltip';
        document.body.appendChild(tooltip);
    }

    // Use event delegation on the params scroll wrapper
    const wrapper = document.getElementById('paramsScroll');
    if (!wrapper) return;

    // Remove old listeners by replacing the wrapper's event-delegating clone
    // (safe: only the event listeners are removed, children stay)
    if (wrapper._paramTooltipInit) return;
    wrapper._paramTooltipInit = true;

    wrapper.addEventListener('mouseenter', (e) => {
        const indicator = e.target.closest('.param-indicator');
        if (indicator && indicator.dataset.tip) {
            tooltip.textContent = indicator.dataset.tip;
            tooltip.classList.add('visible');
        }
    }, true);

    wrapper.addEventListener('mousemove', (e) => {
        const indicator = e.target.closest('.param-indicator');
        if (indicator && indicator.dataset.tip) {
            tooltip.textContent = indicator.dataset.tip;

            const tooltipRect = tooltip.getBoundingClientRect();
            const tooltipWidth = tooltipRect.width || 150;
            const tooltipHeight = tooltipRect.height || 30;

            let x = e.clientX - tooltipWidth / 2;
            let y = e.clientY - tooltipHeight - 10;

            if (x + tooltipWidth > window.innerWidth) x = window.innerWidth - tooltipWidth - 5;
            if (x < 5) x = 5;
            if (y < 5) y = e.clientY + 20;

            tooltip.style.left = x + 'px';
            tooltip.style.top = y + 'px';
        }
    }, true);

    wrapper.addEventListener('mouseleave', (e) => {
        const indicator = e.target.closest('.param-indicator');
        if (indicator) {
            tooltip.classList.remove('visible');
        }
    }, true);
}
