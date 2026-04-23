const fs = require('fs');

const extractData = (file) => {
    const data = fs.readFileSync(file, 'utf8');
    // Basic regex to find AF_initDataCallback with data arrays
    const matches = data.match(/AF_initDataCallback\\(\\{key: \\'ds:1\\'.*?data:([\\s\\S]*?)}\\)/g) || data.match(/AF_initDataCallback\\(\\{.*?data:([\\s\\S]*?)}\\)/g);
    if (!matches) {
        console.log("No matches in", file);
        return;
    }
    console.log(`--- ${file} ---`);
    matches.forEach(m => {
        // extract people identifiers using a broad regex to see what emails it has
        const emails = m.match(/[\\w.-]+@[\\w.-]+\\.\\w+/g) || [];
        console.log("Emails found in match:", [...new Set(emails)]);
        // Let's also check if there are 21-digit strings like gaia id
        const ids = m.match(/10\\d{19}/g) || [];
        console.log("Gaia IDs found in match:", [...new Set(ids)]);
    });
};

extractData('C:/Users/Administrator/Desktop/1.html');
extractData('C:/Users/Administrator/Desktop/2.html');
