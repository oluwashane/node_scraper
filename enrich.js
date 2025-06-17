// enrich.js
const { ApifyClient } = require('apify-client');
require('dotenv').config();

const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

async function searchBusiness(businessName, address) {
  console.log('Searching for', businessName, address);
  try {
    const input = {
      searchStringsArray: [businessName],
      locationQuery: address,
      maxCrawledPlacesPerSearch: 10,
      language: 'en',
      skipClosedPlaces: false,
      scrapePlaceDetailPage: true,
      scrapeContacts: true,
    };

    console.log('Starting optimized search...');
    const run = await apifyClient.actor("nwua9Gu5YrADL7ZDj").call(input, {
      waitSecs: 60 // Add timeout for actor execution [1][2]
    });
    
    const datasetClient = apifyClient.dataset(run.defaultDatasetId);
    const { items } = await datasetClient.listItems({ 
      limit: 20, 
      clean: true 
    });

    if (!items?.length) {
      return { error: "No results found - try a more specific query" };
    }

    console.log('items', items)
    // Process and structure results
    const item = items[0];
    return {
      businessName: item.title || '',
      website:      item.website || '',
      phone:        item.phone || '',
      email:        item.emails?.[0] || '',
      address:      item.address || '',
    };
    
  } catch (err) {
    console.error("Apify Error:", err);
    return { error: err.message };
  }
}

module.exports = { searchBusiness };
