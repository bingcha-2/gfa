/**
 * translate-res.js — OpenAI SSE → Google Gemini SSE response translation.
 *
 * OpenAI streaming format:
 *   data: {"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}
 *   data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Google Gemini streaming format:
 *   data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"modelVersion":"..."}
 *   data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, '../../../../logs/relay-proxy-raw.log');

function debugLog(msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(logFile, `[${ts}] ${msg}\n`);
  } catch (e) { /* ignore */ }
}

/**
 * Create a stateful SSE translator that processes an OpenAI SSE stream
 * and writes Google Gemini SSE chunks to the client response.
 *
 * @param {http.ServerResponse} clientRes - The response to the Antigravity IDE
 * @param {string} modelVersion - Model version string for the response
 * @returns {{ processChunk: (rawChunk: string) => void, finish: () => void }}
 */
function createSSETranslator(clientRes, modelVersion) {
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finished = false;
  let inThinking = false;

  function writeGeminiSSE(obj) {
    if (finished) return;
    try {
      clientRes.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch { /* client disconnected */ }
  }

  function processChunk(rawChunk) {
    if (finished) return;

    buffer += rawChunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('event:')) continue;

      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();

      if (dataStr === '[DONE]') {
        finish();
        return;
      }

      let data;
      try { data = JSON.parse(dataStr); }
      catch (e) {
        debugLog(`JSON Parse Error: ${e.message} on data: ${dataStr}`);
        continue;
      }

      const choice = data.choices?.[0];
      if (!choice) {
        if (data.usage) {
          inputTokens = data.usage.prompt_tokens || inputTokens;
          outputTokens = data.usage.completion_tokens || outputTokens;
        }
        continue;
      }

      const delta = choice.delta || {};
      const finishReason = choice.finish_reason;

      if (data.usage) {
        inputTokens = data.usage.prompt_tokens || inputTokens;
        outputTokens = data.usage.completion_tokens || outputTokens;
      }

      let text = '';
      if (delta.reasoning_content !== undefined) {
        if (!inThinking) {
          debugLog(`Entering thinking mode`);
          inThinking = true;
          text = '<think>\n' + delta.reasoning_content;
        } else {
          text = delta.reasoning_content;
        }
      } else if (delta.content !== undefined) {
        const c = delta.content || '';
        if (inThinking) {
          debugLog(`Exiting thinking mode`);
          inThinking = false;
          text = '\n</think>\n\n' + c;
        } else {
          text = c;
        }
      }

      if (finishReason) {
        debugLog(`Received finishReason: ${finishReason}`);
        if (inThinking) {
          text = '\n</think>\n\n' + text;
          inThinking = false;
        }
        const geminiFinish = mapFinishReason(finishReason);
        const finalChunk = {
          candidates: [{
            content: { parts: [{ text: text || '' }], role: 'model' },
            finishReason: geminiFinish,
            index: 0,
          }],
          modelVersion,
        };

        if (inputTokens > 0 || outputTokens > 0) {
          finalChunk.usageMetadata = {
            promptTokenCount: inputTokens,
            candidatesTokenCount: outputTokens,
            totalTokenCount: inputTokens + outputTokens,
          };
        }

        writeGeminiSSE(finalChunk);
      } else if (text) {
        writeGeminiSSE({
          candidates: [{
            content: { parts: [{ text }], role: 'model' },
            index: 0,
          }],
          modelVersion,
        });
      }
    }
  }

  function finish() {
    if (finished) return;
    finished = true;

    // Send final stop chunk just in case
    writeGeminiSSE({
      candidates: [{
        content: { parts: [{ text: inThinking ? '\n</think>\n' : '' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens,
      },
      modelVersion,
    });

    try { clientRes.end(); } catch { /* ignore */ }
  }

  return { processChunk, finish, getUsage: () => ({ inputTokens, outputTokens }) };
}

/**
 * Map OpenAI finish reasons to Gemini finish reasons.
 */
function mapFinishReason(openaiReason) {
  switch (openaiReason) {
    case 'stop':          return 'STOP';
    case 'length':        return 'MAX_TOKENS';
    case 'content_filter': return 'SAFETY';
    default:              return 'STOP';
  }
}

/**
 * Translate a non-streaming OpenAI response to Gemini format.
 */
function translateNonStreamingResponse(openaiResp, modelVersion) {
  const choice = openaiResp.choices?.[0];
  const text = choice?.message?.content || '';
  const finishReason = mapFinishReason(choice?.finish_reason || 'stop');
  const usage = openaiResp.usage || {};

  return {
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason,
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0,
    },
    modelVersion,
  };
}

module.exports = { createSSETranslator, translateNonStreamingResponse };
