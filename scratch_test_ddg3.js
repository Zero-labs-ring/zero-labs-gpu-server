async function testDDG3(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    }
  });
  const html = await res.text();
  const idx = html.indexOf('result__title');
  if (idx !== -1) {
    console.log('Found result__title at', idx);
    console.log(html.slice(idx, idx + 1000));
  } else {
    console.log('result__title not found, search results block:');
    const linksIdx = html.indexOf('links_main');
    if (linksIdx !== -1) console.log(html.slice(linksIdx, linksIdx + 1500));
  }
}

testDDG3('who is the CEO of Anthropic');
