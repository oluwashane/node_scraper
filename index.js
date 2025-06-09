  // server.js
  require('dotenv').config();
  const express = require('express');
  const cors = require('cors');
  const { PromisePool } = require('@supercharge/promise-pool');
  const { searchBusiness } = require('./enrich');
  const store = require('./store');
  const { exportCSV } = require('./csv-exporter');
  const { scrapeSalonDetails } = require('./scraper');

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  let isProcessing = false;
  let scrapeController = new AbortController();

  // Health check endpoint
  app.get('/health', async (req, res) => {
    try {
      const health = await healthCheck();
      res.json(health);
    } catch (error) {
      res.status(500).json({ status: 'ERROR', error: error.message });
    }
  });

  // app.post('/start', async (req, res) => {
  //   if (isProcessing) {
  //     return res.status(429).json({ error: 'Processing already in progress' });
  //   }

  //   isProcessing = true;
  //   store.clear();
  //   scrapeController = new AbortController();

  //   // Immediate response to start streaming progress
  //   res.writeHead(200, {
  //     'Content-Type': 'application/json',
  //     'Transfer-Encoding': 'chunked'
  //   });

  //   try {
  //     // Pipeline: Scrape -> Enrich -> Store
  //     const scrapingStream = scrapeSalonDetails(scrapeController.signal);
      
  //     await PromisePool
  //       .withConcurrency(2) // Reduced concurrency for better proxy performance
  //       .for(scrapingStream)
  //       .handleError(async (error) => {
  //         console.error('Pipeline error:', error);
  //         return { shouldCollect: true };
  //       })
  //       .process(async (business) => {
  //         await sleep(200)
  //         try {
  //           // Enrich with both name and address
  //           const info = await searchBusiness(business.name);
  //           console.log('checking info', info)
            
  //           // Merge scraped data with enrichment results
  //           const record = { 
  //             ...business, 
  //             ...info,
  //             enrichment_status: info.error ? 'failed' : 'success'
  //           };
            
  //           store.add(record);
            
  //           // Stream partial updates to client
  //           res.write(JSON.stringify({
  //             id: record.id,
  //             name: record.name,
  //             status: 'enriched',
  //             owner: record.owner_name,
  //             email: record.email,
  //             phone: record.phone,
  //             verified: record.verified
  //           }) + '\n');
  //         } catch (error) {
  //           const errorRecord = { 
  //             ...business, 
  //             error: error.message,
  //             enrichment_status: 'failed'
  //           };
  //           store.add(errorRecord);
            
  //           res.write(JSON.stringify({
  //             id: errorRecord.id,
  //             name: errorRecord.name,
  //             status: 'failed',
  //             error: error.message
  //           }) + '\n');
  //         }
  //       });

  //     res.end(JSON.stringify({ status: 'completed' }));
  //   } catch (error) {
  //     console.error('Processing failed:', error);
  //     res.end(JSON.stringify({ status: 'failed', error: error.message }));
  //   } finally {
  //     isProcessing = false;
  //   }
  // });


  app.post('/start', async (req, res) => {
    const { baseURL, maxProcess = 1 } = req.body;
    console.log('checking baseUrl', baseURL, maxProcess)

    if (isProcessing) {
      return res.status(429).json({ error: 'Processing already in progress' });
    }

    if (!baseURL) {
      return res.status(400).json({ error: 'Missing baseURL in request body' });
    }

    isProcessing = true;
    store.clear();
    scrapeController = new AbortController();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });

    let count = 0;

    try {
      const scrapingStream = scrapeSalonDetails(scrapeController.signal, baseURL);

      await PromisePool
        .withConcurrency(2)
        .for(scrapingStream)
        .handleError(async (error) => {
          console.error('Pipeline error:', error);
          return { shouldCollect: true };
        })
        .process(async (business) => {
          if (count >= maxProcess) {
            scrapeController.abort();
            return;
          }

          await sleep(200);
          try {
            const info = await searchBusiness(business.name);
            const record = {
              id: count + 1,
              ...business,
              ...info.parsed,
              enrichment_status: info.error ? 'failed' : 'success'
            };

            store.add(record);

            res.write(JSON.stringify({
              id: record.id,
              name: record.name,
              status: 'enriched',
              owner: record.owner?.[0],
              email: record.email?.[0],
              phone: record.phone?.[0],
              verified: record.verified
            }) + '\n');

            count++;
          } catch (error) {
            const errorRecord = {
              id: count + 1,
              ...business,
              error: error.message,
              enrichment_status: 'failed'
            };
            store.add(errorRecord);
            res.write(JSON.stringify({
              id: errorRecord.id,
              name: errorRecord.name,
              status: 'failed',
              error: error.message
            }) + '\n');
            count++;
          }
        });

      res.end(JSON.stringify({ status: 'completed' }));
    } catch (error) {
      console.error('Processing failed:', error);
      res.end(JSON.stringify({ status: 'failed', error: error.message }));
    } finally {
      isProcessing = false;
    }
  });



  app.post('/cancel', (req, res) => {
    scrapeController.abort();
    isProcessing = false;
    res.json({ status: 'cancelled' });
  });

  app.get('/data', (req, res) => {
    res.json(store.getAll());
  });

  app.get('/export', (req, res) => exportCSV(res));

  // Proxy status endpoint
  app.get('/proxy-status', (req, res) => {
    const { getProxyConfig } = require('./enrich');
    res.json(getProxyConfig());
  });

  const PORT = process.env.PORT;
  app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`));