// Quick verification of the patched rewriteProjectFields
const { rewriteProjectFields } = require('../apps/gfa-extension/bundled-rosetta/token-proxy/token-proxy.pre-obfuscate-2026-05-15_16-37-57');

const body = {
  project: 'old-project',
  tools: [{
    function_declarations: [{
      parameters: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'schema node must not be rewritten'
          }
        }
      }
    }]
  }]
};

const result = rewriteProjectFields(body, 'zesty-alignment-3j54r');

const topOk = body.project === 'zesty-alignment-3j54r';
const schemaOk = typeof body.tools[0].function_declarations[0].parameters.properties.project === 'object';
const countOk = result.updated === 1;

console.log(`Top-level project rewritten: ${topOk ? 'PASS' : 'FAIL'} (got: ${body.project})`);
console.log(`Schema project preserved:    ${schemaOk ? 'PASS' : 'FAIL'} (type: ${typeof body.tools[0].function_declarations[0].parameters.properties.project})`);
console.log(`Updated count == 1:          ${countOk ? 'PASS' : 'FAIL'} (got: ${result.updated})`);
console.log(`\nOverall: ${topOk && schemaOk && countOk ? 'ALL PASS ✅' : 'SOME FAILED ❌'}`);
