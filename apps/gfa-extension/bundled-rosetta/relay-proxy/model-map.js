/**
 * Model name mapping: Antigravity internal names → NewAPI (upstream) model names.
 *
 * Antigravity IDE sends requests with model names like:
 *   POST /v1beta/models/antigravity-claude-sonnet-4-20250514:streamGenerateContent
 *
 * We extract "antigravity-claude-sonnet-4-20250514" from the URL and map it
 * to the corresponding model name on the upstream NewAPI instance.
 */

'use strict';

const MODEL_MAP = {
  // Claude models — need Gemini→OpenAI translation
  'antigravity-claude-sonnet-4-20250514':   'claude-sonnet-4-6',
  'antigravity-claude-sonnet-4.6-thinking': 'claude-opus-4-6-thinking',

  // Gemini models (for reference — these could also be proxied)
  'antigravity-gemini-2.5-pro':             'gemini-3.1-pro-high',
  'antigravity-gemini-2.5-pro-low':         'gemini-3.1-pro-low',
};

/**
 * Resolve an Antigravity model name to the upstream model name.
 * Falls back to stripping the "antigravity-" prefix if no explicit mapping exists.
 */
function resolveModel(antigravityModel) {
  if (!antigravityModel) return 'claude-sonnet-4-6';
  const mapped = MODEL_MAP[antigravityModel];
  if (mapped) return mapped;
  // Fallback: strip "antigravity-" prefix
  if (antigravityModel.startsWith('antigravity-')) {
    return antigravityModel.slice('antigravity-'.length);
  }
  return antigravityModel;
}

/**
 * Extract the model name from a Gemini-format URL path.
 * Input:  "/v1beta/models/antigravity-claude-sonnet-4-20250514:streamGenerateContent"
 * Output: "antigravity-claude-sonnet-4-20250514"
 */
function extractModelFromPath(urlPath) {
  // Match: /v1beta/models/{model}:streamGenerateContent
  // Also handle: /v1beta/models/{model}:generateContent
  const match = urlPath.match(/\/models\/([^/:]+)/);
  return match ? match[1] : '';
}

module.exports = { MODEL_MAP, resolveModel, extractModelFromPath };
