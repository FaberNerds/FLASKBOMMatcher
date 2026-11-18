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

// Known SMD package codes (imperial + metric). Shared by the package extractor
// and by the value parsers that must not read e.g. "1608M" as megaohms.
const PACKAGE_CODES = [
    '01005', '0201', '0402', '0603', '0805', '1005', '1206', '1210',
    '1608', '1616', '1812', '2010', '2012', '2220', '2512', '2520'
];

// Package prefix/suffix tags (loaded from settings; same defaults as Python backend)
const DEFAULT_PACKAGE_PREFIXES = ['SMD', 'CASE', 'RES', 'CER', 'CAP'];
const DEFAULT_PACKAGE_SUFFIXES = ['N', 'L'];
let _packageTags = null;

async function loadPackageTags() {
    try {
        const data = await apiCall('/api/settings/package-tags');
        _packageTags = data.success
            ? { prefixes: data.prefixes || [], suffixes: data.suffixes || [] }
            : { prefixes: DEFAULT_PACKAGE_PREFIXES, suffixes: DEFAULT_PACKAGE_SUFFIXES };
    } catch (e) {
        _packageTags = { prefixes: DEFAULT_PACKAGE_PREFIXES, suffixes: DEFAULT_PACKAGE_SUFFIXES };
    }
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build an alternation group from a list, longest first so "CASE" wins over "C"
function regexAlternation(list) {
    return [...list]
        .map(s => String(s).trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|');
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
    // Kilovolts: 2kV, 1,5 kV -> 2000V, 1500V (same as the Python find_voltage)
    const kvPattern = /(?:^|[\s,;])(\d+(?:[.,]\d+)?)\s*kV(?![A-Za-z0-9])/gi;
    const kvMatches = [...text.matchAll(kvPattern)];
    if (kvMatches.length > 0) {
        return String(parseFloat(kvMatches[0][1].replace(',', '.')) * 1000) + 'V';
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
    // Absolute capacitor tolerance with a ±, +/- or +- prefix: ±0.05pF, +/-0,05pF, and the short
    // "+/-0,05P" (P = pF) used in Exact descriptions (as BOM Compare). The prefix is required, so
    // the capacitance itself (0,5pF) is never taken for the tolerance.
    const absPattern = /(?:±|\+\s*\/?\s*-)\s*(\d+(?:[.,]\d+)?)\s*(pF|nF|uF|µF|fF|P)(?![A-Za-z])/gi;
    const absMatches = [...text.matchAll(absPattern)];
    if (absMatches.length > 0) {
        const value = absMatches[0][1].replace(',', '.');
        const unit = absMatches[0][2].toLowerCase().replace('µ', 'u');
        return value + ({ p: 'pF', pf: 'pF', nf: 'nF', uf: 'uF', ff: 'fF' }[unit] || unit);
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
    const packageCodes = PACKAGE_CODES;
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
    // SMD packages with optional glued prefix/suffix letters from settings:
    // 0402, SMD0603, CASE0805, RES1206N, CER0603N, RES1210L, ...
    const tags = _packageTags || { prefixes: DEFAULT_PACKAGE_PREFIXES, suffixes: DEFAULT_PACKAGE_SUFFIXES };
    const prefixAlt = regexAlternation(tags.prefixes);
    const suffixAlt = regexAlternation(tags.suffixes);
    const smdPattern = new RegExp(
        `${prefixAlt ? `(?:${prefixAlt})?` : ''}(?:\\b|(?<=[A-Za-z]))(${regexAlternation(PACKAGE_CODES)})${suffixAlt ? `(?:${suffixAlt})?` : ''}\\b`,
        'gi'
    );
    const smdMatches = [...text.matchAll(smdPattern)];
    if (smdMatches.length > 0) return smdMatches[0][1];
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
// Coils and ferrite beads (as BOM Compare's results-params.js). Their value is an inductance
// (coil) or an impedance (bead); voltage and power do not apply to them, nor the tolerance to a
// bead: those indicators show "not applicable" instead of grey "missing".
// A coil word wins over "ferrite": "Inductor Power Shielded ... Ferrite" is a coil, not a bead.
function inductiveKind(...descriptions) {
    const t = descriptions.map(d => d || '').join(' ').toUpperCase();
    if (/(?<![A-Z0-9])(SPOEL|SPOELEN|IND|INDUCTORS?|COILS?|CHOKES?)(?![A-Z0-9])/.test(t)) return 'inductor';
    if (/(?<![A-Z0-9])(FERRITES?|FERRIET|BEADS?)(?![A-Z0-9])/.test(t)) return 'bead';
    return null;
}

const NOT_APPLICABLE = {
    inductor: ['voltage', 'power'],
    bead: ['tolerance', 'voltage', 'power'],
};

// Inductance: 22uH, 4.3 nH, 2.2 µH (also the broken "�H" of some exports) -> "4.3nH", "2.2uH"
function extractInductanceValue(text) {
    const m = (text || '').match(/(?:^|[\s,;(])(\d+(?:[.,]\d+)?)\s*([nuµ�m])H\b/i);
    if (!m) return null;
    const unit = { n: 'nH', u: 'uH', 'µ': 'uH', '�': 'uH', m: 'mH' }[m[2].toLowerCase()] || 'uH';
    return m[1].replace(',', '.') + unit;
}

/**
 * Kind of a coil-like line. The server's group of the customer line (row_types) decides:
 * a resistor or capacitor line is never read as a coil because of its ERP match's text.
 */
function lineKind(desc1, desc2, groupHint) {
    if (groupHint === 'resistor' || groupHint === 'capacitor') return null;
    if (groupHint === 'inductor') return inductiveKind(desc1) || inductiveKind(desc2) || 'inductor';
    return inductiveKind(desc1, desc2);
}

function extractParametersFromDescription(desc1, desc2, mainBomNum, groupHint) {
    const kind = lineKind(desc1, desc2, groupHint);
    const valueOf = kind === 'inductor' ? extractInductanceValue : extractValueFromDescription;
    const value1 = valueOf(desc1);
    const value2 = valueOf(desc2);
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

    const params = {
        kind,
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
    // Not applicable to this kind of part, unless a description does state it
    (NOT_APPLICABLE[kind] || []).forEach(key => {
        if (!params[`${key}1`] && !params[`${key}2`]) params[`${key}Status`] = 'na';
    });
    return params;
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

    // Inductance - normalize to nanohenry (4.3nH, 2.2uH = 2200nH, 1mH)
    const indMatch = val.match(/^([\d.]+)\s*(nh|uh|mh)$/i);
    if (indMatch) {
        const factor = { nh: 1, uh: 1000, mh: 1e6 }[indMatch[2].toLowerCase()];
        return parseFloat((parseFloat(indMatch[1]) * factor).toPrecision(10)).toString() + 'nh';
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
    const packageCodes = PACKAGE_CODES;
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
// PARAM CELLS OF THE UNIFIED ROWS
// ============================================================

// The house-style package icon inside the 18px indicator (as BOM Compare's results-params.js)
const PACKAGE_ICON = '<svg class="param-icon" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-label="Package" role="img"><path d="M8 1.75l5.75 3v6.5L8 14.25l-5.75-3v-6.5z"/><path d="M2.25 4.75L8 7.75l5.75-3"/><path d="M8 7.75v6.5"/></svg>';

/** True once the package aliases and tags are loaded (needed for the package extraction). */
function paramSettingsLoaded() {
    return _packageAliases !== null && _packageTags !== null;
}

/** Load the package aliases and tags once (both in parallel). */
async function ensureParamSettings() {
    const jobs = [];
    if (_packageAliases === null) jobs.push(loadPackageAliases());
    if (_packageTags === null) jobs.push(loadPackageTags());
    await Promise.all(jobs);
}

function _paramNaCells(tip) {
    const t = escapeHtml(tip || '');
    let html = '';
    for (let k = 0; k < 5; k++) {
        html += `<td class="pc${k === 0 ? ' g-start' : ''}"><span class="param-indicator param-na" data-tip="${t}">–</span></td>`;
    }
    return html;
}

/**
 * The five parameter cells (value, tolerance, voltage, power, package) of one BOM line:
 * the customer BOM description (main) against the ERP Omschrijving of the line's match.
 * Reads bomData, matchResults and selections from process.js.
 */
function buildMatcherParamCells(rowIndex) {
    if (!bomData) return _paramNaCells('');
    const mapping = bomData.column_mapping || {};
    const row = (bomData.rows || [])[rowIndex] || {};
    const strIdx = String(rowIndex);
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
    let displayItem = null;
    if (sel.fabernr && match && match.suggestions) {
        displayItem = match.suggestions.find(s => s.FaberNr === sel.fabernr);
    }
    if (!displayItem && match && match.auto_selected) {
        displayItem = match.auto_selected;
    }
    if (!displayItem) return _paramNaCells(match ? 'No ERP match' : 'Not matched yet');
    const erpDesc = String(displayItem.Omschrijving || '');

    // Strip HTML tags from descriptions (they may contain highlight spans)
    const cleanCustomerDesc = customerDesc.replace(/<[^>]*>/g, '');
    const cleanErpDesc = erpDesc.replace(/<[^>]*>/g, '');

    // Extract and compare parameters (customer BOM = main = 1)
    const groupHint = bomData.row_types ? bomData.row_types[rowIndex] : undefined;
    const params = extractParametersFromDescription(cleanCustomerDesc, cleanErpDesc, 1, groupHint);

    const hasAnyParam = params.value1 || params.value2 ||
        params.tolerance1 || params.tolerance2 ||
        params.voltage1 || params.voltage2 ||
        params.package1 || params.package2;
    if (!hasAnyParam) return _paramNaCells('No parameters found');

    const isCapacitor = (params.value1 && /[pnuµ]F/i.test(params.value1)) ||
        (params.value2 && /[pnuµ]F/i.test(params.value2));
    const valueSymbol = params.kind === 'inductor' ? 'L' : (isCapacitor ? '-||-' : 'Ω');

    const fmt = (bom, erp) => escapeHtml(`BOM: ${bom || '—'} | ERP: ${erp || '—'}`);
    // A parameter that does not apply to a coil or bead: a dash, not a grey "missing"
    const naTip = `Not used for ${params.kind === 'bead' ? 'ferrite beads' : 'coils'}`;
    const ind = (status, tip, symbol) => status === 'na'
        ? `<span class="param-indicator param-na" data-tip="${naTip}">–</span>`
        : `<span class="param-indicator ${getIndicatorClass(status)}" data-tip="${tip}">${symbol}</span>`;

    return `<td class="pc g-start">${ind(params.valueStatus, fmt(params.value1, params.value2), valueSymbol)}</td>` +
        `<td class="pc">${ind(params.toleranceStatus, fmt(params.tolerance1, params.tolerance2), '%')}</td>` +
        `<td class="pc">${ind(params.voltageStatus, fmt(params.voltage1, params.voltage2), 'V')}</td>` +
        `<td class="pc">${ind(params.powerStatus, fmt(params.power1, params.power2), 'P')}</td>` +
        `<td class="pc">${ind(params.packageStatus, fmt(params.package1, params.package2), PACKAGE_ICON)}</td>`;
}

/**
 * Fill the param cells of the unified rows on the process page (after the package
 * settings are loaded). renderTables() builds the cells inline when the settings are
 * already there; this is the path for a render before they arrived.
 */
async function populateMatcherParamsTable() {
    const tbody = document.getElementById('matchTableBody');
    if (!tbody || !bomData) return;

    // Ensure aliases and package tags are loaded before extraction
    await ensureParamSettings();

    tbody.querySelectorAll('tr[data-row]').forEach(tr => {
        const cells = tr.querySelectorAll('td.pc');
        if (cells.length !== 5) return;
        const tmp = document.createElement('tr');
        tmp.innerHTML = buildMatcherParamCells(parseInt(tr.dataset.row, 10));
        const fresh = Array.from(tmp.children);
        cells.forEach((td, k) => { if (fresh[k]) td.replaceWith(fresh[k]); });
    });

    // Init custom tooltips
    initParamIndicatorTooltips();

    // The indicator column widths may have changed: fit the table again
    if (typeof fitMatchTable === 'function') fitMatchTable();
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

    // Event delegation on the scroll container of the one table (it survives re-renders)
    const wrapper = document.getElementById('matchSheet');
    if (!wrapper) return;

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
            tooltip.classList.add('visible');

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
        } else {
            tooltip.classList.remove('visible');
        }
    }, true);

    wrapper.addEventListener('mouseleave', (e) => {
        const indicator = e.target.closest('.param-indicator');
        if (indicator || e.target === wrapper) {
            tooltip.classList.remove('visible');
        }
    }, true);

    // A re-render or scroll can remove the indicator under the mouse: hide the tooltip
    wrapper.addEventListener('scroll', () => tooltip.classList.remove('visible'), { passive: true });
}
