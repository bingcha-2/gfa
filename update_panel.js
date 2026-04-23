const fs = require('fs');

const path = 'c:\\\\Users\\\\Administrator\\\\Desktop\\\\GFA\\\\apps\\\\web\\\\src\\\\components\\\\group-panel.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Remove the pending badge from the group name column 
const groupRegex = /<span className="strong">\{group\.groupName\}<\/span>\s*\{\(group\.pendingMemberCount \?\? 0\) > 0 && \(\s*<span style=\{\{\s*fontSize: '0\.7rem',\s*fontWeight: 600,\s*padding: '1px 6px',\s*borderRadius: '4px',\s*background: 'rgba\(245,158,11,0\.12\)',\s*color: '#d97706',\s*whiteSpace: 'nowrap',\s*\}\}\s*title=\{`\$\{group\.pendingMemberCount\} 个成员同步后待接受`\}\s*>\s*⏳ \{group\.pendingMemberCount\}待接受\s*<\/span>\s*\)\}/;

content = content.replace(groupRegex, '<span className="strong">{group.groupName}</span>');

// 2. Add it next to the account name
const accountRegex = /<div>\{group\.account\?\.name \?\? "- "\}<\/div>/;
const accReplacement = `<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div>{group.account?.name ?? "-"}</div>
                                {(group.pendingMemberCount ?? 0) > 0 && (
                                  <span style={{
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    background: 'rgba(245,158,11,0.12)',
                                    color: '#d97706',
                                    whiteSpace: 'nowrap',
                                  }}
                                    title={\`\${group.pendingMemberCount} 个成员同步后待接受\`}
                                  >
                                    ⏳ {group.pendingMemberCount}待接受
                                  </span>
                                )}
                              </div>`;

content = content.replace('<div>{group.account?.name ?? "-"}</div>', accReplacement);

fs.writeFileSync(path, content, 'utf8');
console.log('Done!');
