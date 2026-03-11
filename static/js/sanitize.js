/**
 * sanitize.js
 * HTML sanitization utilities to prevent XSS attacks
 */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text - The text to escape
 * @returns {string} - Escaped text safe for innerHTML
 */
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    const str = String(text);
    const htmlEscapes = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
}

/**
 * Create a text node safely (alternative to innerHTML)
 * @param {string} text - The text content
 * @returns {Text} - A safe text node
 */
function safeText(text) {
    return document.createTextNode(text || '');
}

/**
 * Set element text content safely
 * @param {HTMLElement} element - The element to update
 * @param {string} text - The text content
 */
function safeSetText(element, text) {
    if (element) {
        element.textContent = text || '';
    }
}

/**
 * Sanitize user input for use in HTML templates.
 * This is a simple sanitizer - for untrusted HTML, consider DOMPurify.
 * @param {Object} data - Object with values to sanitize
 * @returns {Object} - Object with escaped values
 */
function sanitizeObject(data) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            sanitized[key] = escapeHtml(value);
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// Make functions globally available
window.escapeHtml = escapeHtml;
window.safeText = safeText;
window.safeSetText = safeSetText;
window.sanitizeObject = sanitizeObject;
