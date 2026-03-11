"""
BOM Matcher - Page Routes
Serves the three main pages: Upload, Process, Settings
"""
from flask import Blueprint, render_template

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
