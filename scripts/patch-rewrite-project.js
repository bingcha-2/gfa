const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../apps/gfa-extension/bundled-rosetta/token-proxy/token-proxy.pre-obfuscate-2026-05-15_16-37-57.js');

let code = fs.readFileSync(filePath, 'utf8');

const oldFn = `function rewriteProjectFields(value, projectId) {
    if (!value || typeof value !== 'object') {
        return { found: 0, updated: 0 };
    }

    let found = 0;
    let updated = 0;

    if (Array.isArray(value)) {
        for (const item of value) {
            const child = rewriteProjectFields(item, projectId);
            found += child.found;
            updated += child.updated;
        }
        return { found, updated };
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'project') {
            found += 1;
            const nextValue = formatProjectValue(childValue, projectId);
            if (nextValue !== childValue) {
                value[key] = nextValue;
                updated += 1;
            }
            continue;
        }

        if (childValue && typeof childValue === 'object') {
            const child = rewriteProjectFields(childValue, projectId);
            found += child.found;
            updated += child.updated;
        }
    }

    return { found, updated };
}`;

const newFn = `function isSchemaNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return (
        Object.prototype.hasOwnProperty.call(value, 'type') ||
        Object.prototype.hasOwnProperty.call(value, 'description') ||
        Object.prototype.hasOwnProperty.call(value, 'properties') ||
        Object.prototype.hasOwnProperty.call(value, 'required') ||
        Object.prototype.hasOwnProperty.call(value, 'items') ||
        Object.prototype.hasOwnProperty.call(value, 'enum')
    );
}

function isSchemaPropertiesMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).some(isSchemaNode);
}

function rewriteProjectFields(value, projectId, context = {}) {
    if (!value || typeof value !== 'object') {
        return { found: 0, updated: 0 };
    }

    let found = 0;
    let updated = 0;

    if (Array.isArray(value)) {
        for (const item of value) {
            const child = rewriteProjectFields(item, projectId, context);
            found += child.found;
            updated += child.updated;
        }
        return { found, updated };
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key === 'project') {
            if (context.inSchemaProperties && isSchemaNode(childValue)) {
                continue;
            }

            found += 1;
            const nextValue = formatProjectValue(childValue, projectId);
            if (nextValue !== childValue) {
                value[key] = nextValue;
                updated += 1;
            }
            continue;
        }

        if (childValue && typeof childValue === 'object') {
            const child = rewriteProjectFields(childValue, projectId, {
                inSchemaProperties: key === 'properties' && isSchemaPropertiesMap(childValue),
            });
            found += child.found;
            updated += child.updated;
        }
    }

    return { found, updated };
}`;

// Normalize line endings for matching
const normalizedCode = code.replace(/\r\n/g, '\n');
const normalizedOld = oldFn.replace(/\r\n/g, '\n');

if (!normalizedCode.includes(normalizedOld)) {
    console.error('ERROR: Could not find old function in source file');
    process.exit(1);
}

const patched = normalizedCode.replace(normalizedOld, newFn);
// Restore original line endings
const finalCode = code.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched;
fs.writeFileSync(filePath, finalCode, 'utf8');
console.log('PATCHED OK: rewriteProjectFields in token-proxy.pre-obfuscate-2026-05-15_16-37-57.js');
