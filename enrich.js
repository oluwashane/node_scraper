// enrich.js
const { ApifyClient } = require('apify-client');
const OpenAI = require('openai');
require('dotenv').config();

const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function searchBusiness(businessName) {
  try {
    const input = {
      queries: [`${businessName} site:.de`],
      resultsPerPage: "10",
      maxItems: 5,
      languageCode: "de",
      proxy: { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL']
      },
      memoryMbytes: 512,
    };

    console.log('Starting optimized search...');
    const run = await apifyClient.actor("V8SFJw3gKgULelpok").call(input);
    const { items } = await apifyClient.dataset(run.defaultDatasetId)
      .listItems({ limit: 5, clean: true });

      console.log('checking', items)

    if (!items.length) {
      return { error: "No results found - try a more specific query" };
    }

    const organicData = items[0].organicResults.slice(0, 10).map(result => ({
      title: result.title || '',
      url: result.url || '',
      description: result.description || ''
    }));

    console.log('checking organic data', organicData)

    // Flexible extraction
    const raw = await extractWithOpenAI(businessName, organicData);
    const parsed = parseFlexible(raw);
    return { raw, parsed };
    
  } catch (err) {
    console.error("Error:", err);
    return { error: err.message };
  }
}

async function extractWithOpenAI(businessName, organicResults) {
  const combinedText = organicResults.map(r => 
    `Title: ${r.title}\nURL: ${r.url}\nDescription: ${r.description}`
  ).join('\n\n');

  const prompt = `
You’re an expert at spotting German Impressum details in scraps of text.
Here are some search-result snippets for “${businessName}”:

${combinedText}

Please scan them and output any data you can find under these headings:

  • Owner (Inhaber / Geschäftsführer)
  • Email
  • Phone
  • Address
  • Website

Under each heading, list every match you see (one per line).
If you don’t see anything for a heading, just write “– none found –” under it.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You find German business contact info in scraps of text." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 600
  });

  const text = response.choices[0].message.content;
  console.log("Raw extraction:\n", text);
  return text;
}

function parseFlexible(text) {
  const sections = {};
  // split on headings like "Owner:" or "Email:"
  const parts = text.split(/\n(?=[A-Za-z]+\s*\(?.*?\)?:)/);
  parts.forEach(block => {
    const lines = block.trim().split("\n");
    const headingLine = lines.shift();
    const key = headingLine
      .replace(/[:\s].*$/, "")           // take first word before colon
      .toLowerCase();
    const values = lines
      .map(l => l.replace(/^[-\s]*/, "").trim())
      .filter(l => l && !/none found/i.test(l));
    sections[key] = values.length ? values : [];
  });
  return sections;
}

// Export for use in server.js
module.exports = { searchBusiness };
