"""
BOM Matcher - Logging API Routes
Live log viewer and security audit history (Settings -> Logging).
"""
import logging
import os
from flask import Blueprint, request, jsonify, abort
import config
from services import vulnerability_audit_service

logger = logging.getLogger(__name__)

logs_bp = Blueprint('logs', __name__)

# Only these files can be viewed; the client passes a name, never a path.
LOG_VIEWER_FILES = {
    'server': config.LOG_FILE,
    'stdout': config.SERVICE_STDOUT_LOG,
    'stderr': config.SERVICE_STDERR_LOG,
}
LOG_TAIL_INITIAL_BYTES = 256 * 1024  # How much history the viewer loads on open
LOG_TAIL_MAX_CHUNK = 512 * 1024      # Max bytes returned per poll


@logs_bp.route('/logs/<name>/tail')
def log_tail(name: str):
    """Return the log text appended since ``offset`` (a byte position).

    Without an offset (or when the file shrank, e.g. after log rotation) it
    returns the last ~256 KB. Only whole lines are returned, so the next poll
    continues exactly where this one stopped.

    Args:
        name: Whitelisted log name ('server', 'stdout' or 'stderr').

    Returns:
        JSON with the new text and the offset to pass on the next poll.
    """
    path = LOG_VIEWER_FILES.get(name)
    if path is None:
        abort(404)
    offset = request.args.get('offset', default=-1, type=int)

    if not path.exists():
        return jsonify({'success': True, 'exists': False, 'size': 0,
                        'offset': 0, 'text': '', 'reset': offset > 0})

    try:
        with open(path, 'rb') as f:
            size = os.fstat(f.fileno()).st_size
            reset = offset > size
            from_tail = offset < 0 or reset
            start = max(0, size - LOG_TAIL_INITIAL_BYTES) if from_tail else offset

            f.seek(start)
            data = f.read(LOG_TAIL_MAX_CHUNK)

        # Starting mid-file: drop the partial first line
        if from_tail and start > 0:
            first_nl = data.find(b'\n')
            skip = first_nl + 1 if first_nl >= 0 else len(data)
            data = data[skip:]
            start += skip

        # Return complete lines only; the rest is picked up by the next poll
        # (unless one line fills a whole chunk, which would otherwise stall)
        last_nl = data.rfind(b'\n')
        if last_nl >= 0:
            data = data[:last_nl + 1]
        elif len(data) < LOG_TAIL_MAX_CHUNK:
            data = b''

        return jsonify({
            'success': True,
            'exists': True,
            'size': size,
            'offset': start + len(data),
            'text': data.decode('utf-8', errors='replace'),
            'reset': reset,
        })
    except OSError as e:
        logger.error(f"Failed to read log {path.name}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@logs_bp.route('/security-audit/reports')
def security_audit_reports():
    """Return a summary of all saved audit reports, newest first."""
    return jsonify({
        'success': True,
        'running': vulnerability_audit_service.is_running(),
        'reports': vulnerability_audit_service.list_reports(),
    })


@logs_bp.route('/security-audit/reports/<report_id>')
def security_audit_report(report_id: str):
    """Return one full audit report.

    Args:
        report_id: Report id (timestamp, e.g. '20261027_160000').
    """
    report = vulnerability_audit_service.get_report(report_id)
    if report is None:
        abort(404)
    return jsonify({'success': True, 'report': report})


@logs_bp.route('/security-audit/run', methods=['POST'])
def security_audit_run():
    """Run an audit now and return the new report."""
    report = vulnerability_audit_service.run_audit(trigger='manual')
    if report is None:
        return jsonify({'success': False, 'error': 'An audit is already running.'}), 409
    return jsonify({'success': True, 'report': report})
