const fs = require('fs');

const extractData = (file) => {
    const data = fs.readFileSync(file, 'utf8');
    const matches = data.match(/AF_initDataCallback\\(\\{.*?data:([\\s\\S]*?)}\\)/g);
    if (!matches) {
        console.log("No matches in", file);
        return;
    }
    console.log(`--- ${file} ---`);
    matches.forEach(m => {
        // just extract the data part and see if there's any email
        const dataPart = m.substring(0, 500);
        console.log(dataPart);
    });
};

extractData('C:/Users/Administrator/Desktop/1.html');
extractData('C:/Users/Administrator/Desktop/2.html');
