const puppeteer = require('puppeteer');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const fs = require('fs');
const commandLineArgs = require('command-line-args');
const optionDefinitions = [
    { name: 'file', description: 'File to read the domains'},
    { name: 'output', description: 'Where to write the reports' },
];
const options = commandLineArgs(optionDefinitions);
let forks = numCPUs;
let browser;

if (options.file === undefined || options.output === undefined) {
    console.log('Usage: --file <filename.txt> --output <folder>');
    process.exit();
}
let domainsList = [];
if (fs.existsSync(options.file)) {
    domainsList = JSON.parse(fs.readFileSync(options.file, 'utf8'));
} else {
    console.log(`${options.file} does not exist`);
    process.exit();
}
if (!fs.existsSync(options.output)) {
    console.log(`Folder ${options.output} does not exist`);
    process.exit();
}

function getFirstMatch(data, val='')
{
    try {
        val = data[1];
    } catch (e) {
    }

    return val;
}

(async () => {

    var createGroupedArray = function (arr, chunkSize) {
        var groups = [], i;
        for (i = 0; i < arr.length; i += chunkSize) {
            groups.push(arr.slice(i, i + chunkSize));
        }
        return groups;
    }
    var folderName = '/' + options.output; // this would do for now
    let chunkSize = Math.ceil(domainsList.length / forks);
    var groupedArr = createGroupedArray(domainsList, chunkSize);
    if (cluster.isMaster) {
        for (let i = 0; i < forks; i++) {
            cluster.fork().send({domains: groupedArr[i], forkNum: i});
            console.log('Fork #' + i);
        }
    } else {
        process.on('message', function (msg) {
            connectToChrome(msg.domains, msg.forkNum);
        });
    }

    function connectToChrome(domains, forkNum) {
        (async function () {
            let totalToProcess = domains.length;
            for (var i = 0; i < domains.length; i++) {
                browser = await puppeteer.launch({
                    args: [
                        '--disable-setuid-sandbox',
                        '--no-sandbox',
                        '--ignore-certificate-errors',
                    ],
                    ignoreHTTPSErrors: true,
                    headless: true,
                });
                totalToProcess--;
                console.log('Fork #'+forkNum, 'Remaining: ', totalToProcess);
                const page = await browser.newPage();

                var domainName = domains[i];
                var consoleOut;
                console.log(domainName);

                page.on('response', response => {
                    var status = response.status();
                    if (status == 200) {
                        consoleOut = '';
                    } else {
                        consoleOut = status + ' (' + domainName + ') \n';
                    }
                });
                let cookiesAll;
                let reportText = '';
                let gtmId = 'NO GTM Found';
                let privacyPolicyCountryCode = '';
                let cookiePolicyCountryCode = '';
                try {
                    await page.goto('http://' + domainName, {waitUntil: 'networkidle2'});
                    cookiesAll = await page._client.send('Network.getAllCookies');
                    // await page.setExtraHTTPHeaders({
                    //     'Accept-Language': 'es-ES'
                    // });
                    // docs https://stackoverflow.com/questions/46908636/how-to-specify-browser-language-in-puppeteer
                    let headHTML = await page.evaluate(() => document.head.innerHTML);
                    let re = /www\.googletagmanager\.com\/gtm\.js\?id=(\S*)"/gm;
                    let matches = re.exec(headHTML);
                    gtmId = getFirstMatch(matches, 'NO GTM Found');
                    let bodyHTML = await page.evaluate(() => document.body.innerHTML);
                    let rePrivacyPolicy = /www\.foxprivacy\.com\/([a-z]{2})\//gm;
                    let recookiePolicy = /www\.foxprivacy\.com\/([a-z]{2})\/cookies\.html/gm;
                    matches = rePrivacyPolicy.exec(bodyHTML);
                    privacyPolicyCountryCode = getFirstMatch(matches, '');
                    matches = recookiePolicy.exec(bodyHTML);
                    cookiePolicyCountryCode = getFirstMatch(matches, '');


                    reportText += domainName + ',' + gtmId + ',,,,,,,' + privacyPolicyCountryCode + ',' + cookiePolicyCountryCode + '\n';

                    for (var k = 0; k < cookiesAll.cookies.length; k++) {
                        let cdomain = cookiesAll.cookies[k].domain;
                        let cpath = cookiesAll.cookies[k].path;
                        let cname = cookiesAll.cookies[k].name;
                        let cexpires = cookiesAll.cookies[k].expires;
                        let csession = cookiesAll.cookies[k].session;
                        let cvalue = cookiesAll.cookies[k].value;

                        reportText += domainName + ',' + gtmId
                            + ',' + cdomain
                            + ',' + cpath
                            + ',' + cname
                            + ',' + cexpires
                            + ',' + csession
                            + ',' + cvalue
                            + ',' + privacyPolicyCountryCode
                            + ',' + cookiePolicyCountryCode
                            + '\n';
                    }
                    if (reportText !== '') {
                        fs.appendFile(__dirname + folderName + "/report.csv", reportText, function (err) {
                            if (err) {
                                return console.log(err);
                            }
                        });
                    }

                } catch (e) {
                    console.log(e);
                    consoleOut = e + ' (' + domainName + ') \n';
                }

                if (consoleOut !== '') {
                    fs.appendFile(__dirname + folderName + "/errors.csv", consoleOut, function (err) {
                        if (err) {
                            return console.log(err);
                        }
                    });
                }

                await page.screenshot({path: __dirname + folderName + "/" + domainName + '.png'});
                await page.close();
                await browser.close();
            }

        })();
    }

})();