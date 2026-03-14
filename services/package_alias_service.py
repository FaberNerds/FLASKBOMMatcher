"""
package_alias_service.py

Manages user-defined package aliases that map custom text patterns
(e.g. "UNIFIED-C0603") to standard package sizes (e.g. "0603").
Stored as a JSON file in ~/.bommatcher/package_aliases.json.
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

VALID_PACKAGES = {
    "0201", "0402", "0603", "0805", "1206", "1210",
    "1812", "2010", "2512", "01005", "2220",
}

_ALIAS_DIR = Path.home() / ".bommatcher"
_ALIAS_FILE = _ALIAS_DIR / "package_aliases.json"


def _load() -> List[Dict[str, str]]:
    """Load aliases from disk."""
    if not _ALIAS_FILE.exists():
        return []
    try:
        data = json.loads(_ALIAS_FILE.read_text(encoding="utf-8"))
        return data.get("aliases", [])
    except Exception as e:
        logger.error("Failed to load package aliases: %s", e)
        return []


def _save(aliases: List[Dict[str, str]]) -> None:
    """Save aliases to disk."""
    _ALIAS_DIR.mkdir(parents=True, exist_ok=True)
    _ALIAS_FILE.write_text(
        json.dumps({"aliases": aliases}, indent=2),
        encoding="utf-8",
    )


def get_aliases() -> List[Dict[str, str]]:
    """Return all configured package aliases."""
    return _load()


def add_alias(pattern: str, package: str) -> Dict[str, str]:
    """Add a new alias. Raises ValueError on invalid input or duplicate."""
    pattern = pattern.strip()
    package = package.strip()
    if not pattern:
        raise ValueError("Pattern cannot be empty")
    if package not in VALID_PACKAGES:
        raise ValueError(f"Package must be one of: {', '.join(sorted(VALID_PACKAGES))}")

    aliases = _load()
    for a in aliases:
        if a["pattern"].upper() == pattern.upper():
            raise ValueError(f"Alias for '{pattern}' already exists")

    alias = {"pattern": pattern, "package": package}
    aliases.append(alias)
    _save(aliases)
    return alias


def remove_alias(pattern: str) -> bool:
    """Remove an alias by pattern (case-insensitive). Returns True if found."""
    aliases = _load()
    pattern_upper = pattern.strip().upper()
    new_aliases = [a for a in aliases if a["pattern"].upper() != pattern_upper]
    if len(new_aliases) == len(aliases):
        return False
    _save(new_aliases)
    return True


def resolve_package_alias(text: str) -> Optional[str]:
    """Check if any alias pattern appears in text. Return mapped package or None."""
    if not text:
        return None
    aliases = _load()
    if not aliases:
        return None
    text_upper = text.upper()
    for alias in aliases:
        if alias["pattern"].upper() in text_upper:
            return alias["package"]
    return None
