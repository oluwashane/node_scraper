// enrich.js
const { ApifyClient } = require('apify-client');
require('dotenv').config();

const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });

async function getImprintFromWebsite(url) {
  if (!url) return {};

  try {
    const run = await apifyClient.actor("YpzZ4RnzljluUzBs1").call({
      start_urls: [{ url }],
      search_decision_makers: true,
    });

    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems({
      limit: 1,
      clean: true,
    });


    if (!items?.length) return {};

    const imprintInfo = items[0];

    return {
      owner: imprintInfo.primary_decision_maker || '',
    };

  } catch (err) {
    console.error("Imprint scraping error:", err);
    return {};
  }
}

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

    const run = await apifyClient.actor("nwua9Gu5YrADL7ZDj").call(input, {
      waitSecs: 60,
    });

    const datasetClient = apifyClient.dataset(run.defaultDatasetId);
    const { items } = await datasetClient.listItems({ limit: 20, clean: true });

    if (!items?.length) {
      return { error: "No results found - try a more specific query" };
    }

    const item = items[0];
    const url = item.website || '';

    const imprintData = await getImprintFromWebsite(url);

    return {
      businessName: item.title || '',
      url,
      phone: item.phone || '',
      email: item.emails?.[0] || '',
      address: item.address || '',
      ...imprintData,
    };

  } catch (err) {
    console.error("Apify Error:", err);
    return { error: err.message };
  }
}

module.exports = { searchBusiness };
