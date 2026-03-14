"""
BOM Matcher - AI Service
Mistral AI integration for MPNfree detection and search term generation.
Uses Mistral Large with OpenRouter fallback, same pattern as BOMcompare.
"""
import json
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    logger.warning("requests module not installed - AI features unavailable")


AI_PROVIDERS = {
    'mistral': {
        'url': 'https://api.mistral.ai/v1/chat/completions',
        'model': 'mistral-large-latest',
        'headers_fn': lambda key: {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
    },
    'openrouter': {
        'url': 'https://openrouter.ai/api/v1/chat/completions',
        'model': 'google/gemini-3-flash-preview',
        'headers_fn': lambda key: {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://bommatcher.local",
            "X-Title": "BOM Matcher"
        }
    },
    'ollama': {
        'url': 'http://DESKTOP-DANIELCLEAVER:11434/v1/chat/completions',
        'model': 'qwen3.5:9b',
        'headers_fn': lambda key: {
            "Content-Type": "application/json"
        }
    }
}


def _call_ai(prompt: str, api_key: str, provider: str = 'mistral',
             max_tokens: int = 2000, temperature: float = 0.1) -> Optional[str]:
    """Make an AI API call and return the response content string."""
    if not REQUESTS_AVAILABLE:
        logger.error("requests module not available")
        return None
    if not api_key and provider != 'ollama':
        logger.error("AI API key not configured")
        return None

    provider_config = dict(AI_PROVIDERS.get(provider, AI_PROVIDERS['mistral']))

    # Ollama: override URL/model from user settings, disable reasoning
    if provider == 'ollama':
        from services.credential_service import get_ollama_settings
        settings = get_ollama_settings()
        provider_config['url'] = f"{settings['host'].rstrip('/')}/v1/chat/completions"
        provider_config['model'] = settings['model']
        prompt = prompt + "\n/no_think"

    timeout = 120 if provider == 'ollama' else 60

    try:
        response = requests.post(
            provider_config['url'],
            headers=provider_config['headers_fn'](api_key),
            json={
                "model": provider_config['model'],
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": max_tokens
            },
            timeout=timeout
        )
        response.raise_for_status()
        data = response.json()
        content = data.get('choices', [{}])[0].get('message', {}).get('content', '')

        # Strip <think>...</think> blocks (safety net for reasoning models)
        content = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()

        # Strip markdown code blocks if present
        if content.startswith('```'):
            lines = content.split('\n')
            content = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])

        return content
    except Exception as e:
        logger.error(f"AI API call failed ({provider}): {e}")
        return None


def assess_mpnfree_batch(
    rows: list[dict],
    api_key: str,
    provider: str = 'mistral',
    batch_size: int = 10
) -> list[dict]:
    """
    Batch-assess MPNfree status for BOM rows.

    Args:
        rows: List of dicts with keys 'mpn', 'manufacturer', 'description', 'index'
        api_key: API key for the provider
        provider: 'mistral' or 'openrouter'
        batch_size: Rows per API call

    Returns:
        List of dicts with {index, mpnfree: bool, reason: str}
    """
    results = []

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]

        prompt_parts = [
            "Analyze each BOM line and determine if it is 'MPNfree' (a standard generic component where we can buy from any manufacturer).\n",
            "Rules for MPNfree = YES (ONLY these standard passive components):",
            "- Standard RESISTORS: descriptions containing RES, resistor, ohm, or E-notation values (4R7, 8E2, 100K), with standard packages (0201, 0402, 0603, 0805, 1206) and standard tolerances (1%, 5%)",
            "- Standard CAPACITORS: descriptions containing CAP, capacitor, or dielectric codes (X7R, C0G, NP0, X5R, Y5V), with standard packages (0201, 0402, 0603, 0805, 1206) and standard capacitance values (pF, nF, uF)\n",
            "Rules for MPNfree = NO (everything else):",
            "- Components with a specific MPN AND specific manufacturer → NOT MPNfree",
            "- ICs, microcontrollers, FPGAs, ASICs, voltage regulators → NOT MPNfree",
            "- Connectors, crystals, oscillators, LEDs with specific part numbers → NOT MPNfree",
            "- Inductors, ferrite beads, transformers → NOT MPNfree",
            "- Any component that is NOT a standard resistor or capacitor → NOT MPNfree\n",
            "BOM lines to analyze:"
        ]

        for idx, row in enumerate(batch):
            prompt_parts.append(
                f'{idx + 1}. MPN: "{row.get("mpn", "")}", '
                f'Manufacturer: "{row.get("manufacturer", "")}", '
                f'Description: "{row.get("description", "")}"'
            )

        prompt_parts.append(
            '\nReturn ONLY a valid JSON array, no markdown. Each object: '
            '{"mpnfree": true/false, "reason": "brief reason"}'
        )

        content = _call_ai('\n'.join(prompt_parts), api_key, provider)
        if content:
            try:
                batch_results = json.loads(content)
                for j, result in enumerate(batch_results):
                    if j < len(batch):
                        results.append({
                            'index': batch[j]['index'],
                            'mpnfree': result.get('mpnfree', False),
                            'reason': result.get('reason', '')
                        })
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse MPNfree response: {e}")
                for row in batch:
                    results.append({
                        'index': row['index'],
                        'mpnfree': False,
                        'reason': 'AI parse error'
                    })
        else:
            for row in batch:
                results.append({
                    'index': row['index'],
                    'mpnfree': False,
                    'reason': 'AI call failed'
                })

    return results


def generate_search_terms_batch(
    rows: list[dict],
    erp_examples: str,
    api_key: str,
    provider: str = 'mistral',
    batch_size: int = 10
) -> list[dict]:
    """
    Generate Exact DB search terms for rows without MPN.

    Args:
        rows: List of dicts with 'description', 'index'
        erp_examples: User-configured ERP description examples
        api_key: API key
        provider: 'mistral' or 'openrouter'
        batch_size: Rows per API call

    Returns:
        List of dicts with {index, search_terms: [str, ...]}
    """
    results = []

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]

        prompt_parts = [
            "You are helping search an ERP database (Exact Globe) for electronic components.",
            "Given BOM line descriptions, generate 2-4 search terms that would match the component in the ERP system.",
            "The ERP descriptions use this format (examples from the database):\n"
        ]

        if erp_examples:
            prompt_parts.append(erp_examples)
        else:
            prompt_parts.append(
                "RES 10K 1% 0,125W 0805\n"
                "CAP 100NF 50V X7R 0402\n"
                "IC REG LIN 3.3V 500MA SOT223\n"
                "LED RED 0603 20MA"
            )

        prompt_parts.append("\nBOM descriptions to generate search terms for:")

        for idx, row in enumerate(batch):
            prompt_parts.append(f'{idx + 1}. "{row.get("description", "")}"')

        prompt_parts.append(
            '\nReturn ONLY a valid JSON array of arrays. Each inner array contains 2-4 search term strings. '
            'Example: [["RES", "10K", "0805"], ["CAP", "100NF", "X7R"]]'
        )

        content = _call_ai('\n'.join(prompt_parts), api_key, provider)
        if content:
            try:
                batch_results = json.loads(content)
                for j, terms in enumerate(batch_results):
                    if j < len(batch):
                        results.append({
                            'index': batch[j]['index'],
                            'search_terms': terms if isinstance(terms, list) else []
                        })
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse search terms response: {e}")
                for row in batch:
                    results.append({
                        'index': row['index'],
                        'search_terms': []
                    })
        else:
            for row in batch:
                results.append({
                    'index': row['index'],
                    'search_terms': []
                })

    return results
