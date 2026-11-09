// Docs screenshots only: answers like the Supertext API, returning real German for the
// demo's sample article (other text is returned unchanged). Used by docs-screenshots.mjs.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { parse, TextNode } from 'node-html-parser';
const DE = {
  'Swiss chocolate, shipped worldwide': 'Schweizer Schokolade, weltweit geliefert',
  'How a small family business in Bern brings hand-made pralines to customers in 40 countries.': 'Wie ein kleiner Familienbetrieb in Bern handgemachte Pralinen zu Kundinnen und Kunden in 40 Ländern bringt.',
  'From Bern to the world': 'Von Bern in die Welt',
  'Every praline is made by hand in our workshop in ': 'Jede Praline wird in unserer Werkstatt in ',
  'Bern': 'Bern',
  '. Read more on ': ' von Hand gefertigt. Mehr dazu auf ',
  'our website': 'unserer Website',
  '.': '.',
  'Fresh ingredients from local farms': 'Frische Zutaten von Höfen aus der Region',
  'Climate-neutral delivery within 48 hours': 'Klimaneutrale Lieferung innert 48 Stunden',
  'Hand-made Swiss chocolate | Demo': 'Handgemachte Schweizer Schokolade | Demo',
  'Hand-made pralines from Bern, delivered fresh to 40 countries.': 'Handgemachte Pralinen aus Bern, frisch geliefert in 40 Länder.',
  'Our promise': 'Unser Versprechen',
  'The best chocolate I have ever tasted.': 'Die beste Schokolade, die ich je probiert habe.',
  'A happy customer': 'Eine zufriedene Kundin',
};
const LINES = {
  'We only use **fair-trade cocoa** and never add palm oil.': 'Wir verwenden ausschliesslich **Fairtrade-Kakao** und nie Palmöl.',
  '- No artificial flavours': '- Keine künstlichen Aromen',
  '- Recyclable packaging': '- Rezyklierbare Verpackung',
};
const files = new Map();
// MOCK_DELAY_MS: answer `translating` for that long after an upload (the demo movie shows the progress state).
const DELAY = Number(process.env.MOCK_DELAY_MS || 0); const uploaded = new Map();
const tr = (t) => DE[t] ?? DE[t.trim()] ?? t.split(/(\r?\n)/).map((l) => LINES[l] ?? l).join('');
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/v1/, '');
  const send = (s, b, t = 'application/json') => { res.writeHead(s, { 'Content-Type': t }); res.end(t === 'application/json' ? JSON.stringify(b) : b); };
  if (p === '/features') return send(200, {});
  // Stands in for the Commando Center too (SUPERTEXT_REPORT_URL=http://127.0.0.1:8765/report), so screenshots report nothing.
  if (req.method === 'POST' && p === '/report') { const c = []; for await (const x of req) c.push(x); console.log('report', Buffer.concat(c).toString('utf8')); return send(202, { ok: true }); }
  if (req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const form = await new Request('http://x', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
    const id = randomBytes(6).toString('hex'); files.set(id, await form.get('file').text()); uploaded.set(id, Date.now()); return send(200, { file_id: id });
  }
  const m = p.match(/file\/([a-f0-9]+)(\/status|\/translation)?$/); if (!m) return send(404, {});
  if (req.method === 'DELETE') return send(200, {});
  if (m[2] === '/status') return send(200, { status: Date.now() - (uploaded.get(m[1]) ?? 0) < DELAY ? 'translating' : 'done' });
  const root = parse(files.get(m[1]), { comment: false });
  const walk = (n) => { if (n instanceof TextNode) { if (n.rawText.trim()) n.rawText = tr(n.text).replace(/&/g,'&amp;').replace(/</g,'&lt;'); } else n.childNodes?.forEach(walk); };
  // plain-text segments arrive with <br>; translate each text node
  walk(root); send(200, root.toString(), 'text/html');
}).listen(Number(process.env.MOCK_PORT || 8765), function () { console.log(`mock-de on ${this.address().port}`); });
