"""
BOM Matcher - Page Routes
Serves the three main pages: Upload, Process, Settings
"""
from flask import Blueprint, render_template, abort

from routes.logging_api import LOG_VIEWER_FILES

pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/')
def upload_page():
    """Screen 1: Upload & column mapping."""
    return render_template('upload.html')


@pages_bp.route('/process')
def process_page():
    """Screen 2: Processing table."""
    return render_template('process.html')


@pages_bp.route('/settings')
def settings_page():
    """Screen 3: Settings."""
    return render_template('settings.html')


@pages_bp.route('/settings/logs/<name>')
def log_viewer(name):
    """Live log viewer window for one whitelisted log file (Settings -> Logging)."""
    path = LOG_VIEWER_FILES.get(name)
    if path is None:
        abort(404)
    return render_template('log_viewer.html', log_name=name, log_filename=path.name)


@pages_bp.route('/settings/security-audit')
def security_audit():
    """Security audit history window (Settings -> Logging)."""
    return render_template('security_audit.html')


@pages_bp.route('/history')
def history_page():
    """Screen 4: BOM History."""
    return render_template('history.html')
