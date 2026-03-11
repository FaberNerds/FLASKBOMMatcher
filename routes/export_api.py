"""
BOM Matcher - Export API Routes
Handles Excel export with added columns.
"""
import os
import logging
from flask import Blueprint, send_file, jsonify

import config
from services.session_service import (
    get_session_id, load_bom_data,
    load_matches, load_mpnfree, load_selections
)
from services.export_service import export_bom

logger = logging.getLogger(__name__)

export_bp = Blueprint('export', __name__)


@export_bp.route('/export', methods=['POST'])
def export():
    """Download BOM Excel with added FaberNr and MPNfree columns."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400

    session_id = get_session_id()
    headers = bom_data.get('headers', [])
    rows = bom_data.get('rows', [])
    matches = load_matches()
    mpnfree = load_mpnfree()
    selections = load_selections()

    # Generate output filename
    original_name = bom_data.get('name', 'BOM')
    base_name = os.path.splitext(original_name)[0]
    output_name = f"{base_name}_matched.xlsx"
    output_path = str(config.UPLOAD_FOLDER / f"{session_id}_{output_name}")

    try:
        export_bom(headers, rows, matches, mpnfree, selections, output_path)
        return send_file(
            output_path,
            as_attachment=True,
            download_name=output_name,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
    except Exception as e:
        logger.error(f"Export error: {e}")
        return jsonify({'error': f'Export failed: {str(e)}'}), 500
