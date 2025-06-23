const { Parser } = require('json2csv');
const store = require('./store');

function exportCSV(res) {
  const data = store.getAll();

  const fields = [
    'id',
    'name',
    'address',
    'url',
    'owner',
    'email',
    'phone',
    'website',
    'verified',
    'category',
    'rating',
    'reviews_count',
    'enrichment_status',
    'error',
    // Data source debugging
    { label: 'google_business_data', value: 'data_sources.google_business' },
    { label: 'imprint_data', value: 'data_sources.imprint_extraction' },
    { label: 'direct_scrape_data', value: 'data_sources.direct_scraping' },
    { label: 'website_source', value: 'data_sources.website_source' },
    { label: 'website_discovered', value: 'data_sources.website_discovered' },
    'page',
    'pagePosition',
    'totalPosition'
  ];

  const parser = new Parser({ fields, defaultValue: '', delimiter: ',' });
  const csv = parser.parse(data);

  res.header('Content-Type', 'text/csv');
  res.attachment(`export-${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
}

module.exports = { exportCSV };
