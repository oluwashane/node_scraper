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
    'enrichment_status',
    'error'
  ];

  const parser = new Parser({ fields, defaultValue: '', delimiter: ',' });
  const csv = parser.parse(data);

  res.header('Content-Type', 'text/csv');
  res.attachment('export.csv');
  res.send(csv);
}

module.exports = { exportCSV };
