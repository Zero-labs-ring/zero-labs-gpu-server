const http = require('http');

async function testSearch(q) {
  const cleanQ = encodeURIComponent(q);
  const gnewsUrl = `https://news.google.com/rss/search?q=${cleanQ}&hl=en-US&gl=US&ceid=US:en`;
  console.log('Testing GNews RSS:', gnewsUrl);
  
  try {
    const res = await fetch(gnewsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9',
      }
    });
    console.log('Status:', res.status);
    const xml = await res.text();
    console.log('XML length:', xml.length);
    const items = xml.split('<item>').slice(1);
    console.log('Items found:', items.length);
    if (items.length > 0) {
      const titleMatch = items[0].match(/<title>([\s\S]*?)<\/title>/i);
      console.log('First item title:', titleMatch ? titleMatch[1] : 'No title');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

testSearch('latest AI model releases 2026');
