// scraper.js
const { chromium } = require('playwright');

async function* scrapeSalonDetails(signal) {

  const baseURL = 'https://www.treatwell.de/orte/behandlung-gruppe-massage/angebot-typ-lokal/in-berlin-de/'; // Add this line

  const browser = await chromium.launch({ headless: true });
  signal.addEventListener('abort', () => browser.close());

  try {
    const context = await browser.newContext();
    await context.route(/.(png|jpg|css|font)/, route => route.abort());

    const mainPage = await context.newPage();
    await mainPage.goto(baseURL, { 
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Robust pagination handling
    let lastPage = 1;
    try {
      const paginationLinks = await mainPage.$$('a.Pagination-module--item--b6f01b');
      const pageNumbers = await Promise.all(
        paginationLinks.map(async link => {
          const text = await link.textContent();
          return parseInt(text) || 0;
        })
      );
      lastPage = Math.max(...pageNumbers.filter(n => n > 0)) || 1;
    } catch (error) {
      console.log('Using single page mode');
    }

    for (let pageNum = 1; pageNum <= lastPage; pageNum++) {
      if (signal.aborted) break;
      
      const page = await context.newPage();
      await page.goto(`${baseURL}${pageNum > 1 ? `seite-${pageNum}/` : ''}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      const links = await page.$$eval(
        '.BrowseResult-module--container--a0806d a',
        anchors => [...new Set(anchors.map(a => a.href))]
      );

      await page.close();

      for (const cardURL of links) {
        if (signal.aborted) break;
        
        const cardPage = await context.newPage();
        await cardPage.goto(cardURL, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        const [name, address] = await Promise.all([
          cardPage.$eval('h1.Text-module_smHero__2uXfi', el => el.textContent.trim()),
          cardPage.$$eval('.style-module--addressPart--484b23', els =>
            els.map(e => e.textContent.trim().replace(/\s+,/g, ',')).join(' ')
          )
        ]);

        yield { name, address, url: cardURL };
        await cardPage.close();
      }
    }
  } finally {
    if (!signal.aborted) await browser.close();
  }
}

module.exports = { scrapeSalonDetails };