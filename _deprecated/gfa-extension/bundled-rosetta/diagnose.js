#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const paths = require('./shared/paths');
const CONFIG_PATH = paths.configPath();
const ACCOUNTS_PATH = paths.accountsPath();

function stripJsonComments(rawText) {
    return String(rawText || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
}

function readJsonc(filePath, fallbackValue = {}) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(stripJsonComments(raw));
    } catch {
        return fallbackValue;
    }
}

async function fetchJson(url, options = {}) {
    const httpModule = require('http');
    const timeoutMs = Number(options.timeoutMs || 5000);
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = httpModule.request(
            {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: options.method || 'GET',
                headers: options.headers || {},
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let body = null;
                    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        body,
                    });
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        if (options.body) req.write(options.body);
        req.end();
    });
}

function printLine(label, value) {
    console.log(`${label}: ${value}`);
}

async function main() {
    const config = readJsonc(CONFIG_PATH, {});
    const accounts = readJsonc(ACCOUNTS_PATH, { accounts: [] });
    const tokenProxyPort = Number(config.tokenProxyPort || 60670);
    const tokenStatusPort = tokenProxyPort + 1;
    const reverseProxyPort = Number(config.port || 8787);
    const reverseProxyUrl = `http://127.0.0.1:${reverseProxyPort}/v1/proxy/status`;
    const reverseProxyHeaders = {};
    const apiKey = String(config.localApiKey || '').trim();

    if (apiKey) {
        reverseProxyHeaders.Authorization = `Bearer ${apiKey}`;
    }

    console.log('=== Antigravity Local Proxy Diagnose ===');
    printLine('项目目录', ROOT);
    printLine('配置文件', fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : '缺失');
    printLine('账号文件', fs.existsSync(ACCOUNTS_PATH) ? ACCOUNTS_PATH : '缺失');
    printLine('账号数量', Array.isArray(accounts.accounts) ? accounts.accounts.length : 0);
    printLine('本地代理地址', `http://127.0.0.1:${tokenProxyPort}`);
    printLine('状态接口地址', `http://127.0.0.1:${tokenStatusPort}/status`);
    printLine('本地反代地址', `http://127.0.0.1:${reverseProxyPort}`);
    console.log('');

    try {
        const tokenStatus = await fetchJson(`http://127.0.0.1:${tokenStatusPort}/status`);
        printLine('本地代理状态', tokenStatus.ok ? '运行中' : `异常 (${tokenStatus.status})`);
        if (tokenStatus.ok && tokenStatus.body && typeof tokenStatus.body === 'object') {
            printLine('当前账号', tokenStatus.body.activeEmail || '未识别');
            printLine('切换次数', Number(tokenStatus.body.totalRotations || 0));
        }
    } catch (error) {
        printLine('本地代理状态', `未连通 (${error.message})`);
    }

    try {
        const reverseStatus = await fetchJson(reverseProxyUrl, {
            headers: reverseProxyHeaders,
        });
        printLine('本地反代状态', reverseStatus.ok ? '运行中' : `异常 (${reverseStatus.status})`);
        if (reverseStatus.ok && reverseStatus.body && typeof reverseStatus.body === 'object') {
            printLine('默认模型', reverseStatus.body.default_model || '未配置');
        }
    } catch (error) {
        printLine('本地反代状态', `未连通 (${error.message})`);
    }
}

main().catch((error) => {
    console.error(`诊断失败: ${error.stack || error.message}`);
    process.exit(1);
});
