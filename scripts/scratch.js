const fs = require('fs');
const html = fs.readFileSync('C:/Users/Administrator/Desktop/234.html', 'utf8');
const matches = [...html.matchAll(/data-step-type="(\d+)".*?<div class="dMNVAe">(.*?)<\/div>/gis)];
matches.forEach(m => console.log(`Step ${m[1]}: ${m[2]}`));
