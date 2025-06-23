// scraper.js
const { chromium } = require('playwright');

async function* scrapeSalonDetails(signal, url, options = {}) {
  const {
    startPage = 1,
    endPage = null,
    limitPerPage = 10
  } = options;

  const baseURL = url;
  console.log(`🔧 [SCRAPER] Configuration: Pages ${startPage}-${endPage || 'auto'}, Limit: ${limitPerPage} per page`);

  const browser = await chromium.launch({ headless: true });
  signal.addEventListener('abort', () => browser.close());

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    await context.route(/\.(png|jpg|jpeg|gif|svg|css|font|woff|woff2)$/, route => route.abort());

    const mainPage = await context.newPage();
    
    console.log(`🌐 [SCRAPER] Navigating to main page: ${baseURL}`);
    
    // Try multiple navigation strategies
    let navigationSuccess = false;
    const navigationStrategies = [
      { waitUntil: 'domcontentloaded', timeout: 30000 },
      { waitUntil: 'load', timeout: 20000 },
      { waitUntil: 'networkidle', timeout: 15000 }
    ];

    for (const strategy of navigationStrategies) {
      try {
        console.log(`🔄 [SCRAPER] Trying navigation with ${strategy.waitUntil}, timeout: ${strategy.timeout}ms`);
        await mainPage.goto(baseURL, strategy);
        navigationSuccess = true;
        console.log(`✅ [SCRAPER] Successfully navigated to main page`);
        break;
      } catch (error) {
        console.log(`⚠️ [SCRAPER] Navigation strategy failed: ${error.message}`);
        if (strategy === navigationStrategies[navigationStrategies.length - 1]) {
          throw new Error(`Failed to navigate to ${baseURL} with all strategies`);
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error(`Could not navigate to main page: ${baseURL}`);
    }

    // Robust pagination handling
    let lastPage = endPage || 1;
    if (!endPage) {
      try {
        // Wait for pagination to load
        await mainPage.waitForSelector('a.Pagination-module--item--b6f01b', { timeout: 5000 });
        
        const paginationLinks = await mainPage.$$('a.Pagination-module--item--b6f01b');
        const pageNumbers = await Promise.all(
          paginationLinks.map(async link => {
            try {
              const text = await link.textContent();
              return parseInt(text) || 0;
            } catch {
              return 0;
            }
          })
        );
        lastPage = Math.max(...pageNumbers.filter(n => n > 0)) || 1;
        console.log(`🔍 [SCRAPER] Auto-detected last page: ${lastPage}`);
      } catch (error) {
        console.log('⚠️ [SCRAPER] Could not detect pagination, using single page mode');
        lastPage = startPage;
      }
    }

    // Ensure we don't go beyond detected pages
    const actualEndPage = Math.min(lastPage, endPage || lastPage);
    console.log(`📄 [SCRAPER] Will process pages ${startPage} to ${actualEndPage}`);

    let totalScraped = 0;
    for (let pageNum = startPage; pageNum <= actualEndPage; pageNum++) {
      if (signal.aborted) {
        console.log('❌ [SCRAPER] Scraping aborted');
        break;
      }
      
      console.log(`📖 [SCRAPER] Processing page ${pageNum}/${actualEndPage}`);
      
      const page = await context.newPage();
      const pageURL = `${baseURL}${pageNum > 1 ? `seite-${pageNum}/` : ''}`;
      
      try {
        console.log(`🌐 [SCRAPER] Navigating to page: ${pageURL}`);
        
        // Use more conservative navigation for individual pages
        await page.goto(pageURL, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });

        // Wait a bit for dynamic content to load
        await page.waitForTimeout(2000);

        let links = [];
        try {
          // Try to find business links with multiple selectors
          const selectors = [
            '.BrowseResult-module--container--a0806d a',
            '[data-testid="business-link"]',
            'a[href*="/ort/"]',
            'a[href*="/salon/"]'
          ];

          for (const selector of selectors) {
            try {
              links = await page.$$eval(selector, anchors => 
                [...new Set(anchors.map(a => a.href).filter(href => href && href.includes('/ort/')))]
              );
              if (links.length > 0) {
                console.log(`✅ [SCRAPER] Found ${links.length} business links using selector: ${selector}`);
                break;
              }
            } catch (error) {
              console.log(`⚠️ [SCRAPER] Selector "${selector}" failed: ${error.message}`);
            }
          }
        } catch (error) {
          console.error(`❌ [SCRAPER] Error finding business links on page ${pageNum}:`, error.message);
        }

        if (links.length === 0) {
          console.log(`⚠️ [SCRAPER] No business links found on page ${pageNum}`);
          await page.close();
          continue;
        }

        console.log(`🔗 [SCRAPER] Found ${links.length} business links on page ${pageNum}`);

        // Apply limit per page
        const limitedLinks = links.slice(0, limitPerPage);
        if (limitedLinks.length < links.length) {
          console.log(`⚡ [SCRAPER] Limited to first ${limitPerPage} businesses on page ${pageNum}`);
        }

        await page.close();

        let pageScrapedCount = 0;
        for (const cardURL of limitedLinks) {
          if (signal.aborted) break;
          
          const cardPage = await context.newPage();
          try {
            console.log(`🔍 [SCRAPER] Scraping business: ${cardURL}`);
            
            await cardPage.goto(cardURL, { 
              waitUntil: 'domcontentloaded',
              timeout: 15000
            });

            // Wait for content to load
            await cardPage.waitForTimeout(1000);

            let name = '';
            let address = '';

            // Try multiple selectors for name
            const nameSelectors = [
              'h1.Text-module_smHero__2uXfi',
              'h1[data-testid="business-name"]',
              'h1',
              '.business-name'
            ];

            for (const selector of nameSelectors) {
              try {
                name = await cardPage.$eval(selector, el => el.textContent.trim());
                if (name) break;
              } catch {
                // Continue to next selector
              }
            }

            // Try multiple selectors for address
            const addressSelectors = [
              '.style-module--addressPart--484b23',
              '[data-testid="business-address"]',
              '.address',
              '.location'
            ];

            for (const selector of addressSelectors) {
              try {
                address = await cardPage.$$eval(selector, els =>
                  els.map(e => e.textContent.trim().replace(/\s+,/g, ',')).join(' ')
                );
                if (address) break;
              } catch {
                // Continue to next selector
              }
            }

            if (!name) {
              console.log(`⚠️ [SCRAPER] Could not find business name for ${cardURL}`);
              name = 'Unknown Business';
            }

            if (!address) {
              console.log(`⚠️ [SCRAPER] Could not find address for ${cardURL}`);
              address = 'Address not found';
            }

            pageScrapedCount++;
            totalScraped++;
            console.log(`   📋 [${pageScrapedCount}/${limitedLinks.length}] Page ${pageNum}: "${name}"`);
            
            yield { 
              name, 
              address, 
              url: cardURL, 
              page: pageNum,
              pagePosition: pageScrapedCount,
              totalPosition: totalScraped
            };
            
          } catch (error) {
            console.error(`❌ [SCRAPER] Error scraping business ${cardURL}:`, error.message);
          } finally {
            await cardPage.close();
          }
        }

        console.log(`✅ [SCRAPER] Page ${pageNum} completed: ${pageScrapedCount} businesses scraped`);
      } catch (error) {
        console.error(`❌ [SCRAPER] Error processing page ${pageNum}:`, error.message);
        try {
          await page.close();
        } catch {
          // Ignore close errors
        }
      }
    }

    console.log(`🎉 [SCRAPER] All pages completed: ${totalScraped} total businesses scraped`);
  } finally {
    if (!signal.aborted) {
      try {
        await browser.close();
      } catch (error) {
        console.error('Error closing browser:', error.message);
      }
    }
  }
}

module.exports = { scrapeSalonDetails };