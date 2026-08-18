async function testDDG4(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    }
  });
  const html = await res.text();
  const results = [];
  
  const blocks = html.split('<div class="result results_links');
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const linkMatch = block.match(/href="([^"]+)"/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    
    if (titleMatch && linkMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      let rawLink = linkMatch[1];
      let cleanUrl = rawLink;
      if (rawLink.includes('uddg=')) {
        const match = rawLink.match(/uddg=([^&]+)/);
        if (match) cleanUrl = decodeURIComponent(match[1]);
      }
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (title && cleanUrl.startsWith('http')) {
        results.push({ title, url: cleanUrl, snippet });
      }
    }
  }
  console.log('Parsed DDG Results count:', results.length);
  console.log('Sample:', results.slice(0, 3));
}

testDDG4('who is the CEO of Anthropic');
