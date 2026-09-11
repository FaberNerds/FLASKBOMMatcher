"""
package_tags_service.py

Configurable prefix/suffix letters that may be glued directly to an SMD
package code in a description, e.g. "RES1206N" -> prefix "RES",
package "1206", suffix "N". Stored as a JSON file in
~/.bommatcher/package_tags.json.

Also owns the canonical list of SMD package codes and builds the regex
used by both the BOM-side extractor (param_extract_service) and the
ERP-side index parser (category_index_service).

This module must not import other services (they import it).
"""

import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Canonical SMD package codes (imperial). Keep in sync with the <select>
# in templates/settings.html (Package Aliases card).
PACKAGE_CODES: List[str] = [
    "01005", "0201", "0402", "0603", "0805", "1206", "1210",
    "1812", "2010", "2220", "2512",
]

DEFAULT_PREFIXES: List[str] = ["SMD", "CASE", "RES", "CER", "CAP"]
DEFAULT_SUFFIXES: List[str] = ["N", "L"]

_TAGS_DIR = Path.home() / ".bommatcher"
_TAGS_FILE = _TAGS_DIR / "package_tags.json"

# Compiled-regex cache keyed on (prefixes, suffixes) tuples
_regex_cache: Dict[Tuple[Tuple[str, ...], Tuple[str, ...]], re.Pattern] = {}


def _clean_list(value) -> List[str]:
    """Accept a list or a comma-separated string; return stripped, uppercased, de-duplicated list."""
    if isinstance(value, str):
        value = value.split(",")
    out: List[str] = []
    for item in value or []:
        s = str(item).strip().upper()
        if s and s not in out:
            out.append(s)
    return out


def _load() -> Optional[Dict[str, List[str]]]:
    if not _TAGS_FILE.exists():
        return None
    try:
        data = json.loads(_TAGS_FILE.read_text(encoding="utf-8"))
        return {
            "prefixes": _clean_list(data.get("prefixes", DEFAULT_PREFIXES)),
            "suffixes": _clean_list(data.get("suffixes", DEFAULT_SUFFIXES)),
        }
    except Exception as e:
        logger.error("Failed to load package tags: %s", e)
        return None


def get_package_tags() -> Dict[str, List[str]]:
    """Return configured prefix/suffix tags, falling back to defaults."""
    tags = _load()
    if tags is None:
        return {"prefixes": list(DEFAULT_PREFIXES), "suffixes": list(DEFAULT_SUFFIXES)}
    return tags


def save_package_tags(prefixes, suffixes) -> Dict[str, List[str]]:
    """Persist prefix/suffix tags. Accepts lists or comma-separated strings."""
    tags = {"prefixes": _clean_list(prefixes), "suffixes": _clean_list(suffixes)}
    _TAGS_DIR.mkdir(parents=True, exist_ok=True)
    _TAGS_FILE.write_text(json.dumps(tags, indent=2), encoding="utf-8")
    return tags


def reset_package_tags() -> Dict[str, List[str]]:
    """Restore the default tags."""
    return save_package_tags(DEFAULT_PREFIXES, DEFAULT_SUFFIXES)


def _alternation(items: List[str]) -> str:
    """Regex alternation, longest first so 'CASE' wins over 'C'."""
    return "|".join(re.escape(s) for s in sorted(items, key=len, reverse=True))


def build_smd_regex(prefixes: List[str], suffixes: List[str]) -> re.Pattern:
    """
    Build (and cache) the SMD package regex:
        (?:PREFIXES)?(?:\\b|(?<=[A-Za-z]))(CODES)(?:SUFFIXES)?\\b
    Group 1 is the bare package code.
    """
    key = (tuple(prefixes), tuple(suffixes))
    pat = _regex_cache.get(key)
    if pat is None:
        prefix_part = f"(?:{_alternation(prefixes)})?" if prefixes else ""
        suffix_part = f"(?:{_alternation(suffixes)})?" if suffixes else ""
        pat = re.compile(
            rf"{prefix_part}(?:\b|(?<=[A-Za-z]))({_alternation(PACKAGE_CODES)}){suffix_part}\b",
            re.IGNORECASE,
        )
        _regex_cache[key] = pat
    return pat


def get_smd_regex() -> re.Pattern:
    """SMD package regex built from the currently configured tags."""
    tags = get_package_tags()
    return build_smd_regex(tags["prefixes"], tags["suffixes"])


def find_smd_package(text: str) -> Optional[str]:
    """Return the first bare SMD package code found in text, or None."""
    if not text:
        return None
    m = get_smd_regex().search(text)
    return m.group(1) if m else None
