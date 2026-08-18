async function testDDG(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  console.log('Testing DuckDuckGo HTML:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });
    console.log('Status:', res.status);
    const html = await res.text();
    console.log('HTML length:', html.length);
    
    // Parse result-title or result__snippet
    const titleRegex = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const matches = [...html.matchAll(titleRegex)];
    console.log('Results found:', matches.length);
    if (matches.length > 0) {
      console.log('First result:', matches[0][1].replace(/<[^>]+>/g, '').trim());
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

testDDG('who is the CEO of Anthropic');
