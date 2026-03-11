"""
BOM Compare - Cleanup Service
Handles automatic cleanup of old uploaded files.
"""
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def cleanup_old_files(
    folder: Path, 
    retention_hours: int = 24,
    extensions: Optional[set] = None
) -> int:
    """
    Delete files older than the retention period.
    
    Args:
        folder: Path to the folder to clean
        retention_hours: Files older than this will be deleted
        extensions: Optional set of extensions to clean (e.g., {'.xlsx', '.csv'})
                   If None, cleans all files
    
    Returns:
        Number of files deleted
    """
    if not folder.exists():
        return 0
    
    retention_seconds = retention_hours * 3600
    cutoff_time = time.time() - retention_seconds
    deleted_count = 0
    
    try:
        for file_path in folder.iterdir():
            if not file_path.is_file():
                continue
            
            # Check extension filter
            if extensions and file_path.suffix.lower() not in extensions:
                continue
            
            # Check file age
            try:
                mtime = file_path.stat().st_mtime
                if mtime < cutoff_time:
                    file_path.unlink()
                    deleted_count += 1
                    logger.debug(f"Deleted old file: {file_path.name}")
            except OSError as e:
                logger.warning(f"Could not delete file {file_path}: {e}")
        
        if deleted_count > 0:
            logger.info(f"Cleanup: deleted {deleted_count} files older than {retention_hours}h from {folder}")
        
    except Exception as e:
        logger.error(f"Error during file cleanup: {e}")
    
    return deleted_count


def get_folder_stats(folder: Path) -> dict:
    """
    Get statistics about files in a folder.
    
    Args:
        folder: Path to the folder
    
    Returns:
        Dict with file_count, total_size_mb, oldest_file_hours
    """
    if not folder.exists():
        return {'file_count': 0, 'total_size_mb': 0, 'oldest_file_hours': 0}
    
    file_count = 0
    total_size = 0
    oldest_mtime = time.time()
    
    for file_path in folder.iterdir():
        if file_path.is_file():
            file_count += 1
            try:
                stat = file_path.stat()
                total_size += stat.st_size
                oldest_mtime = min(oldest_mtime, stat.st_mtime)
            except OSError:
                pass
    
    oldest_hours = (time.time() - oldest_mtime) / 3600 if file_count > 0 else 0
    
    return {
        'file_count': file_count,
        'total_size_mb': round(total_size / (1024 * 1024), 2),
        'oldest_file_hours': round(oldest_hours, 1)
    }


def force_cleanup_all_files(
    folder: Path, 
    extensions: Optional[set] = None,
    exclude_patterns: Optional[list] = None
) -> int:
    """
    Delete ALL files in the folder regardless of age.
    
    Args:
        folder: Path to the folder to clean
        extensions: Optional set of extensions to clean (e.g., {'.xlsx', '.csv'})
                   If None, cleans all files except excluded patterns
        exclude_patterns: List of filename patterns to exclude (e.g., ['*.json'])
    
    Returns:
        Number of files deleted
    """
    if not folder.exists():
        return 0
    
    # Default exclude patterns - don't delete config/state files
    if exclude_patterns is None:
        exclude_patterns = ['*.json']
    
    deleted_count = 0
    
    try:
        for file_path in folder.iterdir():
            if not file_path.is_file():
                continue
            
            # Check extension filter
            if extensions and file_path.suffix.lower() not in extensions:
                continue
            
            # Check exclude patterns
            skip = False
            for pattern in exclude_patterns:
                if pattern.startswith('*'):
                    if file_path.name.endswith(pattern[1:]):
                        skip = True
                        break
                elif pattern in file_path.name:
                    skip = True
                    break
            
            if skip:
                continue
            
            # Delete the file
            try:
                file_path.unlink()
                deleted_count += 1
                logger.debug(f"Force deleted file: {file_path.name}")
            except OSError as e:
                logger.warning(f"Could not delete file {file_path}: {e}")
        
        if deleted_count > 0:
            logger.info(f"Force cleanup: deleted {deleted_count} files from {folder}")
        
    except Exception as e:
        logger.error(f"Error during force cleanup: {e}")
    
    return deleted_count
