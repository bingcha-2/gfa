'use strict';

const crypto = require('crypto');

function normalizeArray(value) {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function makeHttpError(message, statusCode, type = 'proxy_error') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.errorType = type;
    return error;
}

function randomId(prefix) {
    return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(makeHttpError('Invalid JSON request body.', 400, 'invalid_request_error'));
            }
        });
        req.on('error', reject);
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    makeHttpError,
    normalizeArray,
    parseJsonSafe,
    randomId,
    readRequestBody,
    wait,
};
