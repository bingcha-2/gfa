/**
 * translate-req.js — Google Gemini → OpenAI Chat Completions request translation.
 *
 * Antigravity IDE sends requests in Google Gemini format:
 * {
 *   systemInstruction: { parts: [{ text: "..." }] },
 *   contents: [
 *     { role: "user",  parts: [{ text: "..." }] },
 *     { role: "model", parts: [{ text: "..." }] },
 *   ],
 *   generationConfig: { maxOutputTokens, temperature, topP, topK }
 * }
 *
 * We translate to OpenAI chat/completions format:
 * {
 *   model: "claude-sonnet-4-6",
 *   messages: [
 *     { role: "system", content: "..." },
 *     { role: "user", content: "..." },
 *     { role: "assistant", content: "..." },
 *   ],
 *   max_tokens: 8192,
 *   temperature: 0.7,
 *   stream: true
 * }
 */

'use strict';

/**
 * Translate a Gemini request body to an OpenAI Chat Completions request body.
 * @param {object} geminiBody - The parsed JSON body from Antigravity
 * @param {string} model - The resolved upstream model name
 * @param {boolean} isStream - Whether this is a streaming request
 * @returns {object} OpenAI-compatible request body
 */
function translateRequest(geminiBody, model, isStream) {
  const messages = [];

  // 1. System instruction → system message
  if (geminiBody.systemInstruction) {
    const systemText = extractPartsText(geminiBody.systemInstruction.parts);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // 2. Contents → messages
  if (Array.isArray(geminiBody.contents)) {
    for (const content of geminiBody.contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const converted = convertParts(content.parts);
      if (converted !== null) {
        messages.push({ role, content: converted });
      }
    }
  }

  // 3. Generation config → OpenAI parameters
  const gc = geminiBody.generationConfig || {};
  const result = {
    model,
    messages,
    stream: isStream,
  };

  // max_tokens — required by many providers
  if (gc.maxOutputTokens != null) {
    result.max_tokens = gc.maxOutputTokens;
  } else {
    result.max_tokens = 8192; // safe default
  }

  // Optional parameters
  if (gc.temperature != null) result.temperature = gc.temperature;
  if (gc.topP != null) result.top_p = gc.topP;

  // Stream options — request usage stats in the final chunk
  if (isStream) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

/**
 * Extract plain text from Gemini parts array.
 * @param {Array} parts - [{ text: "..." }, ...]
 * @returns {string}
 */
function extractPartsText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => p && p.text != null)
    .map(p => p.text)
    .join('\n');
}

/**
 * Convert Gemini parts to OpenAI content format.
 * - Single text part → string
 * - Multiple parts or image parts → array of content blocks
 *
 * @param {Array} parts
 * @returns {string|Array|null}
 */
function convertParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;

  // Check if any part has image data
  const hasImages = parts.some(p => p.inlineData);

  if (!hasImages && parts.length === 1 && parts[0].text != null) {
    // Simple case: single text part → string
    return parts[0].text;
  }

  if (!hasImages) {
    // Multiple text parts → join into single string
    return parts.map(p => p.text || '').join('\n');
  }

  // Mixed content (text + images) → array of content blocks
  const blocks = [];
  for (const part of parts) {
    if (part.text != null) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.inlineData) {
      // Gemini: { inlineData: { mimeType: "image/png", data: "base64..." } }
      // OpenAI: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
      const mime = part.inlineData.mimeType || 'image/png';
      const b64 = part.inlineData.data || '';
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      });
    }
  }
  return blocks;
}

module.exports = { translateRequest };
