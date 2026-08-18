async function testDDG2(q) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    }
  });
  const html = await res.text();
  console.log('Sample HTML snippet:', html.slice(2000, 4000));
}

testDDG2('who is the CEO of Anthropic');
