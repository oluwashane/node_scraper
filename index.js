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

  async function healthCheck() {
    return {
      status: 'OK',
      timestamp: new Date().toISOString(),
      isProcessing: isProcessing,
      dataCount: store.getAll().length,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
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

  app.post('/start', async (req, res) => {
    const { 
      baseURL, 
      maxProcess = parseInt(process.env.MAX_PROCESS) || 5,
      startPage = 1,
      endPage = null,
      limitPerPage = 10
    } = req.body;    
    const concurrency = parseInt(process.env.ENRICHMENT_CONCURRENCY) || 8;
    const startTime = Date.now();

    console.log('\n' + '='.repeat(80));
    console.log('🚀 STARTING NEW SCRAPING & ENRICHMENT PROCESS');
    console.log('='.repeat(80));
    console.log(`📊 Configuration:`);
    console.log(`   🎯 Target URL: ${baseURL}`);
    console.log(`   📈 Max Process: ${maxProcess}`);
    console.log(`   📄 Page Range: ${startPage} to ${endPage || 'auto-detect'}`);
    console.log(`   🔢 Limit per Page: ${limitPerPage}`);
    console.log(`   ⚡ Concurrency: ${concurrency}`);
    console.log(`   🕐 Start Time: ${new Date().toLocaleString()}`);
    console.log('='.repeat(80));

    if (isProcessing) {
      console.log('❌ REQUEST REJECTED: Processing already in progress');
      return res.status(429).json({ error: 'Processing already in progress' });
    }

    if (!baseURL) {
      console.log('❌ REQUEST REJECTED: Missing baseURL');
      return res.status(400).json({ error: 'Missing baseURL in request body' });
    }

    // Validate page range
    if (startPage < 1) {
      console.log('❌ REQUEST REJECTED: Start page must be >= 1');
      return res.status(400).json({ error: 'Start page must be >= 1' });
    }

    if (endPage && endPage < startPage) {
      console.log('❌ REQUEST REJECTED: End page must be >= start page');
      return res.status(400).json({ error: 'End page must be >= start page' });
    }

    if (limitPerPage < 1 || limitPerPage > 100) {
      console.log('❌ REQUEST REJECTED: Limit per page must be between 1 and 100');
      return res.status(400).json({ error: 'Limit per page must be between 1 and 100' });
    }

    isProcessing = true;
    store.clear();
    scrapeController = new AbortController();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });

      let processedCount = 0;
  let enrichedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const businesses = [];
  let scrapingEndTime;

    try {
      // First, collect businesses from scraping
      console.log('\n📥 PHASE 1: SCRAPING BUSINESSES');
      console.log('-'.repeat(50));
      const scrapingStartTime = Date.now();
      const scrapingStream = scrapeSalonDetails(
        scrapeController.signal, 
        baseURL, 
        { startPage, endPage, limitPerPage }
      );
      
      let scrapedCount = 0;
      for await (const business of scrapingStream) {
        if (scrapeController.signal.aborted) {
          console.log('❌ Scraping aborted by user');
          break;
        }
        
        scrapedCount++;
        businesses.push(business);
        console.log(`📋 [${scrapedCount}] Scraped: "${business.name}" | ${business.address} | Page: ${business.page || 'N/A'}`);
        
        // Stop collecting when we have enough to process
        if (businesses.length >= maxProcess * 2) { // Buffer to account for failures
          console.log(`✅ Reached buffer limit (${businesses.length} businesses), starting enrichment...`);
          break;
        }
      }

      scrapingEndTime = Date.now();
      const scrapingDuration = (scrapingEndTime - scrapingStartTime) / 1000;
      
      console.log('\n📊 SCRAPING PHASE COMPLETED');
      console.log('-'.repeat(50));
      console.log(`✅ Total scraped: ${businesses.length} businesses`);
      console.log(`📄 Pages processed: ${startPage} to ${Math.min(endPage || startPage, Math.max(...businesses.map(b => b.page || 1)))}`);
      console.log(`⏱️  Duration: ${scrapingDuration}s`);
      console.log(`📈 Rate: ${(businesses.length / scrapingDuration).toFixed(2)} businesses/second`);

      // Send scraping completion update
      res.write(JSON.stringify({
        phase: 'scraping_completed',
        scraped_count: businesses.length,
        scraping_duration: scrapingDuration,
        pages_processed: Math.max(...businesses.map(b => b.page || 1)) - startPage + 1,
        starting_enrichment: true
      }) + '\n');

      // Process businesses with higher concurrency and better error handling
      console.log('\n🔄 PHASE 2: ENRICHMENT PROCESSING');
      console.log('-'.repeat(50));
      console.log(`🎯 Target to process: ${maxProcess} businesses`);
      console.log(`⚡ Concurrency level: ${concurrency}`);
      console.log(`📊 Available businesses: ${businesses.length}`);
      
      const enrichmentStartTime = Date.now();
      let completedEnrichments = 0;
      
      await PromisePool
        .withConcurrency(concurrency) // Configurable concurrency
        .for(businesses)
        .handleError(async (error, business) => {
          completedEnrichments++;
          console.error(`\n❌ [ERROR ${completedEnrichments}/${maxProcess}] Pipeline error for "${business?.name}":`, error.message);
          
          const errorRecord = {
            id: ++processedCount,
            ...business,
            error: error.message,
            enrichment_status: 'failed'
          };
          
          store.add(errorRecord);
          failedCount++;
          
          console.log(`📊 Progress: ${processedCount}/${maxProcess} | ✅ ${enrichedCount} | ❌ ${failedCount}`);
          
          // Send failure notification but continue processing
          try {
            res.write(JSON.stringify({
              id: errorRecord.id,
              name: errorRecord.name,
              status: 'failed',
              error: error.message,
              progress: `${processedCount}/${maxProcess}`,
              phase: 'enrichment'
            }) + '\n');
          } catch (writeError) {
            console.error('Write error:', writeError);
          }
          
          return { shouldCollect: true }; // Continue processing
        })
        .process(async (business) => {
          // Stop if we've processed enough OR if manually cancelled
          if (processedCount >= maxProcess || scrapeController.signal.aborted) {
            if (scrapeController.signal.aborted) {
              console.log(`❌ Processing stopped - user cancelled at ${processedCount}/${maxProcess}`);
            }
            return;
          }

          console.log(`\n🔄 [${processedCount + 1}/${maxProcess}] Starting enrichment: "${business.name}"`);

          try {
            const enrichmentStartTime = Date.now();
            const info = await searchBusiness(business.name, business.address);
            const enrichmentDuration = (Date.now() - enrichmentStartTime) / 1000;
            
            const record = {
              id: ++processedCount,
              ...business,
              ...info,
              enrichment_status: info.error ? 'failed' : 'success'
            };

            // Validate that business has essential contact information
            const hasContactInfo = record.owner || record.email || record.phone;
            
            if (!hasContactInfo && !info.error) {
              skippedCount++;
              console.log(`⚠️ [${processedCount}/${maxProcess}] Skipping "${business.name}" - no contact information found`);
              console.log(`   👤 Owner: ${record.owner || 'None'}`);
              console.log(`   📧 Email: ${record.email || 'None'}`);
              console.log(`   📞 Phone: ${record.phone || 'None'}`);
              console.log(`📊 Current Stats: ✅ ${enrichedCount} enriched | ❌ ${failedCount} failed | ⏭️ ${skippedCount} skipped`);
              
              // Don't store this record, but continue processing
              processedCount--; // Decrement since we're not counting this one
              
              // Send skip notification
              try {
                res.write(JSON.stringify({
                  name: record.name,
                  status: 'skipped',
                  reason: 'No contact information found',
                  progress: `${processedCount}/${maxProcess}`,
                  enriched: enrichedCount,
                  failed: failedCount,
                  skipped: skippedCount,
                  phase: 'enrichment'
                }) + '\n');
              } catch (writeError) {
                console.error('Write error:', writeError);
              }
              
              return; // Skip to next business (use return instead of continue)
            }

            store.add(record);
            
            if (info.error) {
              failedCount++;
              console.log(`❌ [${processedCount}/${maxProcess}] Enrichment failed for "${business.name}" (${enrichmentDuration}s): ${info.error}`);
            } else {
              enrichedCount++;
              console.log(`✅ [${processedCount}/${maxProcess}] Enrichment successful for "${business.name}" (${enrichmentDuration}s)`);
              if (record.owner) console.log(`   👤 Owner found: ${record.owner}`);
              if (record.email) console.log(`   📧 Email found: ${record.email}`);
              if (record.phone) console.log(`   📞 Phone found: ${record.phone}`);
            }

            console.log(`📊 Current Progress: ${processedCount}/${maxProcess} | ✅ ${enrichedCount} successful | ❌ ${failedCount} failed | ⏭️ ${skippedCount} skipped`);

            // Send progress update
            try {
              res.write(JSON.stringify({
                id: record.id,
                name: record.name,
                status: info.error ? 'failed' : 'enriched',
                owner: record.owner || null,
                email: record.email || null,
                phone: record.phone || null,
                verified: record.verified || false,
                progress: `${processedCount}/${maxProcess}`,
                enriched: enrichedCount,
                failed: failedCount,
                skipped: skippedCount,
                phase: 'enrichment'
              }) + '\n');
            } catch (writeError) {
              console.error('Write error:', writeError);
            }

          } catch (error) {
            console.error(`❌ [${processedCount + 1}/${maxProcess}] Enrichment error for "${business.name}":`, error);
            
            const errorRecord = {
              id: ++processedCount,
              ...business,
              error: error.message,
              enrichment_status: 'failed'
            };
            
            store.add(errorRecord);
            failedCount++;
            
            console.log(`📊 Progress: ${processedCount}/${maxProcess} | ✅ ${enrichedCount} | ❌ ${failedCount} | ⏭️ ${skippedCount}`);
            
            try {
              res.write(JSON.stringify({
                id: errorRecord.id,
                name: errorRecord.name,
                status: 'failed',
                error: error.message,
                progress: `${processedCount}/${maxProcess}`,
                enriched: enrichedCount,
                failed: failedCount,
                skipped: skippedCount,
                phase: 'enrichment'
              }) + '\n');
            } catch (writeError) {
              console.error('Write error:', writeError);
            }
          }
        });

      const endTime = Date.now();
      const totalDuration = (endTime - startTime) / 1000;
      const enrichmentDuration = (endTime - enrichmentStartTime) / 1000;

      // Send completion summary with performance metrics
      console.log('\n' + '='.repeat(80));
      console.log('🎉 PROCESSING COMPLETED SUCCESSFULLY');
      console.log('='.repeat(80));
      console.log(`📊 Final Results:`);
      console.log(`   🎯 Target: ${maxProcess} businesses`);
      console.log(`   ✅ Successfully enriched: ${enrichedCount}`);
      console.log(`   ❌ Failed enrichments: ${failedCount}`);
      console.log(`   ⏭️ Skipped (no contact info): ${skippedCount}`);
      console.log(`   📈 Total processed: ${processedCount}`);
      console.log(`   📋 Total scraped: ${businesses.length}`);
      console.log(`   📈 Success rate: ${((enrichedCount / processedCount) * 100).toFixed(1)}%`);
      console.log(`\n⏱️  Performance Metrics:`);
      console.log(`   🕐 Total duration: ${totalDuration}s`);
      console.log(`   📥 Scraping time: ${scrapingDuration}s`);
      console.log(`   🔄 Enrichment time: ${enrichmentDuration}s`);
      console.log(`   ⚡ Average enrichment: ${(enrichmentDuration / processedCount).toFixed(2)}s per item`);
      console.log(`   📈 Processing rate: ${(processedCount / totalDuration).toFixed(2)} items/second`);
      console.log(`   🏁 Completion time: ${new Date().toLocaleString()}`);
      console.log('='.repeat(80));

      const summary = {
        status: 'completed',
        total_processed: processedCount,
        enriched: enrichedCount,
        failed: failedCount,
        skipped: skippedCount,
        scraped_businesses: businesses.length,
        performance: {
          total_duration: totalDuration,
          scraping_duration: scrapingDuration,
          enrichment_duration: enrichmentDuration,
          avg_enrichment_time: enrichmentDuration / processedCount,
          concurrency_used: concurrency,
          items_per_second: processedCount / totalDuration
        }
      };
      
      res.end(JSON.stringify(summary));
      
    } catch (error) {
      const errorDuration = (Date.now() - startTime) / 1000;
      console.error('\n' + '='.repeat(80));
      console.error('❌ PROCESSING FAILED');
      console.error('='.repeat(80));
      console.error(`💥 Error: ${error.message}`);
      console.error(`⏱️  Duration before failure: ${errorDuration}s`);
      console.error(`📊 Processed before failure: ${processedCount}/${maxProcess}`);
      console.error(`✅ Successful before failure: ${enrichedCount}`);
      console.error(`❌ Failed before failure: ${failedCount}`);
      console.error(`⏭️ Skipped before failure: ${skippedCount}`);
      console.error('='.repeat(80));
      
      res.end(JSON.stringify({ 
        status: 'failed', 
        error: error.message,
        processed: processedCount,
        enriched: enrichedCount,
        failed: failedCount,
        skipped: skippedCount,
        duration: errorDuration
      }));
    } finally {
      isProcessing = false;
      console.log('\n🔒 Processing flag reset. Ready for next request.\n');
    }
  });

  app.post('/cancel', (req, res) => {
    console.log('\n🛑 CANCELLATION REQUEST RECEIVED');
    console.log(`⏱️  Time: ${new Date().toLocaleString()}`);
    console.log(`📊 Was processing: ${isProcessing}`);
    
    if (isProcessing) {
      scrapeController.abort();
      isProcessing = false;
      console.log('✅ Processing cancelled successfully');
      console.log('🔒 Processing flag reset');
    } else {
      console.log('⚠️  No active processing to cancel');
    }
    
    res.json({ status: 'cancelled' });
  });

  app.get('/data', (req, res) => {
    const data = store.getAll();
    console.log(`📊 Data request: Returning ${data.length} records`);
    res.json(data);
  });

  // Debug endpoint to test individual business enrichment
  app.post('/debug-enrich', async (req, res) => {
    const { businessName, address, website } = req.body;
    
    console.log(`🔍 [DEBUG] Testing enrichment for: "${businessName}"`);
    console.log(`📍 [DEBUG] Address: ${address}`);
    console.log(`🌐 [DEBUG] Website: ${website || 'Not provided'}`);
    
    try {
      const result = await searchBusiness(businessName, address);
      console.log(`📋 [DEBUG] Enrichment result:`, JSON.stringify(result, null, 2));
      
      res.json({
        status: 'success',
        input: { businessName, address, website },
        result: result,
        summary: {
          found_owner: !!result.owner,
          found_email: !!result.email,
          found_phone: !!result.phone,
          found_website: !!result.website,
          data_sources: result.data_sources || {}
        }
      });
    } catch (error) {
      console.error(`❌ [DEBUG] Enrichment failed:`, error);
      res.status(500).json({
        status: 'error',
        error: error.message,
        input: { businessName, address, website }
      });
    }
  });

  app.get('/export', (req, res) => {
    const data = store.getAll();
    console.log(`📁 Export request: Exporting ${data.length} records to CSV`);
    exportCSV(res);
  });

  // Proxy status endpoint
  app.get('/proxy-status', (req, res) => {
    const { getProxyConfig } = require('./enrich');
    res.json(getProxyConfig());
  });

  const PORT = process.env.PORT;

  console.log('\n' + '='.repeat(80));
  console.log('🚀 SCRAPER & ENRICHMENT SERVER STARTING');
  console.log('='.repeat(80));
  console.log(`🌐 Server Configuration:`);
  console.log(`   📡 Port: ${PORT}`);
  console.log(`   🎯 Max Process: ${process.env.MAX_PROCESS || '500 (default)'}`);
  console.log(`   ⚡ Enrichment Concurrency: ${process.env.ENRICHMENT_CONCURRENCY || '8 (default)'}`);
  console.log(`   🔑 Apify Token: ${process.env.APIFY_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   🕐 Start Time: ${new Date().toLocaleString()}`);
  console.log(`   📊 Node Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(80));

  app.listen(PORT, () => {
    console.log(`✅ Server successfully started on PORT ${PORT}`);
    console.log(`🔗 Health Check: http://localhost:${PORT}/health`);
    console.log(`📊 API Endpoints:`);
    console.log(`   POST /start - Start scraping & enrichment`);
    console.log(`   POST /cancel - Cancel current processing`);
    console.log(`   GET /data - Get current data`);
    console.log(`   GET /export - Export data as CSV`);
    console.log(`   GET /health - Health check`);
    console.log(`   GET /proxy-status - Proxy status`);
    console.log('\n🎯 Ready to accept requests!\n');
  });