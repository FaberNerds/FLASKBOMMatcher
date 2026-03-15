"""
BOM Matcher - Upload API Routes
Handles file upload, column mapping, and BOM data retrieval.
"""
import os
import logging
from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename

import config
from services.file_service import allowed_file, read_file, get_sheet_names, get_file_preview
from services.session_service import (
    get_session_id, save_bom_data, load_bom_data,
    save_mapping_history, load_mapping_history,
    load_matches, load_mpnfree, load_selections,
    save_to_history, has_process_data, clear_process_data
)
from services.klant_cache_service import get_all_klanten

logger = logging.getLogger(__name__)

upload_bp = Blueprint('upload', __name__)


@upload_bp.route('/upload', methods=['POST'])
def upload_file():
    """Upload a BOM file (xlsx, xls, csv)."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if not allowed_file(file.filename, config.ALLOWED_EXTENSIONS):
        return jsonify({'error': 'File type not allowed. Use xlsx, xls, or csv.'}), 400

    session_id = get_session_id()
    filename = secure_filename(file.filename)
    # Prefix with session ID to avoid collisions
    save_name = f"{session_id}_{filename}"
    file_path = os.path.join(str(config.UPLOAD_FOLDER), save_name)
    file.save(file_path)

    try:
        # Read file with default header row
        headers, rows = read_file(file_path, header_row=0)

        # Get sheet names for Excel files
        sheets = get_sheet_names(file_path)

        # Save to session
        save_bom_data({
            'name': filename,
            'file_path': file_path,
            'headers': headers,
            'rows': rows,
            'header_row': 0,
            'sheet_name': None,
            'column_mapping': {}
        })

        # Check for previously stored settings for this filename
        previous_settings = load_mapping_history(filename)

        result = {
            'success': True,
            'filename': filename,
            'headers': headers,
            'preview_rows': rows[:50],
            'total_rows': len(rows),
            'sheets': sheets,
            'has_process_data': has_process_data(),
        }
        if previous_settings:
            result['previous_settings'] = previous_settings

        return jsonify(result)

    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        return jsonify({'error': f'Failed to read file: {str(e)}'}), 400


@upload_bp.route('/sheets', methods=['GET'])
def list_sheets():
    """List sheet names from the uploaded Excel file."""
    bom_data = load_bom_data()
    if not bom_data or not bom_data.get('file_path'):
        return jsonify({'error': 'No file uploaded'}), 400

    sheets = get_sheet_names(bom_data['file_path'])
    return jsonify({'sheets': sheets})


@upload_bp.route('/reload', methods=['POST'])
def reload_file():
    """Reload file with different header row, sheet, or row range."""
    bom_data = load_bom_data()
    if not bom_data or not bom_data.get('file_path'):
        return jsonify({'error': 'No file uploaded'}), 400

    data = request.get_json()
    header_row = data.get('header_row', 0)
    sheet_name = data.get('sheet_name', None)
    start_row = data.get('start_row', None)
    end_row = data.get('end_row', None)

    try:
        headers, rows = read_file(
            bom_data['file_path'],
            header_row=header_row,
            start_row=start_row,
            end_row=end_row,
            sheet_name=sheet_name
        )

        bom_data['headers'] = headers
        bom_data['rows'] = rows
        bom_data['header_row'] = header_row
        bom_data['sheet_name'] = sheet_name
        bom_data['start_row'] = start_row
        bom_data['end_row'] = end_row
        save_bom_data(bom_data)

        return jsonify({
            'success': True,
            'headers': headers,
            'preview_rows': rows[:50],
            'total_rows': len(rows)
        })
    except Exception as e:
        logger.error(f"Error reloading file: {e}")
        return jsonify({'error': f'Failed to reload: {str(e)}'}), 400


@upload_bp.route('/klanten', methods=['GET'])
def list_klanten():
    """Return all customers (KlantNr/KlantNaam) for the customer selector."""
    try:
        klanten = get_all_klanten()
        return jsonify({'klanten': klanten})
    except Exception as e:
        logger.error(f"Error loading klanten: {e}")
        return jsonify({'error': f'Failed to load customers: {str(e)}'}), 500


@upload_bp.route('/set-mapping', methods=['POST'])
def set_mapping():
    """Save column mapping and optional customer selection."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No file uploaded'}), 400

    data = request.get_json()
    mapping = data.get('mapping', {})
    klant_nr = data.get('klant_nr', '')

    bom_data['column_mapping'] = mapping
    bom_data['klant_nr'] = klant_nr
    save_bom_data(bom_data)

    # Persist settings for future re-uploads of the same file
    save_mapping_history(bom_data.get('name', ''), {
        'column_mapping': mapping,
        'klant_nr': klant_nr,
        'header_row': bom_data.get('header_row', 0),
        'sheet_name': bom_data.get('sheet_name'),
        'start_row': bom_data.get('start_row'),
        'end_row': bom_data.get('end_row'),
    })

    # Auto-store in BOM history
    session_id = get_session_id()
    save_to_history(session_id, bom_data.get('name', ''), klant_nr)

    return jsonify({'success': True})


@upload_bp.route('/bom-data', methods=['GET'])
def get_bom_data():
    """Get current BOM data and mapping."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No file uploaded'}), 400

    return jsonify({
        'headers': bom_data.get('headers', []),
        'rows': bom_data.get('rows', []),
        'column_mapping': bom_data.get('column_mapping', {}),
        'total_rows': len(bom_data.get('rows', [])),
        'name': bom_data.get('name', ''),
        'matches': load_matches() or {},
        'mpnfree': load_mpnfree() or {},
        'selections': load_selections() or {},
    })


@upload_bp.route('/upload-state', methods=['GET'])
def get_upload_state():
    """Return current upload state for back-navigation restoration."""
    bom_data = load_bom_data()
    if not bom_data or not bom_data.get('name'):
        return jsonify({'has_state': False})

    sheets = []
    file_path = bom_data.get('file_path')
    if file_path and os.path.exists(file_path):
        sheets = get_sheet_names(file_path)

    return jsonify({
        'has_state': True,
        'filename': bom_data.get('name', ''),
        'headers': bom_data.get('headers', []),
        'preview_rows': bom_data.get('rows', [])[:50],
        'total_rows': len(bom_data.get('rows', [])),
        'sheets': sheets,
        'header_row': bom_data.get('header_row', 0),
        'sheet_name': bom_data.get('sheet_name'),
        'start_row': bom_data.get('start_row'),
        'end_row': bom_data.get('end_row'),
        'column_mapping': bom_data.get('column_mapping', {}),
        'klant_nr': bom_data.get('klant_nr', ''),
        'has_process_data': has_process_data(),
    })


@upload_bp.route('/clear-process-data', methods=['POST'])
def clear_process_data_endpoint():
    """Clear stored process-page data (matches, mpnfree, selections) for the current BOM."""
    deleted = clear_process_data()
    return jsonify({'success': True, 'cleared': deleted})
