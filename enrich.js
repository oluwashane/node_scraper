// enrich.js
const { ApifyClient } = require('apify-client');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

// Utility function to add timeout to promises
function withTimeout(promise, timeoutMs = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Retry wrapper with exponential backoff
async function withRetry(operation, maxRetries = 2, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`🔄 Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Simple web scraper for contact data
async function scrapeContactData(url, businessName) {
  console.log(`🕷️  [DIRECT_SCRAPE] Attempting direct scrape for "${businessName}" from: ${url}`);
  
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Common selectors for finding contact information
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const phoneRegex = /(?:\+49|0049|0)\s*(?:\(\d+\))?\s*[\d\s\-\/]{6,}/g;
    
    // Get all text content
    const bodyText = $('body').text();
    
    // Look for emails
    const emails = [...new Set(bodyText.match(emailRegex) || [])];
    
    // Look for phone numbers
    const phones = [...new Set(bodyText.match(phoneRegex) || [])];
    
    // Look for common contact sections
    const contactSelectors = [
      '[class*="contact"]', '[id*="contact"]',
      '[class*="impressum"]', '[id*="impressum"]',
      '[class*="imprint"]', '[id*="imprint"]',
      '.footer', '#footer'
    ];
    
    let contactInfo = '';
    contactSelectors.forEach(selector => {
      contactInfo += $(selector).text() + ' ';
    });
    
    // Extract owner/manager names (basic heuristic)
    const ownerPatterns = [
      /Geschäftsführer[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/g,
      /Inhaber[:\s]+([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)/g,
      /Owner[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
      /Director[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/g
    ];
    
    let owner = '';
    for (const pattern of ownerPatterns) {
      const matches = contactInfo.match(pattern);
      if (matches) {
        owner = matches[1];
        break;
      }
    }
    
    const result = {
      email: emails[0] || '',
      phone: phones[0] || '',
      owner: owner || ''
    };
    
    const foundItems = Object.entries(result).filter(([key, value]) => value);
    if (foundItems.length > 0) {
      console.log(`✅ [DIRECT_SCRAPE] Found contact data for "${businessName}":`);
      foundItems.forEach(([key, value]) => {
        console.log(`   ${key}: ${value}`);
      });
    } else {
      console.log(`❌ [DIRECT_SCRAPE] No contact data found for "${businessName}"`);
    }
    
    return result;
  } catch (error) {
    console.error(`❌ [DIRECT_SCRAPE] Error scraping "${businessName}":`, error.message);
    return {};
  }
}

async function getImprintFromWebsite(url, businessName) {
  if (!url) {
    console.log(`⚠️  [IMPRINT] Skipping imprint extraction for "${businessName}" - no website URL`);
    return {};
  }

  const startTime = Date.now();
  console.log(`🔍 [IMPRINT] Starting imprint extraction for "${businessName}" from: ${url}`);

  try {
    const operation = async () => {
      console.log(`📡 [IMPRINT] Calling Apify actor YpzZ4RnzljluUzBs1 for "${businessName}"`);
      
      const run = await apifyClient.actor("YpzZ4RnzljluUzBs1").call({
        start_urls: [{ url }],
        search_decision_makers: true,
        extract_emails: true,
        extract_phones: true,
        extract_contacts: true,
      });

      console.log(`📊 [IMPRINT] Actor run started for "${businessName}", run ID: ${run.id}`);

      const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems({
        limit: 5,
        clean: true,
      });

      if (!items?.length) {
        console.log(`❌ [IMPRINT] No imprint data found for "${businessName}"`);
        return {};
      }
      
      const imprintInfo = items[0];
      const duration = (Date.now() - startTime) / 1000;
      
      // Extract all available data from imprint
      const result = {
        owner: imprintInfo.primary_decision_maker || 
               imprintInfo.geschäftsfuehrer || 
               imprintInfo.inhaber || 
               imprintInfo.director || 
               imprintInfo.owner || '',
        email: imprintInfo.email || 
               imprintInfo.emails?.[0] || 
               imprintInfo.contact_email || '',
        phone: imprintInfo.phone || 
               imprintInfo.telefon || 
               imprintInfo.contact_phone || 
               imprintInfo.phones?.[0] || '',
        address: imprintInfo.address || 
                imprintInfo.anschrift || 
                imprintInfo.contact_address || '',
        company_name: imprintInfo.company_name || 
                     imprintInfo.firmenname || 
                     imprintInfo.name || ''
      };

      console.log(`📋 [IMPRINT] Raw imprint data for "${businessName}":`, JSON.stringify(imprintInfo, null, 2));
      
      const foundData = Object.entries(result).filter(([key, value]) => value && value.length > 0);
      if (foundData.length > 0) {
        console.log(`✅ [IMPRINT] Found imprint data for "${businessName}" (${duration}s):`);
        foundData.forEach(([key, value]) => {
          console.log(`   ${key}: ${value}`);
        });
      } else {
        console.log(`⚠️  [IMPRINT] No useful imprint data found for "${businessName}" (${duration}s)`);
      }
      
      return result;
    };

    return await withTimeout(withRetry(operation), 45000);
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    console.error(`❌ [IMPRINT] Error extracting imprint for "${businessName}" (${duration}s):`, err.message);
    return {};
  }
}

async function searchBusiness(businessName, address) {
  const startTime = Date.now();
  console.log(`\n🚀 [ENRICHMENT] Starting enrichment for: "${businessName}"`);
  console.log(`📍 [ENRICHMENT] Address: ${address}`);
  
  try {
    const operation = async () => {
      console.log(`📡 [SEARCH] Calling Apify Google Business actor for "${businessName}"`);
      
      const input = {
        searchStringsArray: [businessName],
        locationQuery: address,
        maxCrawledPlacesPerSearch: 15,
        language: 'en',
        skipClosedPlaces: false,
        scrapePlaceDetailPage: true,
        scrapeContacts: true,
        scrapeReviews: false,
        scrapePhotos: false,
      };

      const run = await apifyClient.actor("nwua9Gu5YrADL7ZDj").call(input, {
        waitSecs: 60,
      });

      console.log(`📊 [SEARCH] Google Business search started for "${businessName}", run ID: ${run.id}`);

      const datasetClient = apifyClient.dataset(run.defaultDatasetId);
      const { items } = await datasetClient.listItems({ limit: 20, clean: true });

      if (!items?.length) {
        const duration = (Date.now() - startTime) / 1000;
        console.log(`❌ [SEARCH] No Google Business results found for "${businessName}" (${duration}s)`);
        return { error: "No results found - try a more specific query" };
      }

      // Find the best match based on business name similarity
      const item = items.find(item => 
        item.title?.toLowerCase().includes(businessName.toLowerCase()) ||
        businessName.toLowerCase().includes(item.title?.toLowerCase())
      ) || items[0];

      const searchDuration = (Date.now() - startTime) / 1000;
      
      console.log(`📋 [SEARCH] Raw Google Business data for "${businessName}":`, JSON.stringify(item, null, 2));
      
      console.log(`✅ [SEARCH] Found Google Business data for "${businessName}" (${searchDuration}s):`);
      console.log(`   📧 Email: ${item.emails?.[0] || 'None'}`);
      console.log(`   📞 Phone: ${item.phone || 'None'}`);
      console.log(`   🌐 Website: ${item.website || 'None'}`);
      console.log(`   ✅ Verified: ${item.verified || false}`);
      console.log(`   📍 Address: ${item.address || 'None'}`);

      let website = item.website || '';

      // If no website found in Google Business, try to discover one
      if (!website) {
        console.log(`🔍 [ENRICHMENT] No website in Google Business for "${businessName}", attempting discovery...`);
        website = await discoverWebsite(businessName, address);
      }

      // Try multiple methods to get contact data
      let imprintData = {};
      let directScrapeData = {};
      
      if (website) {
        console.log(`🌐 [ENRICHMENT] Using website for "${businessName}": ${website}`);
        
        // First try Apify imprint extractor
        imprintData = await getImprintFromWebsite(website, businessName);
        
        // If we didn't get enough data, try direct scraping as fallback
        const hasContactInfo = imprintData.email || imprintData.phone || imprintData.owner;
        if (!hasContactInfo) {
          console.log(`🔄 [ENRICHMENT] Apify imprint didn't find contacts for "${businessName}", trying direct scraping...`);
          directScrapeData = await scrapeContactData(website, businessName);
        }
      } else {
        console.log(`❌ [ENRICHMENT] No website found for "${businessName}" - skipping website-based enrichment`);
      }

      const totalDuration = (Date.now() - startTime) / 1000;
      
      // Prioritize data sources: Direct scrape > Imprint > Google Business
      const result = {
        businessName: item.title || businessName,
        website: website, // Use 'website' for the scraped website
        phone: directScrapeData.phone || imprintData.phone || item.phone || '',
        email: directScrapeData.email || imprintData.email || item.emails?.[0] || '',
        address: imprintData.address || item.address || address,
        verified: item.verified || false,
        owner: directScrapeData.owner || imprintData.owner || '',
        url: item.url || '', // Original scraping URL
        // Additional fields that might be useful
        rating: item.rating || null,
        reviews_count: item.user_ratings_total || null,
        category: item.category || '',
        opening_hours: item.opening_hours?.weekday_text || [],
        // Debug info
        data_sources: {
          google_business: !!(item.phone || item.emails?.[0]),
          imprint_extraction: !!(imprintData.email || imprintData.phone || imprintData.owner),
          direct_scraping: !!(directScrapeData.email || directScrapeData.phone || directScrapeData.owner),
          website_source: item.website ? 'google_business' : (website ? 'discovered' : 'none'),
          website_discovered: !item.website && !!website
        }
      };

      console.log(`🎉 [ENRICHMENT] Completed enrichment for "${businessName}" (${totalDuration}s):`);
      console.log(`   👤 Owner: ${result.owner || 'Not found'}`);
      console.log(`   📧 Email: ${result.email || 'Not found'}`);
      console.log(`   📞 Phone: ${result.phone || 'Not found'}`);
      console.log(`   🌐 Website: ${result.website || 'Not found'}`);
      console.log(`   📊 Success: ${!result.error}`);
      
      return result;
    };

    return await withTimeout(withRetry(operation), 90000);
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    console.error(`❌ [ENRICHMENT] Failed to enrich "${businessName}" (${duration}s):`, err.message);
    return { error: err.message };
  }
}

function getProxyConfig() {
  return {
    status: 'active',
    timestamp: new Date().toISOString()
  };
}

// Website discovery service
async function discoverWebsite(businessName, address) {
  console.log(`🔍 [WEBSITE_DISCOVERY] Searching for website of "${businessName}"`);
  
  const cleanBusinessName = businessName.replace(/[^a-zA-ZäöüÄÖÜß\s]/g, '').trim();
  const cityMatch = address.match(/\b(\w+)(?:\s+\d+)?\s*,?\s*(?:\d{5})?\s*(?:Germany|Deutschland)?\s*$/i);
  const city = cityMatch ? cityMatch[1] : '';
  
  console.log(`🔍 [WEBSITE_DISCOVERY] Clean name: "${cleanBusinessName}", City: "${city}"`);

  // Method 1: Google Search using Apify
  try {
    const googleSearchResults = await searchGoogleForWebsite(cleanBusinessName, city);
    if (googleSearchResults) {
      console.log(`✅ [WEBSITE_DISCOVERY] Found website via Google Search: ${googleSearchResults}`);
      return googleSearchResults;
    }
  } catch (error) {
    console.log(`⚠️ [WEBSITE_DISCOVERY] Google search failed: ${error.message}`);
  }

  // Method 2: Domain guessing
  try {
    const guessedDomain = await guessDomain(cleanBusinessName);
    if (guessedDomain) {
      console.log(`✅ [WEBSITE_DISCOVERY] Found website via domain guessing: ${guessedDomain}`);
      return guessedDomain;
    }
  } catch (error) {
    console.log(`⚠️ [WEBSITE_DISCOVERY] Domain guessing failed: ${error.message}`);
  }

  console.log(`❌ [WEBSITE_DISCOVERY] No website found for "${businessName}"`);
  return null;
}

// Google search for business website
async function searchGoogleForWebsite(businessName, city) {
  console.log(`📡 [GOOGLE_SEARCH] Searching for "${businessName} ${city}"`);
  
  try {
    const searchQuery = `${businessName} ${city} website`;
    
    const run = await apifyClient.actor("lhotanok~google-search-results-scraper").call({
      queries: [searchQuery],
      maxResultsPerQuery: 10,
      languageCode: 'de',
      countryCode: 'DE'
    });

    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems({
      limit: 10,
      clean: true,
    });

    if (items && items.length > 0) {
      // Look for official websites (excluding directories, social media, etc.)
      for (const result of items) {
        const url = result.url || result.link;
        if (url && isLikelyOfficialWebsite(url, businessName)) {
          console.log(`🎯 [GOOGLE_SEARCH] Found potential official website: ${url}`);
          
          // Verify the website is accessible and relevant
          if (await verifyWebsite(url, businessName)) {
            return url;
          }
        }
      }
    }
  } catch (error) {
    console.log(`❌ [GOOGLE_SEARCH] Search failed: ${error.message}`);
  }
  
  return null;
}

// Domain guessing based on business name
async function guessDomain(businessName) {
  console.log(`🎲 [DOMAIN_GUESS] Trying domain patterns for "${businessName}"`);
  
  // Clean the business name for domain generation
  const cleanName = businessName
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => {
      const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
      return map[char] || char;
    })
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '');

  // Generate domain variations
  const domainPatterns = [
    `${cleanName}.de`,
    `${cleanName}.com`,
    `${cleanName}-berlin.de`,
    `${cleanName}-leipzig.de`,
    `${cleanName}-hamburg.de`,
    `${cleanName}-muenchen.de`,
    `www.${cleanName}.de`,
    `www.${cleanName}.com`
  ];

  // Also try with common prefixes/suffixes for salons/businesses
  if (businessName.toLowerCase().includes('salon') || businessName.toLowerCase().includes('studio')) {
    const nameWithoutType = cleanName.replace(/(salon|studio)/g, '');
    domainPatterns.push(
      `${nameWithoutType}.de`,
      `${nameWithoutType}.com`,
      `salon-${nameWithoutType}.de`,
      `studio-${nameWithoutType}.de`
    );
  }

  for (const domain of domainPatterns) {
    const url = `https://${domain}`;
    console.log(`🔍 [DOMAIN_GUESS] Trying: ${url}`);
    
    if (await verifyWebsite(url, businessName)) {
      return url;
    }
  }

  return null;
}

// Check if URL is likely an official business website
function isLikelyOfficialWebsite(url, businessName) {
  const excludePatterns = [
    'facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com',
    'google.com', 'bing.com', 'yahoo.com',
    'yelp.com', 'tripadvisor.com', 'booking.com',
    'gelbeseiten.de', 'branchenbuch.de', 'dasoertliche.de',
    'wikipedia.org', 'youtube.com'
  ];

  // Exclude known directories and social media
  if (excludePatterns.some(pattern => url.toLowerCase().includes(pattern))) {
    return false;
  }

  // Prefer URLs that contain the business name
  const businessWords = businessName.toLowerCase().split(/\s+/);
  const hasBusinessWord = businessWords.some(word => 
    word.length > 3 && url.toLowerCase().includes(word.replace(/[äöüß]/g, (char) => {
      const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
      return map[char] || char;
    }))
  );

  return hasBusinessWord || url.includes('.de') || url.includes('.com');
}

// Verify website is accessible and relevant
async function verifyWebsite(url, businessName) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.status === 200) {
      const $ = cheerio.load(response.data);
      const pageText = $('body').text().toLowerCase();
      
      // Check if page contains business name or related terms
      const businessWords = businessName.toLowerCase().split(/\s+/);
      const hasRelevantContent = businessWords.some(word => 
        word.length > 3 && pageText.includes(word.toLowerCase())
      );

      if (hasRelevantContent) {
        console.log(`✅ [WEBSITE_VERIFY] Verified website: ${url}`);
        return true;
      } else {
        console.log(`⚠️ [WEBSITE_VERIFY] Website exists but may not be relevant: ${url}`);
        return true; // Still return true as it's accessible
      }
    }
  } catch (error) {
    console.log(`❌ [WEBSITE_VERIFY] Cannot verify ${url}: ${error.message}`);
  }
  
  return false;
}

module.exports = { searchBusiness, getProxyConfig };
